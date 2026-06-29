import { Codex as DefaultCodex } from '@openai/codex-sdk'

const TURN_SEPARATOR = '────────────\n'

function ensureTrailingNewline(text) {
  if (!text) return ''
  return text.endsWith('\n') ? text : `${text}\n`
}

function formatFileChanges(changes = []) {
  if (!Array.isArray(changes) || changes.length === 0) return ''
  const lines = changes.map((change) => `patch: ${change.kind || 'update'} ${change.path || ''}`.trimEnd())
  return ensureTrailingNewline(lines.join('\n'))
}

function formatCodexEventAsOutput(event) {
  if (!event || !event.type) return ''

  if (event.type === 'item.started') {
    if (event.item?.type === 'command_execution' && event.item.command) {
      return ensureTrailingNewline(`Running: ${event.item.command}`)
    }
    if (event.item?.type === 'file_change') {
      return formatFileChanges(event.item.changes)
    }
    return ''
  }

  if (event.type === 'item.completed') {
    if (event.item?.type === 'agent_message') {
      // Agent message text is streamed delta-by-delta via codexBroadcastStreamText
      // and recorded to scrollback on completion. Don't emit the full text again
      // as a live output block.
      return ''
    }
    if (event.item?.type === 'command_execution') {
      let text = ''
      if (event.item.aggregated_output) text += ensureTrailingNewline(event.item.aggregated_output)
      if (event.item.exit_code != null && event.item.exit_code !== 0) {
        text += ensureTrailingNewline(`exit ${event.item.exit_code}`)
      }
      return text
    }
    if (event.item?.type === 'file_change') {
      return formatFileChanges(event.item.changes)
    }
    return ''
  }

  if (event.type === 'turn.completed') {
    return TURN_SEPARATOR
  }

  if (event.type === 'turn.failed') {
    return `[Error: ${event.error?.message || 'Codex turn failed'}]\n${TURN_SEPARATOR}`
  }

  if (event.type === 'error') {
    return `[Error: ${event.message || 'Codex stream error'}]\n${TURN_SEPARATOR}`
  }

  return ''
}

function createCurrentTurnHandle(abortController) {
  const handle = {
    _nanocodeInterrupted: false,
    kill(signal = 'SIGINT') {
      handle._nanocodeInterrupted = true
      abortController.abort(new Error(signal === 'SIGKILL' ? 'force killed' : 'interrupted'))
    },
  }
  return handle
}

export function createCodexSdkDriver({
  store,
  codexBroadcast,
  codexBroadcastEvent,
  codexBroadcastStreamText = () => {},
  rerunTurn,
  CodexImpl = DefaultCodex,
  onTurnStart = null,
  onTurnEnd = null,
}) {
  async function runCodexTurn(cs, prompt, sessionKey, cwd) {
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : ''
    if (!trimmedPrompt) return

    if (cs.busy) {
      if (!Array.isArray(cs.queue)) cs.queue = []
      cs.queue.push(trimmedPrompt)
      codexBroadcast(cs, `[queued: Message queued (position ${cs.queue.length}). Will run after current turn.]\n`)
      return
    }

    cs.busy = true
    cs.currentProc = null
    cs.turnCount = (cs.turnCount || 0) + 1
    if (onTurnStart) try { onTurnStart(cs, sessionKey) } catch {}

    const codexModel = store.getSetting('codex_model') || ''
    const codexEffort = store.getSetting('codex_effort') || ''
    const sandboxMode = store.getSetting('codex_sandbox_mode') || 'danger-full-access'
    const pathOverride = store.getSetting('codex_path_override') || ''

    const codexOptions = {}
    if (pathOverride) codexOptions.codexPathOverride = pathOverride

    const threadOptions = {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      sandboxMode,
      networkAccessEnabled: true,
    }
    if (codexModel) threadOptions.model = codexModel
    if (codexEffort) threadOptions.modelReasoningEffort = codexEffort

    const client = new CodexImpl(codexOptions)
    const thread = cs.codexThreadId
      ? client.resumeThread(cs.codexThreadId, threadOptions)
      : client.startThread(threadOptions)

    const abortController = new AbortController()
    const currentTurn = createCurrentTurnHandle(abortController)
    cs.currentProc = currentTurn

    codexBroadcast(cs, `› ${trimmedPrompt}\n`)

    // Track the streaming text of each agent_message item so we can broadcast
    // only deltas to the frontend (avoiding the "whole paragraph appearing" effect).
    if (!cs.agentMessageTextById) cs.agentMessageTextById = new Map()

    let sawTerminalEvent = false
    let lastThreadId = cs.codexThreadId || null

    function broadcastAgentMessageDelta(itemId, newText) {
      const prev = cs.agentMessageTextById.get(itemId) || ''
      let delta
      if (newText.startsWith(prev)) {
        delta = newText.slice(prev.length)
      } else {
        // The model rewrote the prefix (rare); send the full replacement as one delta.
        delta = newText
      }
      if (delta) codexBroadcastStreamText(cs, { itemId, textDelta: delta })
      cs.agentMessageTextById.set(itemId, newText)
      return delta
    }

    try {
      const { events } = await thread.runStreamed(trimmedPrompt, { signal: abortController.signal })

      for await (const event of events) {
        codexBroadcastEvent(cs, event)

        if (event.type === 'thread.started' && event.thread_id) {
          lastThreadId = event.thread_id
          if (event.thread_id !== cs.codexThreadId) {
            cs.codexThreadId = event.thread_id
            const [projectId, , tabId] = sessionKey.split(':')
            store.updateTabMetadata?.(projectId, tabId, { codexThreadId: event.thread_id })
          }
        }

        if (event.type === 'item.started' && event.item?.type === 'agent_message' && event.item?.id) {
          cs.agentMessageTextById.set(event.item.id, '')
        }

        if (event.type === 'agent_message_content_delta' && event.item_id) {
          const delta = event.delta?.text || event.delta
          if (typeof delta === 'string' && delta) {
            const current = cs.agentMessageTextById.get(event.item_id) || ''
            const next = current + delta
            broadcastAgentMessageDelta(event.item_id, next)
          }
        }

        if (event.type === 'item.updated' && event.item?.type === 'agent_message' && event.item?.id) {
          const next = event.item.text || ''
          if (next) broadcastAgentMessageDelta(event.item.id, next)
        }

        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.id) {
          const itemId = event.item.id
          const finalText = event.item.text || ''
          // Ensure any trailing text not yet streamed is flushed to the frontend.
          const prev = cs.agentMessageTextById.get(itemId) || ''
          if (finalText.length > prev.length) {
            broadcastAgentMessageDelta(itemId, finalText)
          }
          // Record the full response in scrollback for history/replay, but do NOT
          // re-broadcast the entire agent_message text as a live output block.
          if (finalText) codexBroadcast(cs, ensureTrailingNewline(finalText), { historyOnly: true })
          cs.agentMessageTextById.delete(itemId)
        }

        const text = formatCodexEventAsOutput(event)
        if (text) codexBroadcast(cs, text)
        if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error') {
          sawTerminalEvent = true
        }
      }
    } catch (err) {
      const wasInterrupted = cs.currentProc?._nanocodeInterrupted === true || err?.name === 'AbortError'
      if (wasInterrupted) {
        codexBroadcast(cs, '[Request interrupted by user]\n')
        codexBroadcast(cs, TURN_SEPARATOR)
      } else {
        codexBroadcast(cs, `[Error: ${err?.message || String(err)}]\n`)
        codexBroadcast(cs, TURN_SEPARATOR)
      }
      sawTerminalEvent = true
    } finally {
      cs.busy = false
      cs.currentProc = null
      if (onTurnEnd) try { onTurnEnd(cs, sessionKey) } catch {}

      if (!cs.codexThreadId && lastThreadId) {
        cs.codexThreadId = lastThreadId
      }

      if (!Array.isArray(cs.queue)) cs.queue = []
      if (currentTurn._nanocodeInterrupted) {
        if (cs.queue.length > 0) {
          const discarded = cs.queue.length
          cs.queue = []
          codexBroadcast(cs, `[Queue cleared (${discarded} pending message${discarded > 1 ? 's' : ''} discarded after interrupt).]\n`)
        }
      } else if (cs.queue.length > 0) {
        const nextPrompt = cs.queue.shift()
        setImmediate(() => rerunTurn(cs, nextPrompt, sessionKey, cwd))
      } else if (!sawTerminalEvent) {
        codexBroadcast(cs, TURN_SEPARATOR)
      }
    }
  }

  return { runCodexTurn }
}

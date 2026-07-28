import { Codex as DefaultCodex } from '@openai/codex-sdk'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TURN_SEPARATOR = '────────────\n'

// When codex_path_override is unset, the SDK driver defaults to the user's
// locally-installed codex CLI (resilient to /usr package removal). This is the
// path the主人 reinstalled: ~/.local/lib/npm-global/bin/codex (0.144+, supports
// gpt-5.6-sol). If that file is missing too, we fall back to the SDK's bundled
// codex (0.137) and warn once per session — 0.137 can't run gpt-5.6-sol.
function userInstalledCodexPath(home) {
  return join(home || homedir(), '.local', 'lib', 'npm-global', 'bin', 'codex')
}

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
  home,
  onBundledCodexFallback = () => {},
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

    // Per-tab model override (root fix for cross-tab /model sync + codex /model
    // never reaching the SDK): cs.codexModelOverride is populated from the tab's
    // modelOverride at attach; the frontend /model picker writes the tab (not the
    // global codex_model setting) so sibling codex tabs keep their own model.
    const codexModel = cs.codexModelOverride || store.getSetting('codex_model') || ''
    // Per-tab reasoning-effort override (codex model picker step 2): same
    // root-fix pattern as codexModelOverride — the tab's effortOverride wins
    // over the global codex_effort setting so sibling codex tabs keep their own
    // effort. The SDK accepts minimal/low/medium/high/xhigh (ModelReasoningEffort).
    const codexEffort = cs.codexEffortOverride || store.getSetting('codex_effort') || ''
    const sandboxMode = store.getSetting('codex_sandbox_mode') || 'danger-full-access'
    const pathOverride = store.getSetting('codex_path_override') || ''

    // Resolve the codex binary the SDK will actually spawn:
    //   1. explicit codex_path_override (user-chosen) — always wins
    //   2. default to the user-installed CLI at ~/.local/lib/npm-global/bin/codex
    //      (0.144+, supports gpt-5.6-sol) — only if that file exists
    //   3. otherwise pass no override → SDK uses its bundled 0.137 codex, which
    //      can't run gpt-5.6-sol; warn once per session via the callback so the
    //      UI can surface "version too old".
    const userCodexPath = userInstalledCodexPath(home)
    const effectiveOverride = pathOverride || (existsSync(userCodexPath) ? userCodexPath : '')
    if (!pathOverride && !effectiveOverride && !cs._codexBundledFallbackWarned) {
      cs._codexBundledFallbackWarned = true
      onBundledCodexFallback(cs)
    }

    const codexOptions = {}
    if (effectiveOverride) codexOptions.codexPathOverride = effectiveOverride

    const threadOptions = {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      sandboxMode,
      networkAccessEnabled: true,
    }
    if (codexModel) threadOptions.model = codexModel
    if (codexEffort) threadOptions.modelReasoningEffort = codexEffort

    // Surface the resolved model + reasoning effort to the frontend as a
    // structured event so the codex session-info header (the "codex 头部") shows
    // what this turn is actually using. The SDK's own events don't carry the
    // model (thread.started only has thread_id), so without this the user can't
    // see which model/effort a codex turn used — a requirement of the model
    // picker (selection must be visibly effective on the next turn). The
    // renderer's _handleCodexEvent accumulates this into the session-info bar.
    codexBroadcastEvent(cs, {
      type: 'nanocode:session-info',
      model: codexModel || null,
      effort: codexEffort || null,
    })

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

      if (!cs.codexThreadId && lastThreadId) {
        cs.codexThreadId = lastThreadId
      }

      if (!Array.isArray(cs.queue)) cs.queue = []
      // On interrupt, AUTO-FLUSH queued messages as ONE combined turn (mirrors the
      // claude path, controller ~L933) instead of discarding them. Root fix for a
      // busy codex secretary silently dropping every queued message when the user
      // (or a "send now") interrupts the running turn: the queued messages are the
      // thing the user most wants delivered, not thrown away. Discard survives only
      // as an explicit opt-out (auto_flush_queue_on_interrupt='0'), and never for a
      // "send now" force-flush (cs._forceFlushQueue).
      const autoFlushOnInterrupt = store.getSetting('auto_flush_queue_on_interrupt') !== '0'
      const forceFlush = cs._forceFlushQueue === true
      cs._forceFlushQueue = false
      if (currentTurn._nanocodeInterrupted) {
        if (cs.queue.length > 0 && (forceFlush || autoFlushOnInterrupt)) {
          const allQueued = cs.queue.splice(0)
          const combinedText = allQueued.join('\n\n')
          if (!forceFlush) {
            codexBroadcast(cs, `[Resuming with ${allQueued.length} queued message${allQueued.length !== 1 ? 's' : ''} after interrupt…]\n`)
          }
          setImmediate(() => rerunTurn(cs, combinedText, sessionKey, cwd))
        } else if (cs.queue.length > 0) {
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

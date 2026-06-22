/**
 * Monitor plugin — browser side.
 *
 * Registers two client extension points:
 *   - ui.registerPanel('monitor', ...) renders the Fleet dashboard.
 *   - ui.registerSetting(...) renders the Linear API key input in settings.
 *
 * The panel subscribes to `plugin:monitor:update` notify-WS messages for
 * live refreshes and seeds itself from GET /api/monitor/snapshot on load.
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function truncate(s, n = 90) {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n) + '…' : str
}

function minutesAgo(iso) {
  if (!iso) return '—'
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return '—'
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}

export function register(ui) {
  // ── Settings slot for the Linear API key ───────────────────────────────────
  ui.registerSetting({
    id: 'monitor-settings',
    render(container) {
      container.innerHTML = `
        <div class="settings-subsection">
          <div class="settings-label-row"><span>Monitor (Fleet)</span></div>
          <div class="settings-field">
            <label class="settings-label">Linear API key</label>
            <input type="password" id="monitor-linear-key" class="settings-input" placeholder="lin_api_..." autocomplete="off" />
          </div>
          <div class="settings-actions">
            <button type="button" class="btn btn-primary" id="monitor-save-key">Save</button>
            <span class="settings-status" id="monitor-key-status"></span>
          </div>
          <p class="settings-hint-inline">Leave blank to show local health only.</p>
        </div>
      `

      const input = container.querySelector('#monitor-linear-key')
      const saveBtn = container.querySelector('#monitor-save-key')
      const status = container.querySelector('#monitor-key-status')

      async function init() {
        try {
          const settings = await ui.fetchSettings()
          if (input && settings.linear_api_key) input.value = settings.linear_api_key
        } catch {}
      }

      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          try {
            await ui.updateSetting('linear_api_key', input?.value?.trim() || '')
            if (status) status.textContent = 'Saved'
          } catch {
            if (status) status.textContent = 'Failed'
          }
        })
      }

      init()
    },
  })

  // ── Full Fleet panel ─────────────────────────────────────────────────────
  ui.registerPanel('monitor', {
    title: 'Fleet',
    render(container) {
      container.className = 'monitor-container'
      container.innerHTML = `
        <div class="monitor-header">
          <span class="monitor-title">Fleet Monitor</span>
          <span class="monitor-count" id="monitor-count"></span>
        </div>
        <div class="monitor-grid" id="monitor-grid"></div>

        <div class="monitor-section-divider"></div>
        <div class="monitor-section-label monitor-teams-label">Teams</div>
        <div class="monitor-teams" id="monitor-teams"></div>
      `

      const grid = container.querySelector('#monitor-grid')
      const teamsEl = container.querySelector('#monitor-teams')
      const countEl = container.querySelector('#monitor-count')

      function renderCard(lane) {
        const local = lane.local || {}
        const linear = lane.linear || {}
        const health = lane.health || { emoji: '⚪', level: 'unknown' }

        const commitText = local.lastCommitMin != null ? `${Math.round(local.lastCommitMin)}m` : '—'
        const milestoneText = linear.milestonePercent != null ? `${linear.milestonePercent}%` : '—'
        const rollupText = linear.rollupPercent != null ? `${linear.rollupPercent}%` : '—'
        const commentText = linear.latestComment
          ? `${linear.latestComment.author}: ${linear.latestComment.body}`
          : '—'

        const stateStyle = linear.stateColor
          ? `background:${linear.stateColor}22;color:${linear.stateColor}`
          : ''

        return `
          <div class="monitor-card health-${esc(health.level)}" data-lane="${esc(lane.key)}">
            <div class="monitor-card-header">
              <span class="monitor-key" title="${esc(lane.issue)}">${esc(lane.key)}</span>
              <span class="monitor-health" title="${esc((health.reasons || []).join(', '))}">${health.emoji}</span>
              <div class="monitor-actions">
                <button type="button" class="monitor-tmux-btn" data-target="${esc(lane.tmux)}" title="Focus tmux session">tmux</button>
                <button type="button" class="monitor-linear-btn" data-issue="${esc(lane.issue)}" title="Open Linear issue">Linear</button>
              </div>
            </div>
            <div class="monitor-issue-title">${esc(linear.title || lane.issue)}</div>
            <span class="monitor-state" style="${stateStyle}">${esc(linear.stateName || '—')}</span>

            <div class="monitor-milestone">
              <div class="monitor-section-label">Milestone ${esc(milestoneText)}</div>
              <div class="monitor-milestone-track">
                <div class="monitor-milestone-fill" style="width:${linear.milestonePercent ?? 0}%"></div>
              </div>
              <div class="monitor-milestone-label">rollup ${esc(rollupText)}</div>
            </div>

            <div class="monitor-local-grid">
              <span>branch: ${esc(local.branch || '—')}</span>
              <span>last commit: ${esc(commitText)}</span>
              <span>loop: ${local.tmuxAlive ? 'alive' : 'dead'}</span>
              <span>failcount: ${local.failcount ?? 0}</span>
              <span>flag: ${local.flagExists ? (local.flagAgeMin != null ? `${local.flagAgeMin}m` : 'yes') : 'no'}</span>
            </div>

            <div class="monitor-section-label">Latest comment</div>
            <div class="monitor-comment">${esc(truncate(commentText, 120))}</div>

            <div class="monitor-section-label">Last log</div>
            <div class="monitor-log" title="${esc(local.lastLog)}">${esc(truncate(local.lastLog, 120))}</div>
          </div>
        `
      }

      function renderLanes(lanes) {
        const list = Array.isArray(lanes) ? lanes : []
        if (countEl) countEl.textContent = `${list.length} lane${list.length === 1 ? '' : 's'}`
        if (!grid) return
        if (!list.length) {
          grid.innerHTML = '<div class="monitor-empty">No lanes configured.</div>'
          return
        }

        grid.innerHTML = list.map(renderCard).join('')

        grid.querySelectorAll('.monitor-tmux-btn').forEach((btn) => {
          btn.addEventListener('click', async () => {
            try {
              const res = await fetch('/api/monitor/tmux-focus', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target: btn.dataset.target }),
              })
              const data = await res.json()
              if (!data.ok) console.warn('[monitor] tmux focus failed:', data.error)
            } catch (err) {
              console.warn('[monitor] tmux focus error:', err)
            }
          })
        })

        grid.querySelectorAll('.monitor-linear-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            window.open(`https://linear.app/meshy/issue/${encodeURIComponent(btn.dataset.issue)}`, '_blank')
          })
        })
      }

      function renderTeam(team) {
        const configured = team.configured
        const rate = team.rateLimit || { emoji: '⚪', level: 'unknown', reason: '' }
        const stateClass = configured ? `health-${rate.level}` : 'health-unknown'
        const resetText = rate.resetAt
          ? `<div class="monitor-team-reset">reset ${esc(new Date(rate.resetAt).toLocaleTimeString())}</div>`
          : ''

        return `
          <div class="monitor-team-card ${stateClass}">
            <div class="monitor-team-header">
              <span class="monitor-team-name">${esc(team.name)}</span>
              <span class="monitor-team-health" title="${esc(rate.reason || '')}">${rate.emoji}</span>
            </div>
            <div class="monitor-team-meta">
              <span>instances: ${configured ? team.activeCount : '—'}</span>
              <span>last activity: ${configured ? minutesAgo(team.lastActivity) : '—'}</span>
            </div>
            <div class="monitor-team-what">${configured ? esc(team.what || 'idle') : 'Team2 未配置'}</div>
            ${resetText}
          </div>
        `
      }

      function renderTeams(teams) {
        const list = Array.isArray(teams) ? teams : []
        if (!teamsEl) return
        if (!list.length) {
          teamsEl.innerHTML = '<div class="monitor-empty">No teams configured.</div>'
          return
        }
        teamsEl.innerHTML = list.map(renderTeam).join('')
      }

      function renderData(data) {
        renderLanes(data?.lanes)
        renderTeams(data?.teams)
      }

      ui.onMessage((msg) => {
        if (msg?.type === 'plugin:monitor:update') renderData(msg)
      })

      // Seed the UI immediately so the panel is populated before the first WS
      // message arrives.
      fetch('/api/monitor/snapshot')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => renderData(data))
        .catch(() => renderData({ lanes: [], teams: [] }))
    },
  })
}

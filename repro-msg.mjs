import WebSocket from 'ws'
const BASE = 'http://127.0.0.1:9475'
const PROJECT = 'c34d8e19-42cd-4f7c-b669-4f8d0be88e33' // nanocode project

// 1. create a fresh claude tab
const r = await fetch(`${BASE}/api/projects/${PROJECT}/tabs`, {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ label: 'REPRO-DIAG', type: 'claude' }),
})
const tab = await r.json()
console.log('[repro] created tab', tab.id)

const ws = new WebSocket('ws://127.0.0.1:9475/ws/terminal')
let gotUserEcho = false, gotInit = false, gotResult = false, gotAssistant = false
const events = []
ws.on('open', () => {
  console.log('[repro] ws open -> attach')
  ws.send(JSON.stringify({ type:'attach', projectId: PROJECT, sessionType:'bash', tabId: tab.id, cols:80, rows:24 }))
  setTimeout(() => {
    console.log('[repro] sending claude-input')
    ws.send(JSON.stringify({ type:'claude-input', text:'Reply with exactly the single word PONG and nothing else.', _nonce:'diag1' }))
  }, 1500)
})
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw) } catch { return }
  if (m.type === 'claude-event') {
    const e = m.event || {}
    const tag = `${e.type}/${e.subtype||''}`
    if (e.type === 'user') gotUserEcho = true
    if (e.type === 'system' && e.subtype==='init') gotInit = true
    if (e.type === 'assistant') gotAssistant = true
    if (e.type === 'result') gotResult = true
    if (events.length < 40) events.push(tag)
  } else if (m.type !== 'pong') {
    events.push('WS:'+m.type)
  }
})
ws.on('error', e => console.log('[repro] ws error', e.message))
setTimeout(() => {
  console.log('[repro] === SUMMARY ===')
  console.log('userEcho=%s init=%s assistant=%s result=%s', gotUserEcho, gotInit, gotAssistant, gotResult)
  console.log('events:', events.join(' | '))
  // cleanup tab
  fetch(`${BASE}/api/projects/${PROJECT}/tabs/${tab.id}`, {method:'DELETE'}).finally(()=>process.exit(0))
}, 45000)

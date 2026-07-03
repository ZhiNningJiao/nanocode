import WebSocket from 'ws'
const PROJECT = 'd1ffad35-5204-4280-9f82-ccadf6e40fe0' // zhiningjiao
const TAB = process.argv[2] || '476d65c7'
const ws = new WebSocket('ws://127.0.0.1:9475/ws/terminal')
let counts = {}
const events = []
ws.on('open', () => {
  console.log('[repro] attach existing tab', TAB)
  ws.send(JSON.stringify({ type:'attach', projectId: PROJECT, sessionType:'bash', tabId: TAB, cols:80, rows:24 }))
  setTimeout(() => {
    console.log('[repro] sending claude-input to existing tab')
    ws.send(JSON.stringify({ type:'claude-input', text:'Diagnostic ping: reply with exactly the word ALIVE.', _nonce:'diagX' }))
  }, 2500)
})
let postSend = false
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw) } catch { return }
  if (m.type === 'claude-event') {
    const e = m.event || {}
    const tag = `${e.type}/${e.subtype||''}`
    counts[tag] = (counts[tag]||0)+1
    if (postSend && events.length < 30) events.push(tag + (e.subtype==='queued'?' <<QUEUED':'') + (e.subtype==='init'?' <<INIT':''))
  }
})
setTimeout(()=>{ postSend = true; console.log('[repro] (now tracking post-send events)') }, 2400)
ws.on('error', e => console.log('[repro] ws error', e.message))
setTimeout(() => {
  console.log('[repro] === SUMMARY existing tab', TAB, '===')
  console.log('post-send events:', events.join(' | ') || '(NONE — nothing came back after send!)')
  process.exit(0)
}, 40000)

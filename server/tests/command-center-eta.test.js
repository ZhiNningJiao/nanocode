import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTaskDeadline,
  shanghaiDeadlineIso,
  taskFamily,
  familyP50Minutes,
  estimateEta,
  addEstimatedEtas,
} from '../../tools/command-center/export-cars.mjs'

// MES-18517: 大事记甘特 ETA. One priority order — 最好 HH:MM 前交 > 硬顶 N 小时/分钟
// + dispatch start > same-family historical P50 > no eta (never a guess with
// zero signal). These tests exercise each step on its own, then the whole
// chain through addEstimatedEtas() with an injected (never-real-fs) doc reader.

describe('parseTaskDeadline', () => {
  it('reads an explicit "最好 HH:MM 前交" deadline', () => {
    assert.deepEqual(
      parseTaskDeadline('# TASK relvis_1300 — ...（Opus high；.58；硬顶 1.5 小时，最好 14:15 前交；Linear MES-18517）'),
      { preferHH: 14, preferMM: 15, hardcapMin: 90 },
    )
  })

  it('reads "最好 HH:MM 前出..." (not just 前交)', () => {
    const d = parseTaskDeadline('硬顶 4 小时，最好 14:30 前出能看的版本')
    assert.equal(d.preferHH, 14)
    assert.equal(d.preferMM, 30)
  })

  it('reads a bare "硬顶 N 小时" with no preferred clock time', () => {
    assert.deepEqual(parseTaskDeadline('硬顶 2 小时；只读核查'), { hardcapMin: 120 })
  })

  it('reads "硬顶 N 分钟" (minutes, not hours)', () => {
    assert.deepEqual(parseTaskDeadline('硬顶 40 分钟，最好 10:35 前交'), { preferHH: 10, preferMM: 35, hardcapMin: 40 })
  })

  it('reads a fractional hour cap', () => {
    assert.deepEqual(parseTaskDeadline('硬顶 2.5 小时'), { hardcapMin: 150 })
  })

  it('returns null with neither pattern', () => {
    assert.equal(parseTaskDeadline('# TASK foo_1200 — 随便做点什么（Sonnet high；.58）'), null)
  })

  it('returns null for non-string input', () => {
    assert.equal(parseTaskDeadline(null), null)
    assert.equal(parseTaskDeadline(undefined), null)
  })
})

describe('shanghaiDeadlineIso', () => {
  it('keeps the same calendar day when the deadline is still ahead', () => {
    // 2026-11-23 05:00Z = 13:00 Shanghai; a 14:15 deadline is later the same SH day.
    const iso = shanghaiDeadlineIso('2026-11-23T05:00:00.000Z', 14, 15)
    assert.equal(iso, '2026-11-23T06:15:00.000Z') // 14:15 SH == 06:15Z
  })

  it('rolls to the next day when HH:MM would land before the start', () => {
    // 2026-11-23 10:00Z = 18:00 Shanghai; "14:15" has already passed that SH day.
    const iso = shanghaiDeadlineIso('2026-11-23T10:00:00.000Z', 14, 15)
    assert.equal(iso, '2026-11-24T06:15:00.000Z')
  })

  it('returns null for an unparseable start', () => {
    assert.equal(shanghaiDeadlineIso('not-a-date', 1, 0), null)
  })
})

describe('taskFamily', () => {
  it('drops a trailing HHMM dispatch-time suffix', () => {
    assert.equal(taskFamily('iklimbbsp_1200'), 'iklimbbsp')
  })

  it('drops a trailing yyyy-mm-dd suffix', () => {
    assert.equal(taskFamily('paper_crawl_ai_2026-11-23'), 'paper_crawl_ai')
  })

  it('keeps sibling variants distinct (G1 vs G4 stay different families)', () => {
    assert.equal(taskFamily('nanogantt_G4_1745'), 'nanogantt_G4')
    assert.equal(taskFamily('nanogantt_G1_1745'), 'nanogantt_G1')
    assert.notEqual(taskFamily('nanogantt_G4_1745'), taskFamily('nanogantt_G1_1745'))
  })

  it('leaves a tag with no timestamp suffix unchanged', () => {
    assert.equal(taskFamily('eventbus_r1'), 'eventbus_r1')
  })
})

function bar({ car, start, end = null, endOpen = null }) {
  const b = { trace_id: car, car, start, end }
  if (endOpen != null) b.end_open = endOpen
  return b
}

describe('familyP50Minutes', () => {
  it('is null with zero closed samples in the family', () => {
    assert.equal(familyP50Minutes([bar({ car: 'x_0900', start: '2026-01-01T00:00:00Z', endOpen: true })], 'x', 'x_0900'), null)
  })

  it('medians an odd number of closed samples', () => {
    const bars = [
      bar({ car: 'x_0900', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:10:00Z' }), // 10 min
      bar({ car: 'x_1000', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:20:00Z' }), // 20 min
      bar({ car: 'x_1100', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:30:00Z' }), // 30 min
    ]
    assert.equal(familyP50Minutes(bars, 'x', 'x_1200'), 20)
  })

  it('medians an even number of closed samples (average of the middle two)', () => {
    const bars = [
      bar({ car: 'x_0900', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:10:00Z' }), // 10
      bar({ car: 'x_1000', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:20:00Z' }), // 20
    ]
    assert.equal(familyP50Minutes(bars, 'x', 'x_1200'), 15)
  })

  it('excludes the bar itself and other families', () => {
    const bars = [
      bar({ car: 'x_0900', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:10:00Z' }), // 10 min, same family
      bar({ car: 'x_1000', start: '2026-01-01T00:00:00Z', end: '2026-01-01T09:00:00Z' }), // itself — excluded
      bar({ car: 'y_0900', start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' }), // other family
    ]
    assert.equal(familyP50Minutes(bars, 'x', 'x_1000'), 10)
  })

  it('ignores still-open bars as samples', () => {
    const bars = [
      bar({ car: 'x_0900', start: '2026-01-01T00:00:00Z', end: null, endOpen: true }),
      bar({ car: 'x_1000', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:40:00Z' }),
    ]
    assert.equal(familyP50Minutes(bars, 'x', 'x_1200'), 40)
  })
})

describe('estimateEta', () => {
  const start = '2026-11-23T05:00:00.000Z' // 13:00 Shanghai

  it('prefers an explicit "最好 HH:MM" over a hard cap', () => {
    const eta = estimateEta(bar({ car: 'a_1300', start }), {
      taskTitle: '硬顶 3 小时，最好 14:15 前交',
      bars: [],
    })
    assert.equal(eta, '2026-11-23T06:15:00.000Z')
  })

  it('falls back to 硬顶 N 小时 + start when there is no preferred clock time', () => {
    const eta = estimateEta(bar({ car: 'a_1300', start }), { taskTitle: '硬顶 2 小时', bars: [] })
    assert.equal(eta, new Date(Date.parse(start) + 120 * 60_000).toISOString())
  })

  it('falls back to the family P50 when the task doc has neither pattern', () => {
    const bars = [
      bar({ car: 'a_1100', start: '2026-11-23T04:00:00.000Z', end: '2026-11-23T04:30:00.000Z' }), // 30 min
    ]
    const eta = estimateEta(bar({ car: 'a_1300', start }), { taskTitle: '随便做点什么', bars })
    assert.equal(eta, new Date(Date.parse(start) + 30 * 60_000).toISOString())
  })

  it('is null with no task title and no family history (never a guess)', () => {
    assert.equal(estimateEta(bar({ car: 'a_1300', start }), { taskTitle: null, bars: [] }), null)
  })

  it('is null when the bar has no parseable start', () => {
    assert.equal(estimateEta(bar({ car: 'a_1300', start: null }), { taskTitle: '硬顶 2 小时', bars: [] }), null)
  })
})

describe('addEstimatedEtas', () => {
  it('fills eta on an open bar from its task doc', async () => {
    const gantt = { schema: 'car-trace-gantt/v1', bars: [
      { trace_id: 't1', car: 'a_1300', start: '2026-11-23T05:00:00.000Z', end: null, end_open: true, links: { task: '/fake/TASK_a_1300.md' } },
    ] }
    await addEstimatedEtas(gantt, { readTaskTitle: async (p) => {
      assert.equal(p, '/fake/TASK_a_1300.md')
      return '# TASK a_1300 — demo（硬顶 1 小时，最好 06:00 前交）'
    } })
    // start = 05:00Z = 13:00 Shanghai; "06:00" Shanghai has already passed that
    // SH day, so it rolls to 06:00 Shanghai the next day = 2026-11-23T22:00Z.
    assert.equal(gantt.bars[0].eta, '2026-11-23T22:00:00.000Z')
  })

  it('never overwrites an eta the trace CLI already supplied', async () => {
    const gantt = { schema: 'car-trace-gantt/v1', bars: [
      { trace_id: 't1', car: 'a_1300', start: '2026-11-23T05:00:00.000Z', end: null, end_open: true, eta: '2026-11-23T09:00:00.000Z', links: { task: '/fake/TASK_a_1300.md' } },
    ] }
    await addEstimatedEtas(gantt, { readTaskTitle: async () => { throw new Error('must not be called') } })
    assert.equal(gantt.bars[0].eta, '2026-11-23T09:00:00.000Z')
  })

  it('never sets eta on a closed bar, even if its doc has a deadline', async () => {
    const gantt = { schema: 'car-trace-gantt/v1', bars: [
      { trace_id: 't1', car: 'a_1300', start: '2026-11-23T05:00:00.000Z', end: '2026-11-23T05:30:00.000Z', end_open: false, links: { task: '/fake/TASK_a_1300.md' } },
    ] }
    await addEstimatedEtas(gantt, { readTaskTitle: async () => { throw new Error('must not be called') } })
    assert.equal(gantt.bars[0].eta, undefined)
  })

  it('degrades a missing/unreadable task doc to the family-P50 step, without failing the export', async () => {
    const gantt = { schema: 'car-trace-gantt/v1', bars: [
      { trace_id: 't1', car: 'a_1300', start: '2026-11-23T05:00:00.000Z', end: '2026-11-23T05:30:00.000Z', end_open: false },
      { trace_id: 't2', car: 'a_1400', start: '2026-11-23T06:00:00.000Z', end: null, end_open: true, links: { task: '/no/such/file.md' } },
    ] }
    await addEstimatedEtas(gantt, { readTaskTitle: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } })
    assert.equal(gantt.bars[1].eta, new Date(Date.parse('2026-11-23T06:00:00.000Z') + 30 * 60_000).toISOString())
  })
})

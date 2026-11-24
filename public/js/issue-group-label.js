/**
 * Display name of a 【named】 grouping issue in the task tracker — the ONE
 * copy, used by the server (server/linear-lineage.js picks a car's sub-row)
 * and the browser (cockpit lane names) alike.
 *
 * The owner names every grouping issue with a leading 【…】 (「【IK】」,
 * 「【重定向质量（动作库 / retarget 精度 / 动画评测）】」); the name is the
 * text inside, minus a trailing （…） / (…) explanation. Not a named issue →
 * null (the caller then shows the plain title / key).
 */
export function groupLabel(title) {
  const m = /^\s*【([^】]+)】/.exec(String(title || ''))
  if (!m) return null
  const name = m[1].replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim()
  return name || m[1].trim()
}

/**
 * The real dispatch — only after planDispatch() came back clean. Order:
 *   1. (newIssue) create the child issue under the line's parent;
 *   2. create the car's workdir + tmp/;
 *   3. write the task book — exclusive create, plain file write (no shell,
 *      so nothing in it is ever expanded or executed);
 *   4. pool with a guard list (overage pool) → append the tag there first;
 *   5. run the existing dispatch script with the planned env + argv (argv
 *      array, no shell) — it stays the one place that launches cars;
 *   6. return the one-line summary for the ledger.
 * All side effects go through `io` so tests run it against fakes.
 *
 * io = { createIssue({ parentKey, teamKey, title, description }) → key,
 *        mkdir(path), writeNew(path, text), appendLine(path, line),
 *        run(argv, { env, cwd, timeoutSec }) → { code, stdout, stderr } }
 */

export async function executeDispatch(plan, io) {
  const steps = []
  let issue = plan.issue
  if (!issue) {
    issue = await io.createIssue({ parentKey: plan.lineParent, teamKey: plan.team, title: plan.newIssue.title, description: plan.newIssue.description || '' })
    steps.push(`建子单 ${issue}（父 ${plan.lineParent}）`)
  }
  const fill = (s) => String(s).split('<新建子单>').join(issue)
  const taskbook = fill(plan.taskbook)
  const env = Object.fromEntries(Object.entries(plan.env).map(([k, v]) => [k, fill(v)]))

  await io.mkdir(plan.paths.tmp)
  steps.push(`建工区 ${plan.paths.workdir}`)
  await io.writeNew(plan.paths.task, taskbook)
  steps.push(`写任务书 ${plan.paths.task}`)
  if (plan.guardTagsFile) {
    await io.appendLine(plan.guardTagsFile, plan.tag)
    steps.push(`登记超额守卫 ${plan.guardTagsFile}`)
  }
  const res = await io.run(plan.argv, { env, cwd: plan.cwd, timeoutSec: plan.timeoutSec })
  steps.push(`派车脚本退出码 ${res.code}`)
  const summary = fill(plan.summary).replace(/单 新建「[^」]*」/, `单 ${issue}`)
  return { ok: res.code === 0, issue, steps, summary, run: res }
}

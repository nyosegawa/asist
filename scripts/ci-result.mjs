/*
 * The verdict of CI's result job, the one check the main ruleset requires. It reads the job's needs context as JSON
 * from NEEDS and passes only when every job it needs succeeded or was skipped by its own if:. The results that fail
 * cannot be listed instead: on 2026-10-05, during an Actions outage, jobs that no hosted runner picked up were
 * reported as cancelled by the API but reached needs as neither failure nor cancelled, and a check for those two
 * let the pull request pass with none of its tests run.
 */

const needs = JSON.parse(process.env.NEEDS)
for (const [name, job] of Object.entries(needs)) console.log(`${name}: ${job.result}`)
const failed = Object.keys(needs).filter((name) => needs[name].result !== 'success' && needs[name].result !== 'skipped')
if (failed.length) {
  console.error(`These jobs neither succeeded nor were skipped: ${failed.join(', ')}`)
  process.exit(1)
}

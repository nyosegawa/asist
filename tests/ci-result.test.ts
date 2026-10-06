import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** Runs the verdict of CI's result job on a needs context of the given results, shaped as the job receives it. */
function verdict(results: Record<string, string>): { passed: boolean; stderr: string } {
  const needs = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { result, outputs: {} }]))
  const run = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/ci-result.mjs')], {
    env: { ...process.env, NEEDS: JSON.stringify(needs) },
    encoding: 'utf8',
    windowsHide: true
  })
  return { passed: run.status === 0, stderr: run.stderr }
}

describe('the verdict of the CI result job', () => {
  it('passes when every job succeeded or was skipped by its own condition', () => {
    expect(verdict({ changes: 'success', test: 'success', fit: 'skipped', website: 'success' }).passed).toBe(true)
  })

  // abandoned is what a job no hosted runner picked up can reach needs as, while the API calls it cancelled.
  it.each(['failure', 'cancelled', 'abandoned', ''])('fails and names the job when one ended as %j', (result) => {
    const { passed, stderr } = verdict({ changes: 'success', 'build-windows': result, fit: 'skipped', website: 'success' })
    expect(passed).toBe(false)
    expect(stderr).toContain('build-windows')
  })
})

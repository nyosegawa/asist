import { describe, expect, it } from 'vitest'
import type { JobLogLine } from '@shared/ipc'
import { createTranslator } from '@shared/i18n'
import { currentStep, describeToolInput, displayCommand, foldJobLog, rowText } from '@shared/job-log-view'

const t = createTranslator('ja-JP')
const at = (t: number, event: JobLogLine['event']): JobLogLine => ({ t, event })

describe('foldJobLog', () => {
  it('folds the start and the end of a command into one row whose status comes from the end', () => {
    const rows = foldJobLog([
      at(1, { kind: 'command', id: 'c1', command: 'ls', phase: 'start' }),
      at(2, { kind: 'assistant-text', text: '見ています' }),
      at(3, { kind: 'command', id: 'c1', command: 'ls', phase: 'done', ok: false, exitCode: 2 })
    ])
    expect(rows).toEqual([
      { kind: 'command', t: 3, command: 'ls', status: 'error', exitCode: 2 },
      { kind: 'assistant', t: 2, text: '見ています' }
    ])
  })

  it('still makes one row for a command whose start was missed and only whose end arrived', () => {
    const rows = foldJobLog([at(1, { kind: 'command', id: 'c9', command: 'pwd', phase: 'done', ok: true, exitCode: 0 })])
    expect(rows).toEqual([{ kind: 'command', t: 1, command: 'pwd', status: 'ok', exitCode: 0 }])
  })

  it('groups consecutive calls of the same tool and splits the group when another tool comes between', () => {
    const read = (p: string) => ({ kind: 'tool-use' as const, name: 'Read', input: JSON.stringify({ file_path: p }) })
    const rows = foldJobLog([
      at(1, read('/w/a.ts')),
      at(2, read('/w/b.ts')),
      at(3, { kind: 'tool-use', name: 'Grep', input: JSON.stringify({ pattern: 'foo', path: 'src' }) }),
      at(4, read('/w/c.ts'))
    ])
    expect(rows).toEqual([
      { kind: 'tool', t: 2, name: 'Read', detail: '/w/b.ts', count: 2 },
      { kind: 'tool', t: 3, name: 'Grep', detail: 'foo  src', count: 1 },
      { kind: 'tool', t: 4, name: 'Read', detail: '/w/c.ts', count: 1 }
    ])
  })

  it('shows init and raw as system text, and a result as its summary or as done or failed', () => {
    const rows = foldJobLog([
      at(1, { kind: 'init', model: 'codex', sessionId: 't1' }),
      at(2, { kind: 'raw', text: 'notice' }),
      at(3, { kind: 'stderr', text: 'warn' }),
      at(4, { kind: 'file-change', paths: ['/w/a.md'] }),
      at(5, { kind: 'result', ok: true, summary: '' }),
      at(6, { kind: 'result', ok: false, summary: '' })
    ])
    expect(rows.map((row) => rowText(row, t))).toEqual(['session ready · model: codex · session: t1', 'notice', 'warn', '✎ /w/a.md', t('jobs.log.done'), t('jobs.log.failed')])
  })
})

describe('describeToolInput', () => {
  it('shows the key argument for a well-known tool and the beginning of the input for an unknown one', () => {
    expect(describeToolInput('Read', JSON.stringify({ file_path: '/w/a.ts', limit: 20 }))).toBe('/w/a.ts')
    expect(describeToolInput('NotebookEdit', JSON.stringify({ notebook_path: '/w/n.ipynb' }))).toBe('/w/n.ipynb')
    expect(describeToolInput('WebFetch', JSON.stringify({ url: 'https://x.test', prompt: 'p' }))).toBe('https://x.test')
    expect(describeToolInput('WebSearch', JSON.stringify({ query: 'electron' }))).toBe('electron')
    expect(describeToolInput('Glob', JSON.stringify({ pattern: '**/*.ts' }))).toBe('**/*.ts')
    expect(describeToolInput('mcp__x__y', JSON.stringify({ a: 1 }))).toBe('{"a":1}')
    expect(describeToolInput('Unknown', 'a'.repeat(100))).toBe(`${'a'.repeat(80)}…`)
  })
})

describe('displayCommand', () => {
  it('strips the shell wrapper that codex adds and leaves an unwrapped command as it is', () => {
    expect(displayCommand("/bin/zsh -lc 'cat missing.txt'")).toBe('cat missing.txt')
    expect(displayCommand('/bin/zsh -lc ls')).toBe('ls')
    expect(displayCommand('/bin/bash -lc "echo hi"')).toBe('echo hi')
    expect(displayCommand('ls -la')).toBe('ls -la')
  })
})

describe('currentStep', () => {
  it('returns the last row when it is a running command or a tool call, and null after a reply or a result', () => {
    const running = foldJobLog([at(1, { kind: 'command', id: 'c', command: 'npm test', phase: 'start' })])
    expect(currentStep(running)).toMatchObject({ kind: 'command', status: 'running' })
    const tool = foldJobLog([at(1, { kind: 'tool-use', name: 'Read', input: '{}' })])
    expect(currentStep(tool)).toMatchObject({ kind: 'tool', name: 'Read' })
    const done = foldJobLog([at(1, { kind: 'command', id: 'c', command: 'npm test', phase: 'done', ok: true })])
    expect(currentStep(done)).toBeNull()
    expect(currentStep([])).toBeNull()
  })
})

describe('rowText, the text copied out of a row', () => {
  it('writes a tool as its name, count and key argument, and a command after a $ with the exit code when it failed', () => {
    expect(rowText({ kind: 'tool', t: 1, name: 'Read', detail: '/w/a', count: 3 }, t)).toBe('Read ×3 /w/a')
    expect(rowText({ kind: 'command', t: 1, command: 'ls', status: 'error', exitCode: 1 }, t)).toBe('$ ls (exit 1)')
    expect(rowText({ kind: 'command', t: 1, command: 'ls', status: 'ok' }, t)).toBe('$ ls')
  })

  // The same row goes to the clipboard in the language of the screen and to get_agent_job in the
  // language of the conversation, so the outcome of a run that reported nothing follows whichever
  // translator it is handed.
  it('words the outcome of a run that reported no summary in the language it is given', () => {
    const row = { kind: 'result', t: 1, ok: true, text: '' } as const
    expect(rowText(row, t)).toBe(t('jobs.log.done'))
    expect(rowText(row, createTranslator('en-US'))).toBe('Done')
    expect(rowText({ ...row, ok: false }, createTranslator('en-US'))).toBe('Failed')
  })
})

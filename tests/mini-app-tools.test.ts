import { describe, expect, it } from 'vitest'
import type { TurnEvent } from '@shared/ipc'
import { MINI_APPS, openMiniAppSchema, type MiniAppView } from '@shared/mini-apps'
import { ToolError } from '@shared/tool-registry'
import { describeOpenApp, miniAppTools, openAppNote, parseTarget } from '../src/main/services/brain/mini-app-tools'
import { openMiniApp, reportOpenMiniApp } from '../src/main/services/mini-app-view'

function run(name: string, input: Record<string, unknown> = {}): { result: unknown; events: TurnEvent[] } {
  const events: TurnEvent[] = []
  const tool = miniAppTools('en').find((def) => def.name === name)!
  const result = tool.run(input, { turnId: 7, signal: new AbortController().signal, emit: (event) => events.push(event) }, new AbortController().signal)
  return { result, events }
}

const views: MiniAppView[] = [
  { app: 'notes', noteId: 'note-1', editing: false },
  { app: 'tasks', view: 'board', taskId: 'task-1' },
  { app: 'mail', box: 'inbox', accountId: 'acct', query: 'invoice', pane: { kind: 'draft', id: 'draft-1' } },
  { app: 'calendar', view: 'week', date: '2026-09-22', eventId: 'event-1' },
  { app: 'jobs', jobId: 'job-1' },
  { app: 'memory', file: 'pages/tanaka.md' },
  { app: 'settings', page: 'integrations' }
]

describe('open_app', () => {
  it('asks the renderer to open the mini app at the place the fields name', () => {
    const { result, events } = run('open_app', { app: 'calendar', view: 'week', date: '2026-09-29', eventId: 'event-1' })
    expect(events).toEqual([{ type: 'app', turnId: 7, open: { app: 'calendar', view: 'week', date: '2026-09-29', eventId: 'event-1' } }])
    expect(result).toEqual({ opened: 'calendar' })
  })

  it('opens every mini app with no field at all', () => {
    for (const app of MINI_APPS) expect(parseTarget({ app })).toEqual({ app })
  })

  it('refuses a field of another mini app, a value outside its list, a malformed date and a message with a draft', () => {
    expect(() => parseTarget({ app: 'notes', taskId: 'task-1' })).toThrow(ToolError)
    expect(() => parseTarget({ app: 'tasks', view: 'week' })).toThrow(ToolError)
    expect(() => parseTarget({ app: 'mail', box: 'spam' })).toThrow(ToolError)
    expect(() => parseTarget({ app: 'settings', page: 'secrets' })).toThrow(ToolError)
    expect(() => parseTarget({ app: 'calendar', date: 'next monday' })).toThrow(ToolError)
    expect(() => parseTarget({ app: 'mail', messageId: 'm', draftId: 'd' })).toThrow(ToolError)
    expect(() => parseTarget({ app: 'browser' })).toThrow(ToolError)
  })

  it('sends nothing to the renderer when the input is refused', () => {
    expect(() => run('open_app', { app: 'notes', jobId: 'job-1' })).toThrow(ToolError)
  })
})

describe('close_app', () => {
  it('asks the renderer to close the open mini app', () => {
    expect(run('close_app').events).toEqual([{ type: 'app', turnId: 7, open: null }])
  })
})

describe('the open mini app', () => {
  it('names the id of what each mini app shows, so the model can pass it to that mini app\'s tools', () => {
    const shown = ['note-1', 'task-1', 'draft-1', 'event-1', 'job-1', 'pages/tanaka.md', 'integrations']
    views.forEach((view, index) => expect(describeOpenApp(view, 'en')).toContain(shown[index]))
    expect(describeOpenApp(views[3], 'en')).toContain('2026-09-22')
  })

  it('is what get_open_app returns after the renderer reports it, and nothing once it reports none', () => {
    reportOpenMiniApp(views[0])
    expect(run('get_open_app').result).toMatchObject({ open: views[0] })
    expect(openAppNote('en-US')).toContain('note-1')
    reportOpenMiniApp(null)
    expect(run('get_open_app').result).toEqual({ open: null })
    expect(openAppNote('en-US')).toBeNull()
  })

  it('refuses a report that does not describe a mini app, and keeps the last good one', () => {
    reportOpenMiniApp(views[1])
    expect(() => reportOpenMiniApp({ app: 'notes', noteId: 5 })).toThrow()
    expect(() => reportOpenMiniApp({ app: 'browser' })).toThrow()
    expect(openMiniApp()).toEqual(views[1])
  })

  it('accepts every view the renderer can report', () => {
    for (const view of views) expect(openMiniAppSchema.parse(view)).toEqual(view)
  })
})

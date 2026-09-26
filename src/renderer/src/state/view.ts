import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { dayKey } from '@shared/calendar-layout'
import { openMiniAppSchema, type MiniApp, type MiniAppTarget, type MiniAppView } from '@shared/mini-apps'

/**
 * Which mini app is open and what it shows. The state is the MiniAppView itself: the Dock, the cards'
 * open buttons and the conversation's open_app write it, the mini apps draw from it and write the
 * user's navigation back into it, and the report to main is read from it. A mini app that finds an id
 * it does not have writes back what it shows instead.
 */

export type MiniAppState<A extends MiniApp> = Extract<MiniAppView, { app: A }>
type MiniAppPatch<A extends MiniApp> = Partial<Omit<MiniAppState<A>, 'app'>>

/**
 * Where a target places a mini app. A field the target leaves out keeps what the open mini app shows,
 * or what the mini app shows by itself when it is not open yet. A calendar moved to another day or
 * view closes the event it showed, whose card would point at a chip no longer drawn, and a mail box
 * changed without a message or draft closes the pane.
 */
export function placeMiniApp(current: MiniAppView | null, target: MiniAppTarget, today = new Date()): MiniAppView {
  switch (target.app) {
    case 'notes': {
      const base = current?.app === 'notes' ? current : { app: 'notes' as const, noteId: null, editing: false }
      return target.noteId === undefined ? base : { app: 'notes', noteId: target.noteId, editing: false }
    }
    case 'tasks': {
      const base = current?.app === 'tasks' ? current : { app: 'tasks' as const, view: 'board' as const, taskId: null }
      return { app: 'tasks', view: target.view ?? base.view, taskId: target.taskId ?? base.taskId }
    }
    case 'mail': {
      const base = current?.app === 'mail' ? current : { app: 'mail' as const, box: 'inbox' as const, accountId: null, query: '', pane: null }
      const box = target.box ?? (target.draftId !== undefined ? 'drafts' : base.box)
      const pane =
        target.messageId !== undefined
          ? { kind: 'message' as const, id: target.messageId }
          : target.draftId !== undefined
            ? { kind: 'draft' as const, id: target.draftId }
            : box === base.box
              ? base.pane
              : null
      return { app: 'mail', box, accountId: base.accountId, query: base.query, pane }
    }
    case 'calendar': {
      const base = current?.app === 'calendar' ? current : { app: 'calendar' as const, view: 'month' as const, date: dayKey(today), eventId: null }
      const view = target.view ?? base.view
      const date = target.date ?? base.date
      const eventId = target.eventId ?? (view === base.view && date === base.date ? base.eventId : null)
      return { app: 'calendar', view, date, eventId }
    }
    case 'jobs': {
      const base = current?.app === 'jobs' ? current : { app: 'jobs' as const, jobId: null }
      return { app: 'jobs', jobId: target.jobId ?? base.jobId }
    }
    case 'memory': {
      const base = current?.app === 'memory' ? current : { app: 'memory' as const, file: null }
      return { app: 'memory', file: target.file ?? base.file }
    }
    case 'settings': {
      const base = current?.app === 'settings' ? current : { app: 'settings' as const, page: 'conversation' as const }
      return { app: 'settings', page: target.page ?? base.page }
    }
  }
}

/** Asks the open mini app whether what it shows may change, and resolves true when it may. */
type LeaveGuard = () => Promise<boolean>

/** Two views compare by their parsed form, which puts the keys in the schema's order. */
const viewKey = (open: MiniAppView | null): string => JSON.stringify(openMiniAppSchema.parse(open))

interface ViewState {
  open: MiniAppView | null
  /**
   * Set by the open mini app while it holds a draft that is not saved (useLeaveGuard). openApp, toggleApp
   * and closeApp, which the Dock, the back buttons, the cards and open_app use, ask it before they close
   * the mini app or change what it shows, and leave everything as it is when it answers false. The mini
   * app's own navigation goes through update, which does not ask.
   */
  leaveGuard: LeaveGuard | null
  openApp: (target: MiniAppTarget) => void
  /** Opens the mini app, or closes it when it is the one open, as a button of the Dock does. */
  toggleApp: (app: MiniApp) => void
  closeApp: () => void
  /**
   * Changes what the open mini app shows. A patch for a mini app that is not open is dropped, because
   * a view keeps running its effects through its leave animation and must not open itself again. A
   * patch that changes nothing leaves the state as it is, so that the views do not draw again.
   */
  update: <A extends MiniApp>(app: A, patch: MiniAppPatch<A>) => void
}

/** Only one mini app is open at a time. */
export const useViewStore = create<ViewState>((set, get) => {
  /** Shows what `next` makes of the open mini app, once its leave guard agrees when there is one to ask. */
  const navigate = (next: (open: MiniAppView | null) => MiniAppView | null): void => {
    const { open, leaveGuard } = get()
    if (!leaveGuard || viewKey(next(open)) === viewKey(open)) {
      set((s) => ({ open: next(s.open) }))
      return
    }
    leaveGuard().then(
      (approved) => approved && set((s) => ({ open: next(s.open) })),
      // The guard asks through the confirmation sheet, which refuses while another confirmation is on it;
      // the mini app then stays as it is.
      (error: unknown) => console.error('mini app leave guard failed:', error)
    )
  }
  return {
    open: null,
    leaveGuard: null,
    openApp: (target) => navigate((open) => placeMiniApp(open, target)),
    toggleApp: (app) => navigate((open) => (open?.app === app ? null : placeMiniApp(null, { app } as MiniAppTarget))),
    closeApp: () => navigate(() => null),
    update: (app, patch) =>
      set((s) => {
        const open = s.open
        if (open?.app !== app) return s
        const changed = Object.entries(patch).some(([key, value]) => !Object.is(open[key as keyof typeof open], value))
        return changed ? { open: { ...open, ...patch } as MiniAppView } : s
      })
  }
})

export const activeMiniApp = (s: ViewState): MiniApp | null => s.open?.app ?? null

/**
 * Makes `guard` the leave guard of the open mini app while `active` is true, as it is while a draft is
 * not saved, and takes it away when the draft is saved or thrown away or the view leaves the screen.
 */
export function useLeaveGuard(active: boolean, guard: LeaveGuard): void {
  const latest = useRef(guard)
  latest.current = guard
  useEffect(() => {
    if (!active) return
    const ask: LeaveGuard = () => latest.current()
    useViewStore.setState({ leaveGuard: ask })
    return () => {
      if (useViewStore.getState().leaveGuard === ask) useViewStore.setState({ leaveGuard: null })
    }
  }, [active])
}

/**
 * What the mini app shows. App keeps a closing view mounted through its leave animation, after the
 * store has closed it or opened another, so the view goes on drawing what it showed last.
 */
export function useMiniApp<A extends MiniApp>(app: A): MiniAppState<A> {
  const state = useViewStore((s) => (s.open?.app === app ? (s.open as MiniAppState<A>) : null))
  const last = useRef<MiniAppState<A> | null>(null)
  if (state) last.current = state
  last.current ??= placeMiniApp(null, { app } as MiniAppTarget) as MiniAppState<A>
  return last.current
}

/**
 * Reports the open mini app to main now and again each time what it shows changes. The value is
 * parsed first, which also puts the keys in the schema's order so that equal views compare equal.
 */
export function startMiniAppReports(): () => void {
  let last: string | undefined
  const send = (open: MiniAppView | null): void => {
    const view = openMiniAppSchema.parse(open)
    const key = JSON.stringify(view)
    if (key === last) return
    last = key
    window.api.reportMiniAppView(view).catch((error: unknown) => console.error('mini app report failed:', error))
  }
  send(useViewStore.getState().open)
  return useViewStore.subscribe((s) => send(s.open))
}

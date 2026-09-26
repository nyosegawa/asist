import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import {
  openMiniAppSchema,
  placeMiniApp,
  sameMiniAppView,
  type MiniApp,
  type MiniAppTarget,
  type MiniAppView
} from '@shared/mini-apps'

/**
 * Which mini app is open and what it shows. The state is the MiniAppView itself: the Dock, the cards'
 * open buttons and the conversation's open_app write it, the mini apps draw from it and write the
 * user's navigation back into it, and the report to main is read from it. A mini app that finds an id
 * it does not have writes back what it shows instead.
 */

export type MiniAppState<A extends MiniApp> = Extract<MiniAppView, { app: A }>
type MiniAppPatch<A extends MiniApp> = Partial<Omit<MiniAppState<A>, 'app'>>

/** Asks the open mini app whether what it shows may change, and resolves true when it may. */
type LeaveGuard = () => Promise<boolean>

interface ViewState {
  open: MiniAppView | null
  /**
   * Set by the open mini app while it holds a draft that is not saved (useLeaveGuard). openApp, toggleApp
   * and closeApp, which the Dock, the back buttons, the cards and open_app use, ask it before they close
   * the mini app or change what it shows, and leave everything as it is when it answers false. The mini
   * app's own navigation goes through update, which does not ask.
   */
  leaveGuard: LeaveGuard | null
  /**
   * The three resolve once the change is made or turned down; without a guard to ask, the change is made
   * before they return. They reject when the guard cannot ask, which leaves the mini app as it is.
   */
  openApp: (target: MiniAppTarget) => Promise<void>
  /** Opens the mini app, or closes it when it is the one open, as a button of the Dock does. */
  toggleApp: (app: MiniApp) => Promise<void>
  closeApp: () => Promise<void>
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
  const navigate = async (next: (open: MiniAppView | null) => MiniAppView | null): Promise<void> => {
    const { open, leaveGuard } = get()
    if (leaveGuard && !sameMiniAppView(next(open), open) && !(await leaveGuard())) return
    set((s) => ({ open: next(s.open) }))
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

/**
 * Reports the open mini app to main even when it has not changed. open_app and close_app in main wait for
 * the report that follows their request, and a request the user turns down to keep a draft changes nothing
 * that would be reported otherwise.
 */
export function reportMiniAppAnswer(): void {
  window.api
    .reportMiniAppView(openMiniAppSchema.parse(useViewStore.getState().open))
    .catch((error: unknown) => console.error('mini app report failed:', error))
}

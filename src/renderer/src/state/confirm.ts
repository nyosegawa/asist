import { create } from 'zustand'
import type { ConfirmRequest } from '@shared/confirm'

/**
 * The confirmation on screen, whoever asked for it. Main asks before a mail or calendar operation and
 * waits for the answer over IPC; a screen asks before a delete or a discard the user pressed and waits
 * for the answer itself. Both are drawn by the same ConfirmSheet, and only one is open at a time.
 */

/** A confirmation a screen asks for. It has no title, because the user has just pressed the button it is about. */
export type LocalConfirmRequest = Omit<ConfirmRequest, 'id' | 'title' | 'detail'> & { detail?: string }

/** A request from main is answered over IPC; one from a screen carries `resolve` and is answered to the waiting caller. */
export type ShownConfirm =
  | (ConfirmRequest & { resolve?: undefined })
  | (LocalConfirmRequest & { id: string; title?: undefined; resolve: (approved: boolean) => void })

interface ConfirmState {
  request: ShownConfirm | null
  open: (request: ConfirmRequest) => void
  /** Resolves true when the user confirms, and false on cancel or when main's request takes the screen. */
  ask: (request: LocalConfirmRequest) => Promise<boolean>
  close: (id: string) => void
}

let nextLocalConfirm = 1

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  open: (request) => {
    // Main's approval gate cannot wait behind a delete the user is still deciding on, so the delete
    // counts as cancelled.
    get().request?.resolve?.(false)
    set({ request })
  },
  ask: (request) => {
    if (get().request) return Promise.reject(new Error('A confirmation is already open'))
    return new Promise((resolve) => set({ request: { ...request, id: `local-${nextLocalConfirm++}`, resolve } }))
  },
  close: (id) => set((s) => (s.request?.id === id ? { request: null } : {}))
}))

/** Asks the user through the confirmation sheet, for use outside React components as well. */
export const askConfirm = (request: LocalConfirmRequest): Promise<boolean> => useConfirmStore.getState().ask(request)

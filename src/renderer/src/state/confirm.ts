import { create } from 'zustand'
import type { ConfirmRequest } from '@shared/confirm'
import { errorText } from '@shared/i18n/error-text'

/**
 * The confirmations for the user, whoever asked for them. Main asks before a mail or calendar operation
 * or an agent job and waits for the answer over IPC, and it can wait for several at once; a screen asks
 * before a delete or a discard the user pressed and waits for the answer itself. Both are drawn by the
 * same ConfirmSheet, one at a time, and a request from main that arrives while another is on screen
 * waits its turn.
 */

/** A confirmation a screen asks for. It has no title, because the user has just pressed the button it is about. */
export type LocalConfirmRequest = Omit<ConfirmRequest, 'id' | 'title' | 'detail'> & { detail?: string }

/** A request from main is answered over IPC; one from a screen carries `resolve` and is answered to the waiting caller. */
export type ShownConfirm =
  | (ConfirmRequest & { resolve?: undefined })
  | (LocalConfirmRequest & { id: string; title?: undefined; resolve: (approved: boolean) => void })

interface ConfirmState {
  /** The confirmation on screen. */
  request: ShownConfirm | null
  /** Requests from main that arrived while another one was on screen, oldest first. */
  waiting: ConfirmRequest[]
  open: (request: ConfirmRequest) => void
  /**
   * Resolves true when the user confirms, and false on cancel or when main's request takes the screen.
   * It rejects while another confirmation is on screen.
   */
  ask: (request: LocalConfirmRequest) => Promise<boolean>
  /** Takes a request away, whether it is on screen or waiting, and puts the oldest waiting one on screen. */
  close: (id: string) => void
}

let nextLocalConfirm = 1

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  waiting: [],
  open: (request) => {
    const shown = get().request
    // Main's approval gate cannot wait behind a delete the user is still deciding on, so the delete
    // counts as cancelled. Another request from main stays on screen instead, because replacing it
    // would change the sheet under the button the user may be pressing.
    if (shown && !shown.resolve) {
      set((s) => ({ waiting: [...s.waiting, request] }))
      return
    }
    shown?.resolve(false)
    set({ request })
  },
  ask: (request) => {
    if (get().request) return Promise.reject(new Error(errorText('confirm.alreadyOpen')))
    return new Promise((resolve) => set({ request: { ...request, id: `local-${nextLocalConfirm++}`, resolve } }))
  },
  close: (id) =>
    set((s) => {
      if (s.request?.id !== id) return { waiting: s.waiting.filter((waiting) => waiting.id !== id) }
      const [next = null, ...rest] = s.waiting
      return { request: next, waiting: rest }
    })
}))

/** Asks the user through the confirmation sheet, for use outside React components as well. */
export const askConfirm = (request: LocalConfirmRequest): Promise<boolean> => useConfirmStore.getState().ask(request)

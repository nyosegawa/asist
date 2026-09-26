import { create } from 'zustand'
import type { ConfirmRequest } from '@shared/confirm'
import { errorText } from '@shared/i18n/error-text'

/**
 * The confirmations waiting for the user, whoever asked for them. Main asks before a mail or calendar
 * operation or an agent job and waits for the answer over IPC, and it can wait for several at once; a
 * screen asks before a delete or a discard the user pressed and waits for the answer itself. Both are
 * drawn by the same ConfirmSheet, one at a time: the first in the queue is on screen, and a request
 * from main that arrives meanwhile joins the end.
 */

/** A confirmation a screen asks for. It has no title, because the user has just pressed the button it is about. */
export type LocalConfirmRequest = Omit<ConfirmRequest, 'id' | 'title' | 'detail' | 'holdsConversation'> & { detail?: string }

/** A request from main is answered over IPC; one from a screen carries `resolve` and is answered to the waiting caller. */
export type ShownConfirm =
  | (ConfirmRequest & { resolve?: undefined })
  | (LocalConfirmRequest & { id: string; title?: undefined; holdsConversation?: undefined; resolve: (approved: boolean) => void })

interface ConfirmState {
  /** Oldest first; the first is on screen. A request from a screen is only ever alone in it. */
  queue: ShownConfirm[]
  /** Queues a request from main. One already queued, which a reloaded page can hear of twice, stays as it is. */
  open: (request: ConfirmRequest) => void
  /**
   * Resolves true when the user confirms, and false on cancel or when main's request takes the screen.
   * It rejects while another confirmation is on screen.
   */
  ask: (request: LocalConfirmRequest) => Promise<boolean>
  /** Takes a request out of the queue, whether it is on screen or waiting. */
  close: (id: string) => void
}

let nextLocalConfirm = 1

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  queue: [],
  open: (request) => {
    if (get().queue.some((queued) => queued.id === request.id)) return
    const [shown] = get().queue
    // Main's approval gate cannot wait behind a delete the user is still deciding on, so the delete
    // counts as cancelled. A request from main on screen stays instead, because replacing it would
    // change the sheet under the button the user may be pressing.
    if (shown?.resolve) {
      shown.resolve(false)
      set({ queue: [request] })
    } else {
      set((s) => ({ queue: [...s.queue, request] }))
    }
  },
  ask: (request) => {
    if (get().queue.length > 0) return Promise.reject(new Error(errorText('confirm.alreadyOpen')))
    return new Promise((resolve) => set({ queue: [{ ...request, id: `local-${nextLocalConfirm++}`, resolve }] }))
  },
  close: (id) => set((s) => ({ queue: s.queue.filter((request) => request.id !== id) }))
}))

/** Asks the user through the confirmation sheet, for use outside React components as well. */
export const askConfirm = (request: LocalConfirmRequest): Promise<boolean> => useConfirmStore.getState().ask(request)

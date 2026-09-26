import { create } from 'zustand'
import type { ConfirmRequest } from '@shared/confirm'

/**
 * The confirmations waiting for the user, whoever asked for them. Main asks before a mail or calendar
 * operation or an agent job and waits for the answer over IPC, and it can wait for several at once; a
 * screen asks before a delete or a discard the user pressed and waits for the answer itself. Both are
 * drawn by the same ConfirmSheet, one at a time: the first in the queue is on screen, and a request
 * that arrives meanwhile waits for its turn.
 */

/** A confirmation a screen asks for. It has no title, because the user has just pressed the button it is about. */
export type LocalConfirmRequest = Omit<ConfirmRequest, 'id' | 'title' | 'detail'> & { detail?: string }

/** A request from main is answered over IPC; one from a screen carries `resolve` and is answered to the waiting caller. */
export type ShownConfirm =
  | (ConfirmRequest & { resolve?: undefined })
  | (LocalConfirmRequest & { id: string; title?: undefined; resolve: (approved: boolean) => void })

interface ConfirmState {
  /** Main's requests, then the screens' questions, each oldest first; the first is on screen. */
  queue: ShownConfirm[]
  open: (request: ConfirmRequest) => void
  /** Resolves true when the user confirms, and false on cancel or when main's request takes the screen from it. */
  ask: (request: LocalConfirmRequest) => Promise<boolean>
  /** Takes a request out of the queue, whether it is on screen or waiting. */
  close: (id: string) => void
}

let nextLocalConfirm = 1

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  queue: [],
  open: (request) => {
    const [shown, ...waiting] = get().queue
    // Main's approval gate gives up after a few minutes and cannot wait behind a delete the user is
    // still deciding on, so the delete counts as cancelled and main's request goes ahead of the
    // questions still waiting. A request from main on screen stays, because replacing it would change
    // the sheet under the button the user may be pressing.
    shown?.resolve?.(false)
    const kept = shown?.resolve ? waiting : get().queue
    set({ queue: [...kept.filter((item) => !item.resolve), request, ...kept.filter((item) => item.resolve)] })
  },
  ask: (request) =>
    new Promise((resolve) => set((s) => ({ queue: [...s.queue, { ...request, id: `local-${nextLocalConfirm++}`, resolve }] }))),
  close: (id) => set((s) => ({ queue: s.queue.filter((request) => request.id !== id) }))
}))

/** Asks the user through the confirmation sheet, for use outside React components as well. */
export const askConfirm = (request: LocalConfirmRequest): Promise<boolean> => useConfirmStore.getState().ask(request)

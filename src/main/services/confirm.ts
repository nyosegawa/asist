import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import mitt from 'mitt'
import type { ConfirmEvent, ConfirmRequest } from '@shared/confirm'
import { errorText } from '@shared/i18n/error-text'

/**
 * The approval gate. A mail or calendar operation that leaves the machine or is hard to undo, and an
 * agent job the conversation model starts, carries on, merges or discards, opens the renderer's
 * confirmation screen here and waits for the user's answer before it runs. Aborting the caller's signal
 * closes the screen and returns false. The confirmation is a single sheet inside the app, ConfirmSheet,
 * and the gate is the one place that knows which requests are still waiting.
 */

export type ConfirmInput = Omit<ConfirmRequest, 'id' | 'holdsConversation'>

/**
 * The conversation turn a confirmation is asked from, carried along the asynchronous calls of its tools.
 * The mail and calendar services ask with nothing but a signal, so the turn cannot be handed down as an
 * argument; a turn runs its tools inside askingFrom and is asked to wait when one of them opens a
 * confirmation. It answers whether it does, because whatever a tool starts, such as a job's process,
 * carries the same context on after the turn has moved past that tool.
 */
const askingTurn = new AsyncLocalStorage<() => boolean>()

/** Runs `run` so that a confirmation it opens first calls `onAsk`, which tells whether a conversation turn waits for the answer. */
export const askingFrom = <T>(onAsk: () => boolean, run: () => T): T => askingTurn.run(onAsk, run)

export interface ConfirmGate {
  request(input: ConfirmInput, signal: AbortSignal): Promise<boolean>
  /** The renderer's answer. An unknown id, for instance one already aborted, returns false. */
  resolve(id: string, approved: boolean): boolean
  /** The requests waiting for an answer, oldest first, for a renderer that loaded after they opened. */
  pending(): ConfirmRequest[]
}

export function createConfirmGate(options: { emit: (event: ConfirmEvent) => void; createId?: () => string; beforeOpen?: () => void }): ConfirmGate {
  const pending = new Map<string, { request: ConfirmRequest; finish: (approved: boolean) => void }>()
  return {
    request(input, signal) {
      if (signal.aborted) return Promise.resolve(false)
      const id = options.createId?.() ?? randomUUID()
      options.beforeOpen?.()
      const request: ConfirmRequest = { id, ...input, holdsConversation: askingTurn.getStore()?.() ?? false }
      return new Promise<boolean>((resolve) => {
        const finish = (approved: boolean): void => {
          pending.delete(id)
          signal.removeEventListener('abort', onAbort)
          options.emit({ type: 'close', id })
          resolve(approved)
        }
        const onAbort = (): void => finish(false)
        pending.set(id, { request, finish })
        signal.addEventListener('abort', onAbort, { once: true })
        options.emit({ type: 'open', request })
      })
    },
    resolve(id, approved) {
      const entry = pending.get(id)
      if (!entry) return false
      entry.finish(approved)
      return true
    },
    pending: () => [...pending.values()].map((entry) => entry.request)
  }
}

export const confirmEvents = mitt<{ event: ConfirmEvent }>()

let gate: ConfirmGate | null = null

function electronGate(): ConfirmGate {
  return (gate ??= createConfirmGate({
    emit: (event) => confirmEvents.emit('event', event),
    beforeOpen: () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!window || window.isDestroyed()) throw new Error(errorText('confirm.unavailable'))
      if (!window.isVisible()) window.show()
    }
  }))
}

export const requestConfirm = (input: ConfirmInput, signal: AbortSignal): Promise<boolean> => electronGate().request(input, signal)
export const resolveConfirm = (id: string, approved: boolean): boolean => electronGate().resolve(id, approved)
export const pendingConfirms = (): ConfirmRequest[] => electronGate().pending()

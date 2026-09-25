import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import mitt from 'mitt'
import type { ConfirmEvent, ConfirmRequest } from '@shared/confirm'
import { errorText } from '@shared/i18n/error-text'

/**
 * The approval gate. A mail or calendar operation that leaves the machine or is hard to undo, and an
 * agent job the conversation model starts, carries on or merges, opens the renderer's confirmation
 * screen here and waits for the user's answer before it runs. Aborting the caller's signal closes the
 * screen and returns false. The confirmation is a single sheet inside the app, ConfirmSheet.
 */

export type ConfirmInput = Omit<ConfirmRequest, 'id'>

export interface ConfirmGate {
  request(input: ConfirmInput, signal: AbortSignal): Promise<boolean>
  /** The renderer's answer. An unknown id, for instance one already aborted, returns false. */
  resolve(id: string, approved: boolean): boolean
  pendingIds(): string[]
}

export function createConfirmGate(options: { emit: (event: ConfirmEvent) => void; createId?: () => string; beforeOpen?: () => void }): ConfirmGate {
  const pending = new Map<string, (approved: boolean) => void>()
  return {
    request(input, signal) {
      if (signal.aborted) return Promise.resolve(false)
      const id = options.createId?.() ?? randomUUID()
      options.beforeOpen?.()
      return new Promise<boolean>((resolve) => {
        const finish = (approved: boolean): void => {
          pending.delete(id)
          signal.removeEventListener('abort', onAbort)
          options.emit({ type: 'close', id })
          resolve(approved)
        }
        const onAbort = (): void => finish(false)
        pending.set(id, finish)
        signal.addEventListener('abort', onAbort, { once: true })
        options.emit({ type: 'open', request: { id, ...input } })
      })
    },
    resolve(id, approved) {
      const finish = pending.get(id)
      if (!finish) return false
      finish(approved)
      return true
    },
    pendingIds: () => [...pending.keys()]
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

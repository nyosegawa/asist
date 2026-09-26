import { act } from 'react'
import { useConfirmStore } from '../../src/renderer/src/state/confirm'

/** Answers the confirmation a screen is waiting on, as the sheet would, and fails when none is open. */
export async function answerConfirm(approved: boolean): Promise<void> {
  const [request] = useConfirmStore.getState().queue
  if (!request?.resolve) throw new Error('No confirmation from the renderer is open')
  const { id, resolve } = request
  await act(async () => {
    resolve(approved)
    useConfirmStore.getState().close(id)
  })
}

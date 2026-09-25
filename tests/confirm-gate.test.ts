import { describe, expect, it } from 'vitest'
import type { ConfirmEvent } from '@shared/confirm'
import { createConfirmGate } from '../src/main/services/confirm'

function setup() {
  const events: ConfirmEvent[] = []
  let seq = 0
  const gate = createConfirmGate({ emit: (event) => events.push(event), createId: () => `c${++seq}` })
  return { gate, events }
}

describe('createConfirmGate', () => {
  it('emits open, waits for the answer, then emits close and resolves with the answer', async () => {
    const { gate, events } = setup()
    const pending = gate.request({ title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }, new AbortController().signal)
    expect(events).toEqual([{ type: 'open', request: { id: 'c1', title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false } }])
    expect(gate.pendingIds()).toEqual(['c1'])
    expect(gate.resolve('c1', true)).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(events.at(-1)).toEqual({ type: 'close', id: 'c1' })
    expect(gate.pendingIds()).toEqual([])
    expect(gate.resolve('c1', true)).toBe(false)
  })

  it('closes and resolves false when the caller aborts, and does not open for an already aborted signal', async () => {
    const { gate, events } = setup()
    const controller = new AbortController()
    const pending = gate.request({ title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }, controller.signal)
    controller.abort()
    await expect(pending).resolves.toBe(false)
    expect(events.map((event) => event.type)).toEqual(['open', 'close'])
    await expect(gate.request({ title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }, controller.signal)).resolves.toBe(false)
    expect(events).toHaveLength(2)
  })

  it('resolves false when the request is cancelled', async () => {
    const { gate } = setup()
    const pending = gate.request({ title: 't', message: 'm', detail: 'd', confirmLabel: '実行', destructive: false }, new AbortController().signal)
    gate.resolve('c1', false)
    await expect(pending).resolves.toBe(false)
  })
})

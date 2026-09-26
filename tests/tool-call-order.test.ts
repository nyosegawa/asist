import { describe, expect, it } from 'vitest'
import { ToolCallOrder } from '@shared/tool-call-order'

/** The work of one call, ended by the test. */
function work(): { completion: Promise<void>; end: () => void } {
  let end!: () => void
  const completion = new Promise<void>((resolve) => (end = resolve))
  return { completion, end }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Runs named calls through one order and records which have started. */
function harness() {
  const order = new ToolCallOrder()
  const started: string[] = []
  const works = new Map<string, ReturnType<typeof work>>()
  const submit = (name: string, parallel: boolean) =>
    order.run(parallel, () => {
      started.push(name)
      const call = work()
      works.set(name, call)
      return call
    })
  const end = async (name: string): Promise<void> => {
    works.get(name)!.end()
    await settle()
  }
  return { started, submit, end }
}

describe('ToolCallOrder', () => {
  it('starts parallel calls together, and a writing call alone once every call before it has ended, with later calls waiting for it', async () => {
    const { started, submit, end } = harness()
    submit('read-a', true)
    submit('read-b', true)
    submit('write-c', false)
    submit('write-d', false)
    submit('read-e', true)
    await settle()
    expect(started).toEqual(['read-a', 'read-b'])
    await end('read-b')
    expect(started).toEqual(['read-a', 'read-b'])
    await end('read-a')
    expect(started).toEqual(['read-a', 'read-b', 'write-c'])
    await end('write-c')
    expect(started).toEqual(['read-a', 'read-b', 'write-c', 'write-d'])
    await end('write-d')
    expect(started).toEqual(['read-a', 'read-b', 'write-c', 'write-d', 'read-e'])
  })

  it('keeps the place of a call that has answered until its work has ended, and hands its work back whole', async () => {
    const order = new ToolCallOrder()
    const first = work()
    // A tool that timed out: its promise has answered, while its work goes on.
    const answered = Object.assign(Promise.resolve('timed out'), { completion: first.completion })
    const started = await order.run(false, () => answered)
    expect(started?.work).toBe(answered)
    let second = false
    void order.run(false, () => {
      second = true
      return work()
    })
    await settle()
    expect(second).toBe(false)
    first.end()
    await settle()
    expect(second).toBe(true)
  })

  it('gives up the place of a call that does not start, and of one whose start throws', async () => {
    const order = new ToolCallOrder()
    await expect(order.run(false, () => null)).resolves.toBeNull()
    await expect(
      order.run(false, () => {
        throw new Error('broken tool')
      })
    ).rejects.toThrow('broken tool')
    let later = false
    void order.run(false, () => {
      later = true
      return work()
    })
    await settle()
    expect(later).toBe(true)
  })
})

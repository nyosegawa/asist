import { describe, expect, it, vi } from 'vitest'
import { withRetry } from '@shared/retry'

const immediateSleep = (): Promise<void> => Promise.resolve()

describe('withRetry', () => {
  it('retries a transient error and returns the eventual success', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('transient')
        return 'ok'
      },
      { delays: [1, 1], shouldRetry: () => true, sleep: immediateSleep }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('stops after delays.length + 1 attempts', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('always')
        },
        { delays: [1, 1], shouldRetry: () => true, sleep: immediateSleep }
      )
    ).rejects.toThrow('always')
    expect(calls).toBe(3)
  })

  it('throws straight away when shouldRetry returns false', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('fatal')
        },
        { delays: [1, 1], shouldRetry: () => false, sleep: immediateSleep }
      )
    ).rejects.toThrow('fatal')
    expect(calls).toBe(1)
  })

  it('sets ctx.isLast on the final attempt only', async () => {
    const seen: boolean[] = []
    await withRetry(
      async ({ isLast }) => {
        seen.push(isLast)
        if (!isLast) throw new Error('transient')
        return 'done'
      },
      { delays: [1], shouldRetry: () => true, sleep: immediateSleep }
    )
    expect(seen).toEqual([false, true])
  })

  it('calls onRetry after every failure and sleeps for the given delay', async () => {
    const onRetry = vi.fn()
    const sleeps: number[] = []
    let calls = 0
    await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('x')
        return 'ok'
      },
      {
        delays: [100, 200],
        shouldRetry: () => true,
        onRetry,
        sleep: async (ms) => {
          sleeps.push(ms)
        }
      }
    )
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([100, 200])
  })
})

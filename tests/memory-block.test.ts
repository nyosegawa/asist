import { describe, expect, it, vi } from 'vitest'
import { FrozenMemoryBlock, MEMORY_BLOCK_FREEZE_MS } from '@shared/memory-block'

describe('FrozenMemoryBlock', () => {
  it('builds the block on the first turn and reuses it for turns within five minutes', () => {
    let version = 0
    const build = vi.fn(() => `block-${++version}`)
    const block = new FrozenMemoryBlock(build)
    expect(block.forTurn(0)).toBe('block-1')
    expect(block.forTurn(60_000)).toBe('block-1')
    expect(block.forTurn(MEMORY_BLOCK_FREEZE_MS - 1)).toBe('block-1')
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the block when five minutes or more passed since the previous turn', () => {
    let version = 0
    const block = new FrozenMemoryBlock(() => `block-${++version}`)
    block.forTurn(0)
    block.forTurn(4 * 60_000)
    expect(block.forTurn(4 * 60_000 + MEMORY_BLOCK_FREEZE_MS)).toBe('block-2')
  })

  it('rebuilds the block on the next turn after invalidate', () => {
    let version = 0
    const block = new FrozenMemoryBlock(() => `block-${++version}`)
    block.forTurn(0)
    block.invalidate()
    expect(block.forTurn(1000)).toBe('block-2')
  })

  it('freezes a null block as well', () => {
    const build = vi.fn(() => null)
    const block = new FrozenMemoryBlock(build)
    expect(block.forTurn(0)).toBeNull()
    expect(block.forTurn(1)).toBeNull()
    expect(build).toHaveBeenCalledTimes(1)
  })
})

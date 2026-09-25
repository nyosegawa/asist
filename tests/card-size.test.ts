import { describe, expect, it } from 'vitest'
import { CARD_SIZE_MIN_HEIGHT, CARD_S_MAX_HEIGHT, cardSizeFor } from '@/panels/shell/card'

/** The rule that turns the dock's inner height into a card size. These tests guard the boundaries, not the height values themselves. */
describe('cardSizeFor', () => {
  it('returns a size at exactly its minimum height and the next size down one pixel below it', () => {
    expect(cardSizeFor(CARD_SIZE_MIN_HEIGHT.l)).toBe('l')
    expect(cardSizeFor(CARD_SIZE_MIN_HEIGHT.l - 1)).toBe('m')
    expect(cardSizeFor(CARD_SIZE_MIN_HEIGHT.m)).toBe('m')
    expect(cardSizeFor(CARD_SIZE_MIN_HEIGHT.m - 1)).toBe('s')
  })

  it('returns s for any height below the minimum and has no upper bound', () => {
    expect(cardSizeFor(0)).toBe('s')
    expect(cardSizeFor(-10)).toBe('s')
    expect(cardSizeFor(10_000)).toBe('l')
  })

  it('keeps the s maximum below the m minimum and the m minimum below the l minimum', () => {
    // If this ordering breaks, an s card no longer always fits an m dock, and dropping a card one
    // size would not be enough to make it fit.
    expect(CARD_S_MAX_HEIGHT).toBeLessThan(CARD_SIZE_MIN_HEIGHT.m)
    expect(CARD_SIZE_MIN_HEIGHT.m).toBeLessThan(CARD_SIZE_MIN_HEIGHT.l)
  })
})

import { describe, expect, it } from 'vitest'
import { fmtTimeRange } from '../src/renderer/src/ui/calendar/format'

const at = (hour: number, minute = 0): number => new Date(2026, 9, 3, hour, minute).getTime()
const join = (start: string, end: string): string => `${start}〜${end}`
/** Intl puts thin and narrow no-break spaces around the dash and before the day period. */
const range = (...args: Parameters<typeof fmtTimeRange>): string => fmtTimeRange(...args).replace(/\s/g, ' ')

describe('the time range of an event', () => {
  it('writes the day period of a 12-hour clock once, and drops the minutes of times on the hour', () => {
    expect(range('en-US', at(10), at(11), join)).toBe('10 – 11 AM')
    expect(range('en-US', at(13, 30), at(20), join)).toBe('1:30 – 8:00 PM')
    expect(range('en-US', at(10), at(20), join)).toBe('10 AM – 8 PM')
  })

  it('keeps both times whole on a 24-hour clock, joined as the dictionary joins them', () => {
    expect(range('ja-JP', at(10), at(11), join)).toBe('10:00〜11:00')
    expect(range('de-DE', at(13, 30), at(20), join)).toBe('13:30〜20:00')
  })
})

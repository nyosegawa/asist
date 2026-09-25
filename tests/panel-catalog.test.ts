import { describe, expect, it } from 'vitest'
import { catalogByType } from '@shared/panel-catalog'

describe('panel catalog keys', () => {
  it('gives a separate key to weather dates and calendar ranges that fetch different content', () => {
    const weather = catalogByType.get('weather')!
    const calendar = catalogByType.get('calendar')!
    expect(weather.key({ location: '大阪', date: 'today' })).not.toBe(
      weather.key({ location: '大阪', date: 'tomorrow' })
    )
    expect(calendar.key({ range: 'today' })).not.toBe(calendar.key({ range: 'week' }))
    expect(calendar.key({ range: 'next-week' })).toBe('calendar:next-week')
    expect(calendar.key({ from: '2026-10-01', to: '2026-10-31' })).toBe('calendar:2026-10-01..2026-10-31')
    expect(calendar.key({ range: 'week', query: 'スミカ' })).toBe('calendar:week:スミカ')
    expect(calendar.key({})).toBe('calendar:today')
  })

  it('gives every timer its own id, even two started in the same millisecond', () => {
    const timer = catalogByType.get('timer')!
    const first = timer.key({ seconds: 60 })
    const second = timer.key({ seconds: 60 })
    expect(first).toMatch(/^timer:/)
    expect(second).toMatch(/^timer:/)
    expect(second).not.toBe(first)
  })
})

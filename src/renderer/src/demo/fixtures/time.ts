export const DEMO_CLOCKS: Record<string, { city: string; timezone: string; country: string }> = {
  ニューヨーク: { city: 'ニューヨーク', timezone: 'America/New_York', country: 'アメリカ合衆国' },
  ロサンゼルス: { city: 'ロサンゼルス', timezone: 'America/Los_Angeles', country: 'アメリカ合衆国' },
  ロンドン: { city: 'ロンドン', timezone: 'Europe/London', country: 'イギリス' },
  パリ: { city: 'パリ', timezone: 'Europe/Paris', country: 'フランス' },
  シンガポール: { city: 'シンガポール', timezone: 'Asia/Singapore', country: 'シンガポール' },
  シドニー: { city: 'シドニー', timezone: 'Australia/Sydney', country: 'オーストラリア' },
  東京: { city: '東京', timezone: 'Asia/Tokyo', country: '日本' }
}

/** A city that is not listed falls back to "ニューヨーク" ("New York"). */
export const demoClock = (city: string): (typeof DEMO_CLOCKS)[string] => DEMO_CLOCKS[city] ?? DEMO_CLOCKS.ニューヨーク

export const DEMO_TIMER = { seconds: 180, label: '3分タイマー' }

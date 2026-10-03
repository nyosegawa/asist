import { zonedDate, type WeatherCondition, type WeatherData, type WeatherDay, type WeatherWord } from '@shared/weather'

/**
 * The fixed weather used by the demo mode and by the display tests. It is invented data written as
 * though it had been issued at 17:00 on 2026-09-15, not a real forecast. Nagano stands for today, with
 * an observation but no published high and low, and Tokyo for tomorrow, with no observation, so that
 * both shapes of the card appear. Munich stands for the worldwide source, whose card has no landscape,
 * no issue time and no station, and which names the sky by a weather code instead of in words. The other
 * worldwide samples hold a step for every three hours of a day, as a card for tomorrow does and a card for
 * today asked for in the small hours does, which is the widest the hourly row grows.
 */

const condition = (
  label: string,
  icons: WeatherCondition['icons'],
  transition = false
): WeatherCondition => ({ label, word: null, icons, transition })
const coded = (word: WeatherWord, icons: WeatherCondition['icons']): WeatherCondition => ({
  label: null,
  word,
  icons,
  transition: false
})
const RAIN = condition('雨', ['rain'])
const CLOUDY = condition('くもり', ['cloudy'])
const CLEAR = condition('晴れ', ['clear'])
const RAIN_THEN_CLOUDY = condition('雨のちくもり', ['rain', 'cloudy'], true)
const CLOUDY_THEN_CLEAR = condition('くもりのち晴れ', ['cloudy', 'clear'], true)
const CLEAR_THEN_CLOUDY = condition('晴れのちくもり', ['clear', 'cloudy'], true)
const OVERCAST = coded('overcast', ['cloudy'])
const PARTLY_CLOUDY = coded('partlyCloudy', ['clear', 'cloudy'])
const LIGHT_RAIN = coded('lightRain', ['rain'])
const SHOWERS = coded('showers', ['rain'])
const MAINLY_CLEAR = coded('mainlyClear', ['clear'])

const JAPAN = '+09:00'
const at = (date: string, hour: number, offset = JAPAN): string =>
  `${date}T${String(hour).padStart(2, '0')}:00:00${offset}`
const nextDay = (date: string): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
const hours = (
  date: string,
  rows: Array<[number, number, WeatherCondition]>,
  offset = JAPAN
): WeatherData['hourly'] =>
  rows.map(([h, temperature, cond]) => ({
    at: at(date, h, offset),
    until: h + 3 >= 24 ? at(nextDay(date), 0, offset) : at(date, h + 3, offset),
    temperature,
    condition: cond
  }))
const day = (
  date: string,
  cond: WeatherCondition,
  max: number | null,
  min: number | null,
  percent: number | null
): WeatherDay => ({ date, condition: cond, max, min, percent })
const week = (start: string, days: Array<[WeatherCondition, number, number, number]>): WeatherDay[] =>
  days.map(([cond, max, min, percent], i) => {
    const date = new Date(Date.parse(`${start}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)
    return day(date, cond, max, min, percent)
  })
/** The card for tomorrow fetches no observation, as in the main process, so it carries no observation entry. */
const sources = (issued: string, observed: string | null): WeatherData['sources'] => [
  {
    product: 'forecast',
    issuedAt: issued,
    fetchedAt: at('2026-09-15', 18),
    status: 'ready',
    url: 'https://www.jma.go.jp/bosai/forecast/'
  },
  {
    product: 'hourly',
    issuedAt: issued,
    fetchedAt: at('2026-09-15', 18),
    status: 'ready',
    url: 'https://www.jma.go.jp/bosai/jmatile/'
  },
  ...(observed
    ? [
        {
          product: 'observation' as const,
          issuedAt: observed,
          fetchedAt: at('2026-09-15', 18),
          status: 'ready' as const,
          url: 'https://www.jma.go.jp/bosai/amedas/'
        }
      ]
    : [])
]
const CELSIUS: WeatherData['units'] = { temperature: '°C', wind: null }

export const DEMO_WEATHER_NAGANO: WeatherData = {
  location: {
    source: 'jma',
    requested: '長野県',
    cardId: '20201',
    timeZone: 'Asia/Tokyo',
    municipalityCode: '20201',
    name: '長野市',
    prefecture: '長野県',
    prefectureId: 'nagano',
    forecastAreaCode: '200010',
    forecastAreaName: '北部',
    officeCode: '200000',
    stationId: '48156',
    stationName: '長野',
    usedRepresentative: true
  },
  targetDate: '2026-09-15',
  date: 'today',
  fetchedAt: at('2026-09-15', 18),
  units: CELSIUS,
  observation: {
    at: at('2026-09-15', 18),
    station: '長野',
    temperature: 23.4,
    humidity: 95,
    wind: null
  },
  hourly: hours('2026-09-15', [
    [18, 24, RAIN],
    [21, 23, CLOUDY]
  ]),
  temperaturePoint: '長野',
  precipitationPeriods: [{ from: at('2026-09-15', 18), to: at('2026-09-16', 0), percent: 60 }],
  day: day('2026-09-15', RAIN_THEN_CLOUDY, null, null, 60),
  daily: week('2026-09-16', [
    [CLOUDY, 27, 21, 30],
    [CLOUDY_THEN_CLEAR, 29, 20, 20],
    [CLEAR, 30, 21, 10],
    [CLEAR, 31, 22, 10],
    [CLOUDY, 28, 22, 40],
    [RAIN, 25, 21, 70],
    [CLOUDY, 27, 20, 30]
  ]),
  sources: sources(at('2026-09-15', 17), at('2026-09-15', 18))
}

export const DEMO_WEATHER_TOKYO: WeatherData = {
  location: {
    source: 'jma',
    requested: '東京都',
    cardId: '13101',
    timeZone: 'Asia/Tokyo',
    municipalityCode: '13101',
    name: '千代田区',
    prefecture: '東京都',
    prefectureId: 'tokyo',
    forecastAreaCode: '130010',
    forecastAreaName: '東京地方',
    officeCode: '130000',
    stationId: '44132',
    stationName: '東京',
    usedRepresentative: true
  },
  targetDate: '2026-09-16',
  date: 'tomorrow',
  fetchedAt: at('2026-09-15', 18),
  units: CELSIUS,
  observation: null,
  hourly: hours('2026-09-16', [
    [0, 23, RAIN],
    [3, 22, RAIN],
    [6, 21, RAIN],
    [9, 22, RAIN],
    [12, 23, RAIN],
    [15, 23, RAIN],
    [18, 22, RAIN],
    [21, 21, RAIN_THEN_CLOUDY]
  ]),
  temperaturePoint: '東京',
  precipitationPeriods: [
    { from: at('2026-09-16', 0), to: at('2026-09-16', 6), percent: 80 },
    { from: at('2026-09-16', 6), to: at('2026-09-16', 12), percent: 80 },
    { from: at('2026-09-16', 12), to: at('2026-09-16', 18), percent: 80 },
    { from: at('2026-09-16', 18), to: at('2026-09-17', 0), percent: 70 }
  ],
  day: day('2026-09-16', RAIN, 24, 21, 80),
  daily: week('2026-09-16', [
    [RAIN, 24, 21, 80],
    [CLOUDY, 26, 21, 40],
    [CLEAR_THEN_CLOUDY, 29, 22, 20],
    [CLEAR, 30, 23, 10],
    [CLOUDY, 28, 23, 30],
    [RAIN, 25, 22, 60],
    [CLOUDY, 27, 21, 40]
  ]),
  sources: sources(at('2026-09-15', 17), null)
}

const NAGANO_DAY = hours('2026-09-15', [
  [0, 18, RAIN],
  [3, 17, RAIN],
  [6, 18, RAIN],
  [9, 20, RAIN],
  [12, 22, RAIN],
  [15, 21, RAIN],
  [18, 24, RAIN],
  [21, 23, CLOUDY]
])
const NAGANO_PERIODS: WeatherData['precipitationPeriods'] = [
  { from: at('2026-09-15', 0), to: at('2026-09-15', 6), percent: 80 },
  { from: at('2026-09-15', 6), to: at('2026-09-15', 12), percent: 80 },
  { from: at('2026-09-15', 12), to: at('2026-09-15', 18), percent: 80 },
  { from: at('2026-09-15', 18), to: at('2026-09-16', 0), percent: 60 }
]
/**
 * Nagano's day as a card for today asked for 20 minutes after an hour, from the step still running to the
 * end of the day, with the six-hour chances of rain that are left. Asked in the small hours it has all eight
 * steps, the widest the agency's hourly row grows, beside the missing high and low of the morning.
 */
function naganoTodayFrom(hour: number, issued: string): WeatherData {
  const asked = `2026-09-15T${String(hour).padStart(2, '0')}:20:00${JAPAN}`
  return {
    ...DEMO_WEATHER_NAGANO,
    fetchedAt: asked,
    observation: { ...DEMO_WEATHER_NAGANO.observation!, at: at('2026-09-15', hour) },
    hourly: NAGANO_DAY.filter((step) => Date.parse(step.until) > Date.parse(asked)),
    precipitationPeriods: NAGANO_PERIODS.filter((period) => Date.parse(period.to) > Date.parse(asked)),
    sources: sources(issued, at('2026-09-15', hour))
  }
}
export const DEMO_WEATHER_NAGANO_MIDNIGHT = naganoTodayFrom(0, at('2026-09-14', 17))
export const DEMO_WEATHER_NAGANO_MORNING = naganoTodayFrom(6, at('2026-09-15', 5))
export const DEMO_WEATHER_NAGANO_NOON = naganoTodayFrom(12, at('2026-09-15', 11))

/** A clear day, the sample used to judge how bright the sky and the landscape look. */
export const DEMO_WEATHER_MIYAGI: WeatherData = {
  location: {
    source: 'jma',
    requested: '宮城県',
    cardId: '04100',
    timeZone: 'Asia/Tokyo',
    municipalityCode: '04100',
    name: '仙台市',
    prefecture: '宮城県',
    prefectureId: 'miyagi',
    forecastAreaCode: '040010',
    forecastAreaName: '東部',
    officeCode: '040000',
    stationId: '34392',
    stationName: '仙台',
    usedRepresentative: true
  },
  targetDate: '2026-09-15',
  date: 'today',
  fetchedAt: at('2026-09-15', 18),
  units: CELSIUS,
  observation: {
    at: at('2026-09-15', 18),
    station: '仙台',
    temperature: 29.1,
    humidity: 52,
    wind: null
  },
  hourly: hours('2026-09-15', [
    [18, 29, CLEAR],
    [21, 26, CLEAR]
  ]),
  temperaturePoint: '仙台',
  precipitationPeriods: [{ from: at('2026-09-15', 18), to: at('2026-09-16', 0), percent: 0 }],
  day: day('2026-09-15', CLEAR, 32, 24, 0),
  daily: week('2026-09-16', [
    [CLEAR, 32, 24, 0],
    [CLEAR_THEN_CLOUDY, 31, 24, 10],
    [CLOUDY, 29, 23, 30],
    [CLOUDY_THEN_CLEAR, 30, 23, 20],
    [CLEAR, 31, 23, 10],
    [CLEAR, 32, 24, 0],
    [CLOUDY, 30, 24, 40]
  ]),
  sources: sources(at('2026-09-15', 17), at('2026-09-15', 18))
}

const BERLIN = '+02:00'
/**
 * The worldwide source works a day out from its hours, so the first day holds the light rain and the 60 per
 * cent of its 21:00 step below.
 */
const MUNICH_WEEK = week('2026-09-15', [
  [LIGHT_RAIN, 16, 12, 60],
  [PARTLY_CLOUDY, 17, 9, 10],
  [SHOWERS, 15, 8, 70],
  [OVERCAST, 14, 7, 40],
  [MAINLY_CLEAR, 18, 8, 5],
  [PARTLY_CLOUDY, 19, 10, 15],
  [LIGHT_RAIN, 16, 11, 55]
])
/** A place the worldwide source answers for: no landscape, no station, no issue time, and wind. */
export const DEMO_WEATHER_MUNICH: WeatherData = {
  location: {
    source: 'open-meteo',
    requested: 'Munich',
    cardId: 'place:munich',
    timeZone: 'Europe/Berlin',
    name: 'München',
    admin: 'Bayern',
    country: 'Deutschland',
    countryCode: 'DE',
    latitude: 48.13743,
    longitude: 11.57549
  },
  targetDate: '2026-09-15',
  date: 'today',
  fetchedAt: at('2026-09-15', 18, BERLIN),
  units: { temperature: '°C', wind: 'km/h' },
  observation: {
    at: at('2026-09-15', 18, BERLIN),
    station: null,
    temperature: 14.8,
    humidity: 71,
    wind: { speed: 11, direction: 270 }
  },
  hourly: hours(
    '2026-09-15',
    [
      [18, 15, OVERCAST],
      [21, 13, LIGHT_RAIN]
    ],
    BERLIN
  ),
  temperaturePoint: null,
  precipitationPeriods: [
    { from: at('2026-09-15', 18, BERLIN), to: at('2026-09-15', 21, BERLIN), percent: 35 },
    { from: at('2026-09-15', 21, BERLIN), to: at('2026-09-16', 0, BERLIN), percent: 60 }
  ],
  day: MUNICH_WEEK[0],
  daily: MUNICH_WEEK,
  sources: [
    {
      product: 'forecast',
      issuedAt: null,
      fetchedAt: at('2026-09-15', 18, BERLIN),
      status: 'ready',
      url: 'https://api.open-meteo.com/v1/forecast'
    }
  ]
}

/** The chance of rain of each step of a worldwide card, whose periods are its steps. */
const periodsOf = (hourly: WeatherData['hourly'], percents: number[]): WeatherData['precipitationPeriods'] =>
  hourly.map((hour, k) => ({ from: hour.at, to: hour.until, percent: percents[k] }))

const MUNICH_TOMORROW_HOURS = hours(
  '2026-09-16',
  [
    [0, 10, MAINLY_CLEAR],
    [3, 9, MAINLY_CLEAR],
    [6, 9, PARTLY_CLOUDY],
    [9, 13, PARTLY_CLOUDY],
    [12, 16, MAINLY_CLEAR],
    [15, 17, PARTLY_CLOUDY],
    [18, 14, MAINLY_CLEAR],
    [21, 11, MAINLY_CLEAR]
  ],
  BERLIN
)
/** The worldwide source's card for tomorrow, whose eight steps run through the whole day. */
export const DEMO_WEATHER_MUNICH_TOMORROW: WeatherData = {
  ...DEMO_WEATHER_MUNICH,
  targetDate: '2026-09-16',
  date: 'tomorrow',
  observation: null,
  hourly: MUNICH_TOMORROW_HOURS,
  precipitationPeriods: periodsOf(MUNICH_TOMORROW_HOURS, [0, 5, 5, 10, 10, 5, 0, 0]),
  day: MUNICH_WEEK[1]
}

const MIAMI = '-04:00'
const MIAMI_HOURS = hours(
  '2026-09-15',
  [
    [1, 79, OVERCAST],
    [4, 78, OVERCAST],
    [7, 78, PARTLY_CLOUDY],
    [10, 84, PARTLY_CLOUDY],
    [13, 88, MAINLY_CLEAR],
    [16, 89, SHOWERS],
    [19, 84, LIGHT_RAIN],
    [22, 81, OVERCAST]
  ],
  MIAMI
)
const MIAMI_WEEK = week('2026-09-15', [
  [SHOWERS, 89, 78, 55],
  [PARTLY_CLOUDY, 88, 77, 10],
  [MAINLY_CLEAR, 90, 78, 5],
  [OVERCAST, 87, 77, 30],
  [LIGHT_RAIN, 85, 76, 65],
  [PARTLY_CLOUDY, 87, 76, 15],
  [MAINLY_CLEAR, 89, 77, 5]
])
/**
 * A card for today asked for in the small hours, in the units the United States reads, so that it holds the
 * eight steps of a whole day beside the reading of the present.
 */
export const DEMO_WEATHER_MIAMI: WeatherData = {
  location: {
    source: 'open-meteo',
    requested: 'Miami',
    cardId: 'place:miami',
    timeZone: 'America/New_York',
    name: 'Miami',
    admin: 'Florida',
    country: 'United States',
    countryCode: 'US',
    latitude: 25.77427,
    longitude: -80.19366
  },
  targetDate: '2026-09-15',
  date: 'today',
  fetchedAt: '2026-09-15T01:40:00-04:00',
  units: { temperature: '°F', wind: 'mph' },
  observation: {
    at: '2026-09-15T01:30:00-04:00',
    station: null,
    temperature: 79.3,
    humidity: 84,
    wind: { speed: 7, direction: 200 }
  },
  hourly: MIAMI_HOURS,
  temperaturePoint: null,
  precipitationPeriods: periodsOf(MIAMI_HOURS, [0, 0, 5, 10, 20, 55, 40, 15]),
  day: MIAMI_WEEK[0],
  daily: MIAMI_WEEK,
  sources: [
    {
      product: 'forecast',
      issuedAt: null,
      fetchedAt: '2026-09-15T01:40:00-04:00',
      status: 'ready',
      url: 'https://api.open-meteo.com/v1/forecast'
    }
  ]
}

const LORD_HOWE_STARTS = [
  '2026-10-04T00:00:00+10:30',
  ...[3, 6, 9, 12, 15, 18, 21].map((hour) => `2026-10-04T${String(hour).padStart(2, '0')}:30:00+11:00`)
]
const LORD_HOWE_ENDS = [...LORD_HOWE_STARTS.slice(1), '2026-10-05T00:00:00+11:00']
const LORD_HOWE_HOURS: WeatherData['hourly'] = (
  [
    [18.5, OVERCAST],
    [18.3, OVERCAST],
    [18.3, OVERCAST],
    [18.4, PARTLY_CLOUDY],
    [18.9, MAINLY_CLEAR],
    [19, MAINLY_CLEAR],
    [19.2, OVERCAST],
    [19.1, PARTLY_CLOUDY]
  ] as const
).map(([temperature, sky], k) => ({ at: LORD_HOWE_STARTS[k], until: LORD_HOWE_ENDS[k], temperature, condition: sky }))
const LORD_HOWE_WEEK = week('2026-10-03', [
  [LIGHT_RAIN, 20, 19, 6],
  [OVERCAST, 19, 18, 2],
  [OVERCAST, 20, 18, 6],
  [LIGHT_RAIN, 20, 19, 76],
  [SHOWERS, 20, 17, 84],
  [LIGHT_RAIN, 19, 16, 21],
  [MAINLY_CLEAR, 20, 19, 35]
])
/**
 * Tomorrow at Lord Howe Island on the day its clock goes forward by half an hour, from an answer written in
 * +10:30 the day before, so that from 02:00 its steps fall on the half hours of the clock and the card writes
 * its times with minutes. It keeps its day, since which of its times are off the hour depends on the offset
 * the island keeps on the day, and its place has the longest name of the samples.
 */
export const DEMO_WEATHER_LORD_HOWE: WeatherData = {
  location: {
    source: 'open-meteo',
    requested: 'Lord Howe Island',
    cardId: 'place:lord howe island',
    timeZone: 'Australia/Lord_Howe',
    name: 'Lord Howe Island',
    admin: 'New South Wales',
    country: 'Australia',
    countryCode: 'AU',
    latitude: -31.53103,
    longitude: 159.0683
  },
  targetDate: '2026-10-04',
  date: 'tomorrow',
  fetchedAt: '2026-10-03T12:00:00+10:30',
  units: { temperature: '°C', wind: 'km/h' },
  observation: null,
  hourly: LORD_HOWE_HOURS,
  temperaturePoint: null,
  precipitationPeriods: periodsOf(LORD_HOWE_HOURS, [0, 1, 2, 1, 0, 1, 2, 1]),
  day: LORD_HOWE_WEEK[1],
  daily: LORD_HOWE_WEEK,
  sources: [
    {
      product: 'forecast',
      issuedAt: null,
      fetchedAt: '2026-10-03T12:00:00+10:30',
      status: 'ready',
      url: 'https://api.open-meteo.com/v1/forecast'
    }
  ]
}

/** Picks the weather the demo shows from the utterance the user typed. */
export const demoWeatherFor = (text: string): WeatherData =>
  /Munich|ミュンヘン/i.test(text)
    ? DEMO_WEATHER_MUNICH
    : /東京/.test(text)
      ? DEMO_WEATHER_TOKYO
      : /宮城|仙台/.test(text)
        ? DEMO_WEATHER_MIYAGI
        : DEMO_WEATHER_NAGANO

/**
 * The weather moved by whole days, so that the day it was fetched on is today at the place. The card names
 * its day as today or tomorrow by the date at the place when it is drawn, so on any other day the demo
 * would show the fixed days as days gone by; the tests keep the fixed days.
 */
export function onDemoDay(weather: WeatherData, now = Date.now()): WeatherData {
  const zone = weather.location.timeZone
  const days = Math.round(
    (Date.parse(zonedDate(now, zone)) - Date.parse(zonedDate(Date.parse(weather.fetchedAt), zone))) / 86_400_000
  )
  const shift = (value: unknown): unknown => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))
      return new Date(Date.parse(`${value.slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10) + value.slice(10)
    if (Array.isArray(value)) return value.map(shift)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shift(entry)]))
    return value
  }
  return shift(weather) as WeatherData
}

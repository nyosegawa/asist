import type { PanelSpec } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import { useT, useFormatLocale } from '@/i18n'
import type { CardContext, CardDefinition } from '../shell/card'
import { Box, Facts } from '../primitives/Card'
import { timeFields } from '../primitives/format'
import './fx.css'

interface FxProps {
  base: string
  quote: string
  rate: number
  amount?: number | null
  /** When the provider last updated the rate, as RFC 1123 or ISO 8601. */
  asOf?: string
}

/** The currencies whose short unit the dictionary carries. Any other code is shown as the code itself. */
const UNIT_CODES = [
  'USD', 'JPY', 'EUR', 'GBP', 'CNY', 'KRW', 'AUD', 'CAD', 'CHF', 'HKD',
  'TWD', 'SGD', 'THB', 'INR', 'NZD', 'MXN', 'BRL', 'PHP', 'VND', 'IDR'
] as const
type UnitCode = (typeof UNIT_CODES)[number]
const hasUnit = (code: string): code is UnitCode => (UNIT_CODES as readonly string[]).includes(code)
/** Currencies whose single unit is small, for which the quick table starts at a larger amount. */
const SMALL_UNIT = new Set(['JPY', 'KRW', 'VND', 'IDR'])
const ROWS: Record<CardContext['size'], number> = { l: 5, m: 4, s: 3, focus: 5 }

const propsOf = (spec: PanelSpec): FxProps => spec.props as unknown as FxProps
const currencyName = (code: string, locale: string): string =>
  new Intl.DisplayNames(locale, { type: 'currency' }).of(code) ?? code
const currencyUnit = (code: string, count: number, t: Translate): string =>
  hasUnit(code) ? t(`cardsFinance.fx.units.${code}`, { count }) : code
/** Drops decimals as the value grows: four below 1, two below 100, none above that. */
const amountText = (value: number, locale: string): string =>
  value.toLocaleString(locale, { maximumFractionDigits: value < 1 ? 4 : value < 100 ? 2 : 0 })
const rateText = (rate: number, locale: string): string =>
  rate.toLocaleString(locale, {
    minimumFractionDigits: rate < 1 ? 4 : 2,
    maximumFractionDigits: rate < 1 ? 4 : 3
  })
const asOfText = (asOf: string | undefined, locale: string): string | null => {
  const at = asOf ? Date.parse(asOf) : NaN
  return Number.isNaN(at)
    ? null
    : new Date(at).toLocaleString(locale, { ...timeFields(locale), month: 'numeric', day: 'numeric' })
}

/** The amounts the quick table lists. An amount asked for goes first. */
export function tableAmounts(base: string, amount: number | null | undefined, rows: number): number[] {
  const steps = SMALL_UNIT.has(base) ? [100, 1000, 10000, 100000, 1000000] : [1, 10, 100, 1000, 10000]
  if (amount === null || amount === undefined) return steps.slice(0, rows)
  return [amount, ...steps.filter((v) => v !== amount)].slice(0, rows)
}

function AsOf({ spec }: CardContext): React.JSX.Element | null {
  const t = useT()
  const locale = useFormatLocale()
  const text = asOfText(propsOf(spec).asOf, locale)
  return text ? <span className="fx-asof">{t('cardsFinance.fx.updated', { time: text })}</span> : null
}

function FxBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const { base, quote, rate, amount, asOf } = propsOf(spec)
  const amounts = tableAmounts(base, amount, ROWS[size])
  return (
    <div className="card fx" data-size={size}>
      <div className="card-hero">
        <h3>
          {currencyName(base, locale)} → {currencyName(quote, locale)}
        </h3>
        <p>
          <b>
            {base}/{quote}
          </b>
        </p>
        <div className="card-big">
          <strong>
            {rateText(rate, locale)}
            <small>{currencyUnit(quote, rate, t)}</small>
          </strong>
        </div>
        <p className="card-note">{t('cardsFinance.fx.per', { unit: currencyUnit(base, 1, t) })}</p>
      </div>
      <Box title={t('cardsFinance.fx.table')} note={`${base} → ${quote}`}>
        <ul className="card-rows fx-table">
          {amounts.map((value) => (
            <li key={value} className="card-row" aria-current={value === amount ? 'true' : undefined}>
              <span className="fx-from">
                {amountText(value, locale)} {currencyUnit(base, value, t)}
              </span>
              <span className="fx-to">
                {amountText(value * rate, locale)} {currencyUnit(quote, value * rate, t)}
              </span>
            </li>
          ))}
        </ul>
        {size !== 's' && (
          <Facts
            columns={1}
            items={[
              [
                t('cardsFinance.fx.inverse'),
                t('cardsFinance.fx.inverseRate', {
                  quote: currencyUnit(quote, 1, t),
                  amount: amountText(1 / rate, locale),
                  base: currencyUnit(base, 1 / rate, t)
                })
              ],
              [t('cardsFinance.fx.providerUpdated'), asOfText(asOf, locale) ?? t('cardsFinance.fx.updatedUnknown')]
            ]}
          />
        )}
      </Box>
      <footer className="fx-footer">
        <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
          {t('cardsFinance.fx.attribution')}
        </a>
      </footer>
    </div>
  )
}

export const fxCard: CardDefinition = {
  Body: FxBody,
  kicker: 'FX RATE',
  className: 'fx-card',
  meta: (context) => <AsOf {...context} />
}

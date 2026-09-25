/**
 * How an amount in USD is written wherever the costs appear. An amount under ten cents keeps a third
 * decimal, because a day of light use costs a few cents and two decimals would show it as $0.03 or $0.00.
 */
export function usdFormatter(locale: string): (value: number) => string {
  const cents = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const mills = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 })
  return (value) => (value !== 0 && Math.abs(value) < 0.1 ? mills : cents).format(value)
}

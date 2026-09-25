import { useEffect, useRef, useState } from 'react'
import type { UsageReport } from '@shared/usage-report'

/**
 * The stacked bars of the costs page, one per day, drawn in SVG at the measured width so that the
 * text keeps its size. Hovering a day shows its breakdown; the table below the chart carries the same
 * numbers for anyone who cannot tell the colors apart.
 */

const HEIGHT = 190
const AXIS_WIDTH = 52
const AXIS_HEIGHT = 20
const TOP = 8
const GAP = 2

/** A round step for the grid lines, so the axis reads $0.5, $1, $1.5 rather than $0.47, $0.94. */
function niceStep(max: number, lines: number): number {
  const raw = max / lines
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = [1, 2, 2.5, 5, 10].find((f) => f * power >= raw) ?? 10
  return unit * power
}

export function UsageChart({
  report,
  label,
  formatUsd,
  formatDate
}: {
  report: UsageReport
  label: (seriesId: string) => string
  formatUsd: (value: number) => string
  formatDate: (date: string) => string
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const { dates, series } = report
  const totals = dates.map((_, i) => series.reduce((sum, s) => sum + s.values[i], 0))
  const peak = Math.max(...totals, 0)
  const step = peak > 0 ? niceStep(peak, 3) : 1
  const top = Math.max(step * Math.ceil(peak / step), step)
  const plotWidth = Math.max(width - AXIS_WIDTH, 0)
  const plotHeight = HEIGHT - AXIS_HEIGHT - TOP
  const band = dates.length > 0 ? plotWidth / dates.length : 0
  const barWidth = Math.max(Math.min(band * 0.7, 28), 2)
  const y = (value: number): number => TOP + plotHeight - (value / top) * plotHeight
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  // A label every day for a week, then about one a week, so the dates never run into each other.
  const labelEvery = dates.length <= 7 ? 1 : Math.ceil(dates.length / Math.max(Math.floor(plotWidth / 64), 1))

  return (
    <div className="st-usage-chart" ref={box} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={series.map((s) => `${label(s.id)} ${formatUsd(s.total)}`).join(', ')}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="st-usage-grid" x1={AXIS_WIDTH} x2={width} y1={y(tick)} y2={y(tick)} />
              <text className="st-usage-axis" x={AXIS_WIDTH - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {formatUsd(tick)}
              </text>
            </g>
          ))}
          {dates.map((date, i) => {
            const x = AXIS_WIDTH + i * band + (band - barWidth) / 2
            let base = 0
            const segments = series.filter((s) => s.values[i] > 0)
            return (
              <g key={date} data-active={hover === i || undefined}>
                {segments.map((s, index) => {
                  const y0 = y(base)
                  base += s.values[i]
                  const y1 = y(base)
                  // Each segment leaves a gap under the one above it; a sliver thinner than the gap is still drawn a pixel high.
                  const height = Math.max(y0 - y1 - (index < segments.length - 1 ? GAP : 0), 1)
                  const radius = index === segments.length - 1 ? Math.min(3, barWidth / 2, height) : 0
                  return <path key={s.id} className="st-usage-bar" data-slot={s.slot} d={barPath(x, y0 - height, barWidth, height, radius)} />
                })}
                {i % labelEvery === (dates.length - 1) % labelEvery && (
                  <text className="st-usage-axis" x={AXIS_WIDTH + i * band + band / 2} y={HEIGHT - 4} textAnchor="middle">
                    {formatDate(date)}
                  </text>
                )}
                <rect
                  className="st-usage-hit"
                  x={AXIS_WIDTH + i * band}
                  y={TOP}
                  width={band}
                  height={plotHeight}
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            )
          })}
        </svg>
      )}
      {hover !== null && totals[hover] > 0 && (
        <div
          className="st-usage-tip"
          style={{ left: Math.min(AXIS_WIDTH + hover * band + band / 2, width - 90), top: Math.max(y(totals[hover]) - 8, 0) }}
        >
          <strong>{formatDate(dates[hover])}</strong>
          {series
            .filter((s) => s.values[hover] > 0)
            .reverse()
            .map((s) => (
              <span key={s.id}>
                <i data-slot={s.slot} />
                {label(s.id)}
                <b>{formatUsd(s.values[hover])}</b>
              </span>
            ))}
          <span className="is-total">
            <b>{formatUsd(totals[hover])}</b>
          </span>
        </div>
      )}
    </div>
  )
}

/** A bar with its top corners rounded and its foot square on the baseline. */
function barPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = radius
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
}

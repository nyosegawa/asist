import type { ReactNode } from 'react'
import { ArrowRight, ChevronRight, ExternalLink } from 'lucide-react'
import './card.css'

/** Card parts shared by the cards, so that the shape settled on for weather and the exchange rate is drawn the same way everywhere. */

export function Box({
  title,
  note,
  label,
  className,
  children
}: {
  title: string
  note?: ReactNode
  /** The aria-label. It falls back to the title. */
  label?: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className={className ? `card-box ${className}` : 'card-box'} aria-label={label ?? title}>
      <h4>
        {title}
        {note !== undefined && note !== null && <small>{note}</small>}
      </h4>
      {children}
    </section>
  )
}

export function Facts({
  items,
  columns = 2
}: {
  items: Array<[string, ReactNode]>
  columns?: 1 | 2
}): React.JSX.Element {
  return (
    <dl className="card-facts" data-columns={columns}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A row that opens the focus view. It stands in for a section that s folds away. */
export function More({
  onClick,
  label,
  children
}: {
  onClick: () => void
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <button type="button" className="card-more" onClick={onClick} aria-label={label}>
      {children}
      <ChevronRight size={12} aria-hidden />
    </button>
  )
}

export function Row({
  index,
  aside,
  className,
  children
}: {
  index?: ReactNode
  aside?: ReactNode
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <li className={className ? `card-row ${className}` : 'card-row'}>
      {index !== undefined && <span className="card-row-index">{index}</span>}
      {children}
      {aside !== undefined && <span className="card-row-aside">{aside}</span>}
    </li>
  )
}

export function Actions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="card-actions">{children}</div>
}

export function Action({
  onClick,
  tone,
  disabled,
  label,
  leadsTo,
  children
}: {
  onClick: () => void
  /** Where the action takes the user: another screen of the app, or a page outside it. It is drawn as an icon after the text. */
  leadsTo?: 'screen' | 'outside'
  tone?: 'primary' | 'danger' | 'warm'
  disabled?: boolean
  label?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <button type="button" className="card-action" data-tone={tone} disabled={disabled} onClick={onClick} aria-label={label}>
      {children}
      {leadsTo === 'screen' && <ArrowRight size={12} aria-hidden />}
      {leadsTo === 'outside' && <ExternalLink size={12} aria-hidden />}
    </button>
  )
}

export function Chip({
  tone,
  children
}: {
  tone?: 'cyan' | 'mint' | 'peach' | 'red' | 'dim'
  children: ReactNode
}): React.JSX.Element {
  return (
    <span className="card-chip" data-tone={tone}>
      {children}
    </span>
  )
}

export function Empty({ children, note }: { children: ReactNode; note?: ReactNode }): React.JSX.Element {
  return (
    <div className="card-empty">
      {children}
      {note && <small>{note}</small>}
    </div>
  )
}

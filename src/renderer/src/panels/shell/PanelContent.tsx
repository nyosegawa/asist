import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PanelSpec } from '@shared/ipc'
import { cardDefinition } from '@/panels/registry'
import { useT } from '@/i18n'
import type { CardSurfaceSize } from './card'
import { PanelErrorBoundary } from './PanelErrorBoundary'

/** Handles the fetch state, render errors and the source line the same way in the normal and the focus view. */
export function PanelContent({
  spec,
  size
}: {
  spec: PanelSpec
  size: CardSurfaceSize
}): React.JSX.Element {
  const card = cardDefinition(spec.type)
  const t = useT()
  if (spec.state === 'skeleton' || spec.state === 'loading') {
    return (
      <div className="flex flex-col gap-2 py-1" role="status" aria-label={t('common.loading')}>
        <i className="skel block h-3 w-2/5" />
        <i className="skel block h-6 w-3/4" />
        <i className="skel block h-3 w-1/2" />
      </div>
    )
  }
  if (spec.state === 'error') {
    return (
      <div className="py-1 text-xs leading-relaxed text-holo-red/90" role="alert">
        {t('panels.loadFailed')}
        <div className="mt-1 font-mono text-[10px] text-holo-dim">{spec.error?.slice(0, 90)}</div>
      </div>
    )
  }
  return (
    <CardBox type={spec.type} size={size} scroll={card?.scroll ?? false}>
      {spec.state === 'stale' && (
        <div className="text-xs text-holo-dim" role="status">
          {t('panels.stale')}
        </div>
      )}
      <PanelErrorBoundary key={spec.key} panelType={spec.type} revision={spec.updatedAt}>
        {card ? (
          <card.Body spec={spec} size={size} />
        ) : (
          <pre className="max-h-40 overflow-auto font-mono text-[10px] text-holo-muted">
            {JSON.stringify(spec.props, null, 2)}
          </pre>
        )}
      </PanelErrorBoundary>
      {spec.source && (
        <div className="font-mono text-[9px] tracking-wide text-holo-dim">{spec.source}</div>
      )}
    </CardBox>
  )
}

/** How long overflow has to last before it counts as a defect. It only needs to outlast the re-render of a size change. */
export const OVERFLOW_SETTLE_MS = 250

/**
 * The box that holds the body. Whatever exceeds the height the shell gave stays inside it. A card marked
 * scroll scrolls internally; for any other card, content taller than the box is a defect in how the card is
 * built, so it is reported with console.error and outlined in red during development. The focus view is not
 * measured, because the whole overlay scrolls.
 */
function CardBox({
  type,
  size,
  scroll,
  children
}: {
  type: string
  size: CardSurfaceSize
  scroll: boolean
  children: ReactNode
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  const reported = useRef(false)

  useLayoutEffect(() => {
    if (size === 'focus') return
    const box = boxRef.current
    const inner = innerRef.current
    if (!box || !inner) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const overflowing = (): boolean => inner.offsetHeight > box.clientHeight + 1
    const settle = (): void => {
      timer = undefined
      const overflow = overflowing()
      setClipped(overflow)
      if (overflow && !scroll && !reported.current) {
        reported.current = true
        console.error(
          `card does not fit: ${type} size=${size} content ${inner.offsetHeight}px > box ${box.clientHeight}px`
        )
      }
    }
    const check = (): void => {
      if (!overflowing()) {
        clearTimeout(timer)
        timer = undefined
        reported.current = false
        setClipped(false)
        return
      }
      // While the window is being resized the content overflows for the instant before the size switches, so
      // the judgment waits until things settle.
      timer ??= setTimeout(settle, OVERFLOW_SETTLE_MS)
    }
    const observer = new ResizeObserver(check)
    observer.observe(box)
    observer.observe(inner)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [type, size, scroll])

  const clippedState = !clipped ? undefined : scroll ? 'scroll' : import.meta.env.DEV ? 'error' : undefined
  return (
    <div ref={boxRef} className="panel-body" data-scroll={scroll || undefined} data-clipped={clippedState}>
      <div ref={innerRef} className="panel-body-inner">
        {children}
      </div>
    </div>
  )
}

import { useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import type { PanelSlot } from '@shared/ipc'
import { usePanelStore } from '@/state/stores'
import { PanelCard } from '@/panels/shell/PanelCard'
import { cardSizeFor, type CardSize } from '@/panels/shell/card'

/**
 * The panel docks on the left and the right. Each one measures its own inner height to decide the
 * card size, and because both have the same height the cards on both sides come out the same size.
 */

const innerHeight = (element: HTMLElement): number => {
  const style = getComputedStyle(element)
  return element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
}

export function Dock({ slot }: { slot: PanelSlot }): React.JSX.Element {
  const panels = usePanelStore((s) => s.panels)
  const slotPanels = panels.filter((p) => p.slot === slot)
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<CardSize>('s')

  useLayoutEffect(() => {
    const dock = ref.current
    if (!dock) return
    // The first measurement is synchronous, before paint; after that the size follows the window.
    setSize(cardSizeFor(innerHeight(dock)))
    const observer = new ResizeObserver(([entry]) => setSize(cardSizeFor(entry.contentRect.height)))
    observer.observe(dock)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="dock" ref={ref} data-size={size}>
      <AnimatePresence mode="wait">
        {slotPanels.map((spec) => (
          <PanelCard key={spec.key} spec={spec} size={size} />
        ))}
      </AnimatePresence>
    </div>
  )
}

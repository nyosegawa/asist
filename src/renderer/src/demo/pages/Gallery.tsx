import { useState } from 'react'
import type { PanelSpec } from '@shared/ipc'
import { PanelCard } from '@/panels/shell/PanelCard'
import { CARD_S_MAX_HEIGHT, CARD_SIZE_MIN_HEIGHT, type CardSize } from '@/panels/shell/card'
import { cardDefinition } from '@/panels/registry'
import { useJobStore } from '@/state/stores'
import { FocusCard } from '@/ui/FocusOverlay'
import { createDemoTimer } from '../api'
import { CARD_GROUPS, STATE_GROUP, fixtureId, type CardFixture } from '../fixtures/cards'
import { DEMO_JOB, DEMO_JOB_LOG, DEMO_JOBS } from '../fixtures/jobs'
import './gallery.css'
import { useUiLocale } from '@/i18n'

/**
 * The card list. It draws the real cards, one column per size the shell hands out. A column is as tall
 * as the height a card may use at that size (shell/card.ts), so its frame shows whether the card fits.
 *
 * This is what the Shell loads into its iframe, either one sample (/preview/cards/files-pdf) or all of
 * them (/preview/cards). The ?type= filter is used by the capture script (demo:gallery).
 */

const COLUMNS: Array<{ size: CardSize; height: number }> = [
  { size: 's', height: CARD_S_MAX_HEIGHT },
  { size: 'm', height: CARD_SIZE_MIN_HEIGHT.m },
  { size: 'l', height: CARD_SIZE_MIN_HEIGHT.l }
]
/** The vertical padding of the dock (`.dock` in main.css), added to the inner height to size a column. */
const DOCK_PADDING = 18
const GROUPS = [...CARD_GROUPS, STATE_GROUP]

const specOf = (fixture: CardFixture): PanelSpec => ({
  key: `${fixtureId(fixture)}:demo`,
  type: fixture.type,
  slot: 'right',
  state: fixture.state ?? 'ready',
  error: fixture.error,
  props: fixture.props,
  source: fixture.source,
  createdAt: 1,
  updatedAt: 1
})

export function Gallery({ types, card }: { types: string[]; card: string | null }): React.JSX.Element {
  // A sample's source is written in the interface language, so the specs are built again when it changes.
  useUiLocale()
  // Sample jobs and timers for the cards that read a store or a timer. A card asks for timerList as it
  // mounts, so they have to be registered before the children, during the first render.
  useState(() => {
    const timer = CARD_GROUPS.flatMap((g) => g.cards).find((c) => c.type === 'timer')
    if (timer) createDemoTimer('timer:demo', timer.props)
    useJobStore.setState({
      jobs: DEMO_JOBS,
      logs: { [DEMO_JOB.id]: DEMO_JOB_LOG.map((event) => ({ t: Date.now(), event })) }
    })
    return true
  })
  const groups = GROUPS.map((group) => ({
    ...group,
    cards: group.cards.filter((fixture) => (card ? fixtureId(fixture) === card : types.length === 0 || types.includes(fixture.type)))
  })).filter((group) => group.cards.length > 0)

  return (
    <main className="gallery">
      <div className="gallery-main">
        <p className="gallery-note">
          Dock が渡すサイズごとに、本体のカードをそのまま描いています。点線の枠はそのサイズでカードが使える高さの上限で、はみ出すと下端が赤くなります。
        </p>
        {groups.map((group) => (
          <section key={group.label} className="gallery-group">
            <h2>
              {group.label} <small>{group.command}</small>
            </h2>
            {group.cards.map((fixture) => {
              const spec = specOf(fixture)
              return (
                <article key={fixtureId(fixture)} className="gallery-card" id={fixtureId(fixture)}>
                  <h3>
                    {cardDefinition(fixture.type)?.kicker ?? fixture.type.toUpperCase()} <small>{fixtureId(fixture)}</small>
                  </h3>
                  <div className="gallery-row">
                    {COLUMNS.map(({ size, height }) => (
                      <div key={size} className="gallery-column">
                        <div className="gallery-label">
                          {size} · {height}px
                        </div>
                        <div className="dock" data-size={size} style={{ height: height + DOCK_PADDING }}>
                          <PanelCard spec={spec} size={size} />
                        </div>
                      </div>
                    ))}
                    <div className="gallery-column is-focus">
                      <div className="gallery-label">focus</div>
                      <FocusCard spec={spec} onClose={() => {}} />
                    </div>
                  </div>
                </article>
              )
            })}
          </section>
        ))}
      </div>
    </main>
  )
}

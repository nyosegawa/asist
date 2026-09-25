import { CARD_GROUPS, STATE_GROUP, fixtureId } from './fixtures/cards'
import { cardPath, CARDS_PATH, screenPath } from './routes'
import { SCREENS, type ScreenGroup } from './screens'

/**
 * The list of samples shown down the left of the demo shell. It is built from the screens (screens.ts)
 * and the card samples (fixtures/cards.ts), so the list, the URLs and the entry point's branching all
 * read the same definitions.
 */
export interface CatalogEntry {
  /** The path in the shell's URL. Prefixing it with /preview gives the URL loaded in the iframe. */
  path: string
  label: string
  /** Tells apart samples of the same type, such as the pdf variant of files. */
  note?: string
  /** Whether resizing the window tells you anything. The card list is a tall page, so it follows the window instead. */
  sized: boolean
}

export interface CatalogGroup {
  label: string
  entries: CatalogEntry[]
}

const SCREEN_GROUPS: ScreenGroup[] = ['画面', '設定のページ', '起動と確認']

export const CATALOG: CatalogGroup[] = [
  ...SCREEN_GROUPS.map((group) => ({
    label: group,
    entries: Object.entries(SCREENS)
      .filter(([, screen]) => screen.group === group)
      .map(([name, screen]) => ({ path: screenPath(name), label: screen.label, sized: true }))
  })),
  { label: 'カード', entries: [{ path: CARDS_PATH, label: '全部', sized: false }] },
  ...[...CARD_GROUPS, STATE_GROUP].map((group) => ({
    label: group.label,
    entries: group.cards.map((fixture) => ({ path: cardPath(fixtureId(fixture)), label: fixture.type, note: fixture.variant, sized: false }))
  }))
]

export const findEntry = (path: string): CatalogEntry | undefined => CATALOG.flatMap((group) => group.entries).find((entry) => entry.path === path)

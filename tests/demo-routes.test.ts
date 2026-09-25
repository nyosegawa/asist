import { describe, expect, it } from 'vitest'
import { CATALOG } from '../src/renderer/src/demo/catalog'
import { fixtureId, CARD_GROUPS, STATE_GROUP } from '../src/renderer/src/demo/fixtures/cards'
import { HOME_ENTRY, previewPath, resolveDemoRoute } from '../src/renderer/src/demo/routes'
import { SCREENS } from '../src/renderer/src/demo/screens'

/** The rules for the demo URLs. These tests check that every sample listed in the shell really opens. */

const entries = CATALOG.flatMap((group) => group.entries)

describe('demo URLs', () => {
  it('resolves every listed sample, through its iframe URL, to a screen or card fixture that exists', () => {
    const fixtures = new Set([...CARD_GROUPS, STATE_GROUP].flatMap((group) => group.cards.map(fixtureId)))
    for (const entry of entries) {
      // A listed sample with no destination becomes an error screen when it is selected.
      expect(resolveDemoRoute(entry.path)).toEqual({ kind: 'shell', entry: entry.path })
      const preview = resolveDemoRoute(previewPath(entry.path))
      if (preview.kind === 'screen') expect(Object.keys(SCREENS)).toContain(preview.name)
      else if (preview.kind === 'cards') expect(preview.card === null || fixtures.has(preview.card)).toBe(true)
      else throw new Error(`${entry.path} の中身がフレームかアプリになっています`)
    }
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length)
  })

  it('starts at a listed sample and lists every screen and every card fixture', () => {
    expect(resolveDemoRoute('/')).toEqual({ kind: 'shell', entry: HOME_ENTRY })
    expect(entries.map((entry) => entry.path)).toContain(HOME_ENTRY)
    for (const name of Object.keys(SCREENS)) expect(entries.map((entry) => entry.path)).toContain(`/screens/${name}`)
    for (const group of [...CARD_GROUPS, STATE_GROUP]) for (const fixture of group.cards) expect(entries.map((entry) => entry.path)).toContain(`/cards/${fixtureId(fixture)}`)
  })

  it('reads nested names and a trailing slash without confusing the app with a preview', () => {
    expect(resolveDemoRoute('/app')).toEqual({ kind: 'app' })
    expect(resolveDemoRoute('/i18n')).toEqual({ kind: 'i18n' })
    expect(resolveDemoRoute('/preview/screens/setup/key-failed/')).toEqual({ kind: 'screen', name: 'setup/key-failed' })
    expect(resolveDemoRoute('/preview/cards')).toEqual({ kind: 'cards', card: null })
    expect(resolveDemoRoute('/preview/cards/files-pdf')).toEqual({ kind: 'cards', card: 'files-pdf' })
  })

  it('fails on an unknown path instead of quietly showing another sample', () => {
    for (const path of ['/gallery', '/screens', '/preview', '/preview/screens', '/application']) expect(() => resolveDemoRoute(path)).toThrow('ありません')
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultPersona, personaText } from '../src/shared/persona'
import { SETTINGS_FORMAT } from '../src/shared/settings'
import { openStoredContent } from '../src/shared/stored-format'

/**
 * Until version 11 the settings held the default persona as its text, in the language of the system or of the
 * setup, so a persona of an older file that equals a default was written by the app rather than by the user.
 */
describe('the persona of a settings file that held the default as its text', () => {
  const v10 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stored', 'settings.v10.json'), 'utf8')) as Record<string, unknown>
  const open = (patch: Record<string, unknown>) => openStoredContent(SETTINGS_FORMAT, { ...v10, ...patch }).value

  it.each([
    ['ja-JP', 'en-US'],
    ['en-US', 'ja-JP'],
    ['en-US', 'en-US']
  ] as const)('reads a default written in %s as the default, which a %s conversation reads in its own language', (written, conversationLocale) => {
    const settings = open({ persona: defaultPersona(written), conversationLocale })
    expect(settings.persona).toBeNull()
    expect(personaText(settings)).toBe(defaultPersona(conversationLocale))
  })

  it.each(['名前は ミナ。短く答える。', ''])('keeps a persona the user wrote, an empty one included: %j', (persona) => {
    expect(open({ persona, conversationLocale: 'en-US' }).persona).toBe(persona)
  })

  it('refuses a persona that is not text rather than reading it as the default', () => {
    expect(() => open({ persona: 42 })).toThrow()
  })
})

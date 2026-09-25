/**
 * The themes the whole UI can be drawn in. The settings keep the chosen one; the renderer draws it from the
 * tokens in src/renderer/src/assets/themes.css.
 */
export const THEMES = ['future', 'simple', 'pop', 'cool'] as const
export type ThemeName = (typeof THEMES)[number]

export const DEFAULT_THEME: ThemeName = 'future'

export const isThemeName = (value: string): value is ThemeName => (THEMES as readonly string[]).includes(value)

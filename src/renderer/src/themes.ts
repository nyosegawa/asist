import type { ThemeName } from '@shared/themes'

export { DEFAULT_THEME, THEMES, isThemeName, type ThemeName } from '@shared/themes'

/** Draws the UI in a theme. A theme swaps the values of the tokens in assets/themes.css; the components read only those tokens. */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
}

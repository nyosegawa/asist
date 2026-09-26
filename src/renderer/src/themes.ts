import type { ThemeName } from '@shared/themes'

export { DEFAULT_THEME, THEMES, isThemeName, type ThemeName } from '@shared/themes'

/**
 * Draws the UI in a theme. A theme swaps the values of the tokens in assets/themes.css; the components read
 * only those tokens. The window buttons Windows draws over the top bar are not part of the page, so the
 * main process is given their colour.
 */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
  void window.api.paintWindowControls({ symbol: tokenColor('--ui-text') })
}

/** A colour token of the theme on screen, resolved to rgb() whatever form the theme writes it in. */
function tokenColor(token: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

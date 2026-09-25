import type { Root } from 'react-dom/client'
import { defaultRegion } from '@shared/conversation-locale'
import type { UiLocale } from '@shared/i18n'
import { useSettingsStore } from '@/state/stores'
import { applyTheme, DEFAULT_THEME, isThemeName, THEMES, type ThemeName } from '@/themes'
import { mockApi, scriptSayings } from './api'
import { findEntry } from './catalog'
import { cardPath, resolveDemoRoute } from './routes'
import { SCREENS, type ScreenName } from './screens'
import { DEMO_VIEWS } from './views'

/**
 * The entry point of the demo mode. main.tsx calls it only when window.api is missing under the
 * development server. The path of the URL decides what is drawn, following the rules in routes.ts. A
 * return value of true means the page has already been rendered and the caller must not render the app.
 */
export async function bootDemo(root: Root): Promise<boolean> {
  window.api = mockApi
  const route = resolveDemoRoute(location.pathname)
  const screen = route.kind === 'screen' && route.name in SCREENS ? DEMO_VIEWS[route.name as ScreenName] : undefined
  // The capture scripts change the interface language of a page that is already open, which spares them from
  // loading every screen again for every language.
  Object.assign(window, {
    demoSetUiLocale: async (uiLocale: UiLocale): Promise<void> => {
      await mockApi.saveSettings({ uiLocale, region: defaultRegion(uiLocale) })
      await useSettingsStore.getState().load()
      // A sheet or a toast the demo opened holds text written when it was opened, as one from the main process does.
      screen?.open?.()
    },
    demoSetTheme: async (theme: ThemeName): Promise<void> => {
      // The cards page draws no App, which is what applies the saved theme, so the theme is drawn here as well.
      applyTheme(theme)
      await mockApi.saveSettings({ theme })
      await useSettingsStore.getState().load()
    }
  })
  console.info('ASIST: explicit development demo mode (no Electron preload)')
  const params = new URLSearchParams(location.search)
  const theme = params.get('theme') ?? DEFAULT_THEME
  if (!isThemeName(theme)) throw new Error(`テーマは ${THEMES.join(' / ')} で指定します: ${theme}`)
  applyTheme(theme)

  if (route.kind === 'shell') {
    if (!findEntry(route.entry)) throw new Error(`demo に ${route.entry} という見本はありません`)
    const { Shell } = await import('./pages/Shell')
    root.render(<Shell />)
    return true
  }
  if (route.kind === 'i18n') {
    const { I18nPage } = await import('./pages/I18nPage')
    root.render(<I18nPage />)
    return true
  }
  if (route.kind === 'cards') {
    if (route.card && !findEntry(cardPath(route.card))) throw new Error(`demo に ${route.card} というカードの見本はありません`)
    // The cards read the interface language from the settings, which only the app loads on its own.
    await useSettingsStore.getState().load()
    const { Gallery } = await import('./pages/Gallery')
    root.render(<Gallery types={params.getAll('type')} card={route.card} />)
    return true
  }

  const sayings = params.getAll('say').filter(Boolean)
  if (route.kind === 'screen') {
    if (!(route.name in SCREENS)) throw new Error(`demo に ${route.name} という画面はありません`)
    const target = DEMO_VIEWS[route.name as ScreenName]
    target.prepare?.(mockApi)
    // What a view opens is written in the interface language, which the settings hold.
    await useSettingsStore.getState().load()
    target.open?.()
    sayings.unshift(...(target.say ?? []))
  }
  scriptSayings(sayings)
  return false
}

import { defineRouteMiddleware } from '@astrojs/starlight/route-data'
import { LANGUAGES, ROOT_LANGUAGE, prefixOf } from './i18n/languages.mjs'

/** The logo of the documentation leads to the landing page in the same language, or to the Japanese one when there is none. */
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute
  const code = route.locale ?? ROOT_LANGUAGE
  const language = LANGUAGES.find((entry) => entry.code === code)
  route.siteTitleHref = language?.landing ? `${prefixOf(code)}/` : '/'
})

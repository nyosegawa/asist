/**
 * The languages of the site. Japanese is served at the root and the others under their code. `docs`
 * marks the languages the documentation is written in; the others reach it in English.
 */
export const LANGUAGES = [
  { code: 'ja', label: '日本語', docs: true },
  { code: 'en', label: 'English', docs: true }
]

export const ROOT_LANGUAGE = 'ja'

/** The path prefix of a language: nothing for the root language, `/en` and so on for the others. */
export const prefixOf = (code) => (code === ROOT_LANGUAGE ? '' : `/${code}`)

/** The same page in another language, for a path that starts with the prefix of `from`. */
export function pathIn(pathname, from, to) {
  const rest = pathname.slice(prefixOf(from).length) || '/'
  return `${prefixOf(to)}${rest}`
}

/**
 * The languages of the site. Japanese is served at the root and the others under their code. `landing`
 * marks the languages the landing page is written in, and `docs` those of the documentation; a page in a
 * language without documentation leads to the English documentation. `hreflang` is the tag search
 * engines and the html element read.
 */
export const LANGUAGES = [
  { code: 'ja', hreflang: 'ja', label: '日本語', landing: true, docs: true },
  { code: 'en', hreflang: 'en', label: 'English', landing: true, docs: true }
]

export const ROOT_LANGUAGE = 'ja'

/** The path prefix of a language: nothing for the root language, `/en` and so on for the others. */
export const prefixOf = (code) => (code === ROOT_LANGUAGE ? '' : `/${code}`)

/** The same page in another language, for a path that starts with the prefix of `from`. */
export function pathIn(pathname, from, to) {
  const rest = pathname.slice(prefixOf(from).length) || '/'
  return `${prefixOf(to)}${rest}`
}

/** Where the documentation is read from a page in this language. */
export function docsPrefixOf(code) {
  const language = LANGUAGES.find((entry) => entry.code === code)
  return language?.docs ? prefixOf(code) : prefixOf('en')
}

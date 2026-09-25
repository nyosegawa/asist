import { useMemo, useState } from 'react'
import { MESSAGES, UI_LOCALES, UI_LOCALE_NAMES, type UiLocale } from '@shared/i18n'
import type { Message, PluralForms } from '@shared/i18n/message'
import './i18n.css'

/**
 * Every message of the UI dictionary with its languages side by side (/i18n in the demo). The group and
 * the search text live in the query, so a view of the list can be shared as a URL.
 */

interface Row {
  group: string
  key: string
  message: Message
}

function rowsOf(node: unknown, group: string, prefix: string): Row[] {
  return Object.entries(node as Record<string, unknown>).flatMap(([name, value]) =>
    UI_LOCALES[0] in (value as object) ? [{ group, key: `${prefix}${name}`, message: value as Message }] : rowsOf(value, group, `${prefix}${name}.`)
  )
}

const ROWS: Row[] = Object.entries(MESSAGES).flatMap(([group, messages]) => rowsOf(messages, group, `${group}.`))
const GROUPS = Object.keys(MESSAGES).map((group) => ({ group, count: ROWS.filter((row) => row.group === group).length }))

const formsOf = (form: string | PluralForms): Array<[string | null, string]> =>
  typeof form === 'string' ? [[null, form]] : (Object.entries(form) as Array<[string, string]>)

function Text({ text }: { text: string }): React.JSX.Element {
  return <>{text.split(/(\{\w+\})/).map((part, index) => (/^\{\w+\}$/.test(part) ? <code key={index}>{part}</code> : part))}</>
}

function Forms({ form }: { form: string | PluralForms }): React.JSX.Element {
  return (
    <>
      {formsOf(form).map(([category, text]) => (
        <p key={category ?? 'text'}>
          {category && <span className="i18n-plural">{category}</span>}
          <Text text={text} />
        </p>
      ))}
    </>
  )
}

/** Side by side, a column of text stays readable up to this many languages; beyond it the languages of a message are stacked. */
const MAX_COLUMNS = 3
const SOURCE_PAIR: UiLocale[] = ['ja-JP', 'en-US']
/** The language subtag, with the region only where two languages of the list share the subtag. */
const shortName = (locale: UiLocale): string => {
  const language = locale.split('-')[0]
  return UI_LOCALES.filter((one) => one.startsWith(`${language}-`)).length > 1 || locale === 'pt-BR' ? locale : language
}

function readLocales(params: URLSearchParams): UiLocale[] {
  const asked = params.get('langs')?.split(',') ?? []
  const chosen = UI_LOCALES.filter((locale) => asked.includes(locale))
  return chosen.length ? chosen : [...UI_LOCALES]
}

export function I18nPage(): React.JSX.Element {
  const params = new URLSearchParams(location.search)
  const [group, setGroup] = useState(params.get('group') ?? '')
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [locales, setLocales] = useState<UiLocale[]>(() => readLocales(params))

  const remember = (nextGroup: string, nextQuery: string, nextLocales: UiLocale[] = locales): void => {
    const next = new URLSearchParams()
    if (nextGroup) next.set('group', nextGroup)
    if (nextQuery) next.set('q', nextQuery)
    if (nextLocales.length < UI_LOCALES.length) next.set('langs', nextLocales.join(','))
    history.replaceState(null, '', `${location.pathname}${next.size ? `?${next}` : ''}`)
  }
  const show = (next: UiLocale[]): void => {
    if (next.length === 0) return
    setLocales(next)
    remember(group, query, next)
  }
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return ROWS.filter((row) => !group || row.group === group).filter(
      (row) => !needle || row.key.toLowerCase().includes(needle) || UI_LOCALES.some((locale) => formsOf(row.message[locale]).some(([, text]) => text.toLowerCase().includes(needle)))
    )
  }, [group, query])

  return (
    <div className="i18n">
      <aside className="i18n-side">
        <a className="i18n-home" href="/">← demo</a>
        <h1>文言の一覧</h1>
        <button className={group === '' ? 'on' : ''} onClick={() => { setGroup(''); remember('', query) }}>
          すべて <span>{ROWS.length}</span>
        </button>
        {GROUPS.map((entry) => (
          <button key={entry.group} className={group === entry.group ? 'on' : ''} disabled={entry.count === 0} onClick={() => { setGroup(entry.group); remember(entry.group, query) }}>
            {entry.group} <span>{entry.count}</span>
          </button>
        ))}
      </aside>
      <main className="i18n-main">
        <header>
          <input type="search" placeholder="キーか文言で絞り込む" aria-label="キーか文言で絞り込む" value={query} onChange={(event) => { setQuery(event.target.value); remember(group, event.target.value) }} />
          <span className="i18n-count">{rows.length} 件</span>
        </header>
        <div className="i18n-locales" role="group" aria-label="表示する言語">
          {UI_LOCALES.map((locale) => (
            <button key={locale} type="button" aria-pressed={locales.includes(locale)} title={UI_LOCALE_NAMES[locale]} onClick={() => show(UI_LOCALES.filter((one) => (one === locale ? !locales.includes(one) : locales.includes(one))))}>
              {shortName(locale)}
            </button>
          ))}
          <span className="i18n-presets">
            <button type="button" onClick={() => show(SOURCE_PAIR)}>日英だけ</button>
            <button type="button" onClick={() => show([...UI_LOCALES])}>すべて</button>
          </span>
        </div>
        {locales.length <= MAX_COLUMNS ? (
          <table>
            <thead>
              <tr>
                <th>キー</th>
                {locales.map((locale) => <th key={locale}>{UI_LOCALE_NAMES[locale]}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th>{row.key.slice(row.group.length + 1) || row.key}<small>{row.group}</small></th>
                  {locales.map((locale) => <td key={locale}><Forms form={row.message[locale]} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="i18n-stack">
            {rows.map((row) => (
              <li key={row.key}>
                <h2>{row.key.slice(row.group.length + 1) || row.key}<small>{row.group}</small></h2>
                <dl>
                  {locales.map((locale) => (
                    <div key={locale} lang={locale}>
                      <dt title={UI_LOCALE_NAMES[locale]}>{shortName(locale)}</dt>
                      <dd><Forms form={row.message[locale]} /></dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
        {rows.length === 0 && <p className="i18n-empty">当てはまる文言がありません</p>}
      </main>
    </div>
  )
}

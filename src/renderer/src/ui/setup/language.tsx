import { UI_LOCALES, UI_LOCALE_NAMES, type UiLocale } from '@shared/i18n'
import { useT } from '@/i18n'

/**
 * The first screen of the setup. One choice sets the interface, the conversation and the region at
 * once, because the language decides which speech engines and which extra models the rest of the
 * setup has to offer. Each language is named in itself, so someone who cannot read the current
 * language of the screen still finds their own.
 */
export function LanguageStep({ locale, onLocale }: { locale: UiLocale; onLocale: (locale: UiLocale) => void }): React.JSX.Element {
  const t = useT()
  return (
    <div className="su-stack">
      <div className="su-languages" role="radiogroup" aria-label={t('setup.language.groupLabel')}>
        {UI_LOCALES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={locale === candidate}
            className="su-language"
            data-locale={candidate}
            onClick={() => onLocale(candidate)}
          >
            {UI_LOCALE_NAMES[candidate]}
          </button>
        ))}
      </div>
      <p className="su-hint">{t('setup.language.changeLater')}</p>
    </div>
  )
}

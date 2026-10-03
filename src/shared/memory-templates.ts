import type { ConversationLocale } from './conversation-locale'
import jaJpPage from '../../resources/skills/memory-templates/ja-JP/page.md?raw'
import jaJpJournal from '../../resources/skills/memory-templates/ja-JP/journal.md?raw'
import enUsPage from '../../resources/skills/memory-templates/en-US/page.md?raw'
import enUsJournal from '../../resources/skills/memory-templates/en-US/journal.md?raw'
import frFrPage from '../../resources/skills/memory-templates/fr-FR/page.md?raw'
import frFrJournal from '../../resources/skills/memory-templates/fr-FR/journal.md?raw'
import deDePage from '../../resources/skills/memory-templates/de-DE/page.md?raw'
import deDeJournal from '../../resources/skills/memory-templates/de-DE/journal.md?raw'
import hiInPage from '../../resources/skills/memory-templates/hi-IN/page.md?raw'
import hiInJournal from '../../resources/skills/memory-templates/hi-IN/journal.md?raw'
import idIdPage from '../../resources/skills/memory-templates/id-ID/page.md?raw'
import idIdJournal from '../../resources/skills/memory-templates/id-ID/journal.md?raw'
import itItPage from '../../resources/skills/memory-templates/it-IT/page.md?raw'
import itItJournal from '../../resources/skills/memory-templates/it-IT/journal.md?raw'
import koKrPage from '../../resources/skills/memory-templates/ko-KR/page.md?raw'
import koKrJournal from '../../resources/skills/memory-templates/ko-KR/journal.md?raw'
import ptBrPage from '../../resources/skills/memory-templates/pt-BR/page.md?raw'
import ptBrJournal from '../../resources/skills/memory-templates/pt-BR/journal.md?raw'
import es419Page from '../../resources/skills/memory-templates/es-419/page.md?raw'
import es419Journal from '../../resources/skills/memory-templates/es-419/journal.md?raw'
import esEsPage from '../../resources/skills/memory-templates/es-ES/page.md?raw'
import esEsJournal from '../../resources/skills/memory-templates/es-ES/journal.md?raw'

/**
 * The templates of the two kinds of document that search reads, a page and a journal entry, as text, in every
 * conversation language. The memory is written in the language of the conversation, and the curation copies the
 * headings of the templates of that language, which installSkill puts in its skill, exactly as they stand; ASIST
 * reads them here to tell such a heading from one the curation chose.
 */
export const SEARCHED_TEMPLATES: Readonly<Record<ConversationLocale, { readonly page: string; readonly journal: string }>> = {
  'ja-JP': { page: jaJpPage, journal: jaJpJournal },
  'en-US': { page: enUsPage, journal: enUsJournal },
  'fr-FR': { page: frFrPage, journal: frFrJournal },
  'de-DE': { page: deDePage, journal: deDeJournal },
  'hi-IN': { page: hiInPage, journal: hiInJournal },
  'id-ID': { page: idIdPage, journal: idIdJournal },
  'it-IT': { page: itItPage, journal: itItJournal },
  'ko-KR': { page: koKrPage, journal: koKrJournal },
  'pt-BR': { page: ptBrPage, journal: ptBrJournal },
  'es-419': { page: es419Page, journal: es419Journal },
  'es-ES': { page: esEsPage, journal: esEsJournal }
}

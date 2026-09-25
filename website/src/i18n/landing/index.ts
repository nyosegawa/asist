import type { LandingText } from './ja'
import { ja } from './ja'
import { en } from './en'
import { fr } from './fr'
import { de } from './de'
import { es } from './es'
import { it } from './it'
import { ptBr } from './pt-br'
import { ko } from './ko'
import { hi } from './hi'
import { id } from './id'

/** The landing page's text by language code; every language marked `landing` in languages.mjs has one. */
export const LANDING: Record<string, LandingText> = { ja, en, fr, de, es, it, 'pt-br': ptBr, ko, hi, id }

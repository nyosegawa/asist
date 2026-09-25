import type { LandingText } from './ja'
import { ja } from './ja'
import { en } from './en'

/** The landing page's text by language code; every language marked `landing` in languages.mjs has one. */
export const LANDING: Record<string, LandingText> = { ja, en }

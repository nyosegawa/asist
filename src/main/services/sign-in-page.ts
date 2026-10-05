import { t } from './i18n'

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The page the browser shows when a sign-in sends it back to ASIST, with the text `say` gives in the language of the interface. */
export function signInPage(say: (signedIn: boolean) => string): (signedIn: boolean) => string {
  return (signedIn) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>ASIST</title></head><body><p>${escapeHtml(say(signedIn))}</p></body></html>`
}

export const googleSignInPage = signInPage((signedIn) => t(signedIn ? 'calendar.google.browserDone' : 'calendar.google.browserFailed'))

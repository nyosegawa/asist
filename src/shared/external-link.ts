/**
 * The schemes the app hands to macOS: a web page opens in the browser and a mail address in the mail
 * app. Any other scheme, such as file: or one an installed application registered, would open a local
 * file or start that application.
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Whether url is a link the app opens outside itself. */
export function isExternalLink(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

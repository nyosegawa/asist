/**
 * Whether url is the renderer page the main window loads, the only page trusted with the preload
 * bridge. The packaged page is a file and matches by path, so another local HTML file dropped on the
 * window does not; the development page is served by Vite and matches by origin.
 */
export function isAppPage(url: string, appPage: string): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  const page = new URL(appPage)
  if (page.protocol === 'file:') return target.protocol === 'file:' && target.pathname === page.pathname
  return target.origin === page.origin
}

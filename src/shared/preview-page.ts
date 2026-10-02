/**
 * The page the files card's viewers do their heavy work in, inside a hidden iframe: parsing a document,
 * decoding its pictures, drawing its pages. main serves it on a scheme of its own, a site apart from the app's
 * page, so that Chromium runs the frame in a process of its own and a file that takes it out of memory ends
 * the frame rather than the app's page. The app's CSP names the origin in frame-src as well.
 */
export const PREVIEW_ORIGIN = 'asist-preview://app'

/** The page's path in the renderer's build, and its name under the origin. */
export const PREVIEW_PAGE = 'preview.html'

export const PREVIEW_PAGE_URL = `${PREVIEW_ORIGIN}/${PREVIEW_PAGE}`

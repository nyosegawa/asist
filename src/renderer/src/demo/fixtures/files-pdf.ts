import type { FileItem } from '@shared/files'

/**
 * The PDF sample. demo-public/demo-files/pdf/competitors.pdf is a hand-written PDF of three pages that
 * holds text, rectangles and the metadata Title "競合サービスの比較" ("comparison of competing
 * services").
 */
export const DEMO_PDF_DIR = '/Users/demo/Documents'

export const DEMO_PDF_ITEMS: FileItem[] = [
  {
    path: `${DEMO_PDF_DIR}/competitors.pdf`,
    name: 'competitors.pdf',
    kind: 'pdf',
    sizeBytes: 2187,
    modifiedAt: Date.now() - 4 * 3600_000,
    url: '/demo-files/pdf/competitors.pdf'
  }
]

export const DEMO_PDF_PATHS = DEMO_PDF_ITEMS.map((item) => item.path)

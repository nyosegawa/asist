/**
 * The Excel viewer reads only the sheet it shows, in the preview iframe, and the focus view draws only the rows
 * within a screen of its grid, which scrolls on its own. The default check would take the sticky header row for
 * content and pass a screen whose rows have not arrived yet, so this one asks for every row of the table in view
 * to have arrived, and for one of them to show text. At the end of the grid it also asks for row 40,001 of the sheet
 * or a later one, which both workbooks' first sheets reach: the viewer before this one showed the first 500 rows in
 * the focus view, so going back to it fails here whatever the runner's speed. Its times would fail only the five
 * sheets: on the M5 it showed them after 5.3 s and held the page for 2.6 to 2.7 s, past the scene's limits, and
 * showed the 50,000 rows after 1.4 s, held the page for 0.75 to 0.80 s and grew it by 540 MB, within them.
 *
 * In three runs on an M5 under a load average of 42 to 43 on 2026-10-02, both workbooks showed their first rows in
 * the card in 265 to 538 ms and in the focus view in 60 to 101 ms, held the page for at most 24 ms in the card and
 * 48 to 214 ms in the focus view, took at most 65 ms for a screen, and grew the renderers by 213 to 243 MB at the
 * peak and 46 to 159 MB at the end, of which the preview iframe's own process is about 140 MB. The longest blocks
 * of the focus view ran no script and laid nothing out, which is the page waiting for the processor. On GitHub's
 * macOS runner the same day, the renderers grew by 409 to 412 MB at the peak and 172 to 289 MB at the end. On the
 * M5, the viewer that parsed the whole workbook on the page grew them by 540 MB on 50,000 rows and by 896 MB on the
 * five sheets.
 */
function shown(root, mode) {
  const frame = root.querySelector('.fv-frame')
  if (!frame || window.__budgetRefusal(root)) return false
  const loading = window.demoText('files.viewer.loading')
  if ([...frame.querySelectorAll('.fv-note')].some((note) => note.textContent.trim() === loading)) return false
  const box = frame.querySelector(mode === 'focus' ? '.fv-xlsx-grid' : '.fv-scroll')
  if (!box) return false
  const clip = box.getBoundingClientRect()
  const outer = root.getBoundingClientRect()
  const top = Math.max(clip.top, outer.top)
  const bottom = Math.min(clip.bottom, outer.bottom, innerHeight)
  const rows = [...frame.querySelectorAll('.fv-table tbody:not([aria-hidden]) tr')].filter((row) => {
    const r = row.getBoundingClientRect()
    return Math.min(r.bottom, bottom) - Math.max(r.top, top) >= 1
  })
  if (rows.length === 0 || rows.some((row) => row.dataset.loading === 'true') || rows.every((row) => row.textContent.trim() === '')) return false
  const atEnd = mode === 'focus' && box.scrollTop + box.clientHeight >= box.scrollHeight - 2
  return !atEnd || rows.some((row) => Number(row.getAttribute('aria-rowindex')) >= 40_001)
}

const budget = { cardFirstMs: 1000, cardHeldMs: 150, cardPeakMb: 300, focusFirstMs: 1000, focusHeldMs: 150, slowestScreenMs: 300, peakMb: 500, finalMb: 350 }

export const cases = [
  { name: 'xlsx-50k', file: 'xlsx-50k', shown, budget },
  { name: 'xlsx-sheets', file: 'xlsx-sheets', shown, budget }
]

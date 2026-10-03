import { bodyStart, parsePage } from './memory-format'
import pageTemplateJa from '../../resources/skills/memory-curation/assets/templates/page.md?raw'
import pageTemplateEn from '../../resources/skills/memory-curation-en/assets/templates/page.md?raw'

/**
 * A page the memory screen made before it opened new pages empty started as the curation's page template, the
 * Japanese one in a Japanese conversation and the English one in any other, and kept the template's example
 * sentences wherever the user did not write over them. They are instructions to the curation, not memory, and
 * search read them as memory: 「あの案件の目的と決まったことを教えて」 brought the template's middle section of such a page
 * into the conversation, and 「私から見てどういう存在かな」 its impression (2026-10-03). The curation leaves them,
 * since it keeps what it finds the user wrote.
 */

const sectionKey = (heading: string, text: string): string => `${heading}\n${text}`

/** Each section of the two templates, by its heading and its example text, as a page made from one reads it. */
const EXAMPLE_SECTIONS: ReadonlySet<string> = new Set(
  [pageTemplateJa, pageTemplateEn].flatMap((template) => parsePage(template, '').sections.map(({ heading, text }) => sectionKey(heading, text)))
)

/**
 * The page without the sections that still hold a template's heading and example text as they stood, or null when
 * no section with text is left, which is a page the user never wrote in. Every other line stays as it is, so a
 * section the user changed in any way, its heading included, stays whole. A page with nothing to remove comes back
 * unchanged.
 */
export function withoutExampleText(markdown: string): string | null {
  const examples = new Set(
    parsePage(markdown, '')
      .sections.filter(({ heading, text }) => EXAMPLE_SECTIONS.has(sectionKey(heading, text)))
      .map(({ line }) => line - 1)
  )
  if (examples.size === 0) return markdown
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const from = bodyStart(lines)
  // A section runs from its `## ` line up to the next one, the way parsePage reads it.
  let removing = false
  const kept = lines.filter((line, index) => {
    if (index >= from && /^## /.test(line)) removing = examples.has(index)
    return !removing
  })
  while (kept.length > 0 && !kept[kept.length - 1].trim()) kept.pop()
  const page = `${kept.join(eol)}${eol}`
  return parsePage(page, '').sections.length === 0 ? null : page
}

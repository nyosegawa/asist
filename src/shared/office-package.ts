import { errorKey } from './i18n/error-key'
import type { ZipEntry } from './zip-directory'

/**
 * What the preview page's Office viewers read of an Office package: the attributes of its small XML parts, the
 * relationships between parts and which part holds each sheet of a workbook. And the last size net, which keeps the
 * files card from reading a part far beyond anything realistic, decided from the names and sizes the zip's directory
 * declares alone, so that the viewers refuse, and main tells the model, the same files from the same directory
 * without main reading any part of the user's file.
 */

const MB = 1024 * 1024

/**
 * The largest XML of a sheet, or of the shared strings every sheet of a workbook uses, that the Excel viewer reads:
 * far beyond a real sheet, of which 50,000 rows of sales records are 18 MB of XML, and still within what the preview
 * page can hold while it indexes it.
 */
export const SHEET_XML_LIMIT = 256 * MB

/**
 * The most XML the parts of a Word document may declare together before the viewer says it is too large to show
 * rather than read any of it. A 300-page report holds 1.1 MB, so this stops only a file far beyond anything written
 * by hand.
 */
export const DOCUMENT_XML_LIMIT = 128 * MB

const damaged = (): Error => new Error(errorKey('files.errors.zipDamaged'))

const ENTITY = /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([\da-fA-F]+));/g
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
/** The escape OOXML writes a character that XML cannot hold with, such as _x000D_ for a carriage return. */
const OOXML_ESCAPE = /_x([\da-fA-F]{4})_/g

/** The text of XML character data or an attribute value, with its references and OOXML's escapes undone, as SheetJS does. */
export function unescapeXml(text: string): string {
  if (!text.includes('&') && !text.includes('_x')) return text
  return text
    .replace(ENTITY, (_, name: string | undefined, decimal: string | undefined, hex: string | undefined) =>
      name ? NAMED_ENTITIES[name] : String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex!, 16))
    )
    .replace(OOXML_ESCAPE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** The attributes of a tag, by their local names. */
export function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, name, double, single] of tag.matchAll(ATTRIBUTE)) found.set(name.slice(name.indexOf(':') + 1), unescapeXml(double ?? single))
  return found
}

/**
 * Every start tag of an element of this local name, self-closing or not, as its attributes. A tag never holds a <,
 * which XML allows neither between attributes nor in a value, so each try stops at the next one and the search takes
 * time in proportion to the text; letting a try run to the end of the text took 10.7 s on 256 KB of tags that never
 * closed (2026-10-03).
 */
export function tags(xml: string, local: string): Array<Map<string, string>> {
  const tag = new RegExp(`<(?:[\\w.-]+:)?${local}(?=[\\s/>])((?:[^<>"']|"[^<"]*"|'[^<']*')*)>`, 'g')
  return Array.from(xml.matchAll(tag), ([, inside]) => attributes(inside))
}

/** A part's relationships: what each Id points at and the type of the relationship. */
export function parseRelationships(xml: string): Array<{ id: string; type: string; target: string }> {
  return tags(xml, 'Relationship').flatMap((found) => {
    const id = found.get('Id')
    const type = found.get('Type')
    const target = found.get('Target')
    // A link to something outside the package, such as a hyperlink's web page, names no part.
    if (id === undefined || type === undefined || target === undefined || found.get('TargetMode') === 'External') return []
    return [{ id, type, target }]
  })
}

/**
 * A relationship's target as the name of a part in the zip, from the folder of the part that holds the
 * relationship. Part names inside a zip are URIs, written with / on every OS, so they are joined as such.
 */
export function resolvePart(folder: string, target: string): string {
  const parts = target.startsWith('/') ? [] : folder.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

/** The folder of a part and the name of the part that holds its relationships. */
export function relationshipsOf(part: string): { folder: string; relationships: string } {
  const slash = part.lastIndexOf('/')
  const folder = part.slice(0, slash + 1)
  return { folder, relationships: `${folder}_rels/${part.slice(slash + 1)}.rels` }
}

/** The sheets of a workbook in their order, with the relationship that names each one's part, and its date system. */
export function parseWorkbook(xml: string): { sheets: Array<{ name: string; id: string }>; date1904: boolean } {
  const sheets = tags(xml, 'sheet').map((found) => {
    const name = found.get('name')
    const id = found.get('id')
    if (name === undefined || id === undefined) throw damaged()
    return { name, id }
  })
  const date1904 = tags(xml, 'workbookPr').some((found) => ['1', 'true'].includes(found.get('date1904') ?? ''))
  return { sheets, date1904 }
}

/** The relationship types end in the same name in the transitional and the strict schema. */
const isType = (type: string, name: string): boolean => type.endsWith(`/${name}`)

/** The parts of a workbook: each sheet's, in the workbook's order, and those of its shared strings and styles. */
export interface WorkbookParts {
  sheets: Array<{ name: string; part: string }>
  strings: string | null
  styles: string | null
  date1904: boolean
}

/**
 * Finds the parts of the workbook in a package whose zip holds the parts `names`, reading the package's
 * relationships, the workbook and its relationships with `readText`. Part names compare without case in a package,
 * as SheetJS compares them, and a relationship can name worksheets/Sheet1.xml where the zip holds
 * worksheets/sheet1.xml, so every part found is named as the zip names it.
 */
export async function readWorkbookParts(names: Iterable<string>, readText: (part: string) => Promise<string>): Promise<WorkbookParts> {
  const byLowerName = new Map([...names].map((name) => [name.toLowerCase(), name]))
  const partNamed = (name: string): string => byLowerName.get(name.toLowerCase()) ?? name
  const officeDocument = parseRelationships(await readText(partNamed('_rels/.rels'))).find(({ type }) => isType(type, 'officeDocument'))
  if (!officeDocument) throw damaged()
  const workbookPart = partNamed(resolvePart('', officeDocument.target))
  const { folder, relationships } = relationshipsOf(workbookPart)
  const [workbook, workbookRelationships] = await Promise.all([readText(workbookPart).then(parseWorkbook), readText(partNamed(relationships)).then(parseRelationships)])
  const partOf = (type: string): string | null => {
    const found = workbookRelationships.find((relationship) => isType(relationship.type, type))
    return found ? partNamed(resolvePart(folder, found.target)) : null
  }
  const sheets = workbook.sheets.map(({ name, id }) => {
    const found = workbookRelationships.find((relationship) => relationship.id === id)
    if (!found) throw damaged()
    return { name, part: partNamed(resolvePart(folder, found.target)) }
  })
  return { sheets, strings: partOf('sharedStrings'), styles: partOf('styles'), date1904: workbook.date1904 }
}

/** Whether a part declares more XML than SHEET_XML_LIMIT. A part the zip does not have does not, and reading it says it is missing. */
export const partTooLarge = (entries: ReadonlyMap<string, ZipEntry>, part: string): boolean => (entries.get(part)?.size ?? 0) > SHEET_XML_LIMIT

/**
 * What the size net leaves unread of a file the card shows: nothing, the whole file, or, of a workbook, the sheets
 * that are over the limit, while the card shows the others.
 */
export type LeftOut = 'nothing' | 'file' | 'someSheets'

/** The XML parts of a zip, and the relationships between them. */
const XML_PART = /\.(?:xml|rels)$/i

/** What the Word viewer leaves unread: the whole document when its XML parts declare more than DOCUMENT_XML_LIMIT together. */
export function documentLeftOut(entries: ReadonlyMap<string, ZipEntry>): LeftOut {
  let xml = 0
  for (const { name, size } of entries.values()) if (XML_PART.test(name)) xml += size
  return xml > DOCUMENT_XML_LIMIT ? 'file' : 'nothing'
}

/**
 * The parts of a workbook the Excel viewer reads whole whichever sheet it shows, and those that hold a sheet, by the
 * names Excel and every common writer (openpyxl, XlsxWriter, SheetJS, pandas) give them, compared without case as
 * part names are. The viewer finds each sheet's part from the workbook's relationships, and still refuses one of
 * another name that is over the limit when it comes to read it; the net decides here from the names alone, since main
 * reads no part of the file.
 */
const WHOLE_WORKBOOK_PARTS = new Set(['_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedstrings.xml', 'xl/styles.xml'])
const WORKSHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/i

/**
 * What the Excel viewer leaves unread: the whole workbook when a part it reads for every sheet, such as the shared
 * strings or the styles, is over SHEET_XML_LIMIT, and the sheets whose own XML is over it, while it shows the others.
 */
export function workbookLeftOut(entries: ReadonlyMap<string, ZipEntry>): LeftOut {
  let someSheets = false
  for (const { name, size } of entries.values()) {
    if (size <= SHEET_XML_LIMIT) continue
    if (WHOLE_WORKBOOK_PARTS.has(name.toLowerCase())) return 'file'
    if (WORKSHEET_PART.test(name)) someSheets = true
  }
  return someSheets ? 'someSheets' : 'nothing'
}

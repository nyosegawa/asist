import { errorText } from './i18n/error-text'

/**
 * The form of a JSON file under userData, and how each older form becomes the current one. The file
 * holds an object whose `version` names its form. A file without one was written before forms had
 * versions, and is version 1.
 */
export interface StoredFormat<T> {
  /** The file's name, as the messages show it. */
  name: string
  /** The current version. Any change to the form raises it, an added field included. */
  version: number
  /**
   * upgrades[n] turns the content of version n into that of version n + 1, both without `version`.
   * Every step since version 1 stays, so that a file of any released version can still be read.
   */
  upgrades: Readonly<Record<number, (content: unknown) => unknown>>
  /** Checks the content of the current version, without `version`, and returns the value it holds. */
  parse: (content: unknown) => T
  /** The content written for a value, without `version`. */
  serialize: (value: T) => Record<string, unknown>
}

export interface OpenedContent<T> {
  value: T
  /** The version the file was written in. It is older than the current one when the content was upgraded. */
  storedVersion: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Reads what a file holds, upgrading it one version at a time. A version newer than the app knows is
 * refused rather than read, because the app would drop the fields it does not know when it writes the
 * file back.
 */
export function openStoredContent<T>(format: StoredFormat<T>, stored: unknown): OpenedContent<T> {
  let version = 1
  let content = stored
  if (isRecord(stored) && 'version' in stored) {
    const { version: written, ...rest } = stored
    if (typeof written !== 'number' || !Number.isInteger(written) || written < 1) {
      throw new Error(errorText('app.storage.versionInvalid', { file: format.name, version: String(written) }))
    }
    version = written
    content = rest
  }
  if (version > format.version) {
    throw new Error(errorText('app.storage.versionTooNew', { file: format.name, version, supported: format.version }))
  }
  for (let from = version; from < format.version; from += 1) {
    const upgrade = format.upgrades[from]
    if (!upgrade) throw new Error(errorText('app.storage.upgradeMissing', { file: format.name, version: from }))
    content = upgrade(content)
  }
  return { value: format.parse(content), storedVersion: version }
}

/** The object a file is written as: the current version and the value's content. */
export function storedContent<T>(format: StoredFormat<T>, value: T): Record<string, unknown> {
  return { version: format.version, ...format.serialize(value) }
}

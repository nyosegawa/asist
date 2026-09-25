import fs from 'node:fs'
import { z } from 'zod'
import { errorText } from '@shared/i18n/error-text'
import { storedContent, type StoredFormat } from '@shared/stored-format'
import { dataPath, writeJson } from './store'
import { openStoredFileSync } from './stored-file'

/** The state of the daily memory curation: the last day it covered, and the last failure since a success. */

const STATE_FILE = 'memory-curation.json'
const stateSchema = z.object({
  curatedThrough: z.iso.date().nullable(),
  pendingFrom: z.iso.date().nullable(),
  /** The last curation that failed since the last success, which the settings screen reports. */
  lastFailure: z.object({ at: z.number(), message: z.string() }).strict().nullable()
}).strict()
export type CurationState = z.infer<typeof stateSchema>
const EMPTY_STATE: CurationState = { curatedThrough: null, pendingFrom: null, lastFailure: null }

export const CURATION_STATE_FORMAT: StoredFormat<CurationState> = {
  name: STATE_FILE,
  version: 1,
  upgrades: {},
  parse: (content) => {
    const parsed = stateSchema.safeParse(content)
    if (parsed.success) return parsed.data
    throw new Error(
      errorText('memory.errors.stateFileInvalid', {
        file: dataPath(STATE_FILE),
        details: parsed.error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('\n')
      })
    )
  },
  serialize: (state) => ({ ...state })
}

export function readState(): CurationState {
  const file = dataPath(STATE_FILE)
  let source: string
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE
    throw error
  }
  return openStoredFileSync(file, JSON.parse(source) as unknown, CURATION_STATE_FORMAT)
}

export function writeState(patch: Partial<CurationState>): void {
  writeJson(STATE_FILE, storedContent(CURATION_STATE_FORMAT, { ...readState(), ...patch }))
}

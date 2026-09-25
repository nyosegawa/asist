import { localDateKey } from './local-date'

/**
 * The file-independent part of the app log. Users attach the log to bug reports, so secret values such
 * as API keys are redacted before anything is written.
 */

/** Daily files older than this many days are deleted when the date changes. */
export const APP_LOG_RETENTION_DAYS = 14

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type AppLogSource = 'main' | 'renderer'

/** Environment variables whose values are redacted. */
const SECRET_ENV_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/
/** Shorter values are left alone: replacing a short string would corrupt unrelated text. */
const SECRET_MIN_LENGTH = 8

/** The values to redact, longest first: secret variables of the environment, and secrets kept outside it. */
export function secretValues(env: Record<string, string | undefined>, others: readonly string[] = []): string[] {
  return [
    ...Object.entries(env).flatMap(([name, value]) => (SECRET_ENV_NAME.test(name) && value ? [value] : [])),
    ...others
  ]
    .filter((value) => value.length >= SECRET_MIN_LENGTH)
    .sort((a, b) => b.length - a.length)
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out
}

/** Prefixes the first line with time, level and source. Continuation lines such as stack traces stay as they are. */
export function formatLogEntry(at: Date, level: AppLogLevel, source: AppLogSource, text: string): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
  return `${localDateKey(at)} ${time} ${level.toUpperCase().padEnd(5)} ${source} ${text}\n`
}

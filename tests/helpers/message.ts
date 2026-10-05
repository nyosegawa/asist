/** Stands for a value of a message that a test cannot know, such as the error text of a library. */
export const ANY_VALUE = '\u0000'

/**
 * The message `written`, in which one value was given as `ANY_VALUE`, as a pattern that any non-empty value
 * in that place matches: `toMatch(withAnyValue(t('files.viewer.docxFailed', { message: ANY_VALUE })))`.
 */
export function withAnyValue(written: string): RegExp {
  const parts = written.split(ANY_VALUE).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${parts.join('[\\s\\S]+')}$`)
}

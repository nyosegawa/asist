import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'

interface FieldDraftOptions<T> {
  format: (value: T) => string
  /** The value of the text, or null for a text that is not one, which is dropped when the user leaves the field. */
  parse: (text: string) => T | null
  /** Saves the value and reports a failure itself. It resolves to whether the value was saved. */
  save: (value: T) => Promise<boolean>
}

type FieldElement = HTMLInputElement | HTMLTextAreaElement

interface FieldDraft<T> {
  /** The props of the input or textarea. */
  props: {
    value: string
    onChange: (event: ChangeEvent<FieldElement>) => void
    onBlur: () => void
    onKeyDown: (event: KeyboardEvent<FieldElement>) => void
    'aria-invalid': boolean
  }
  /**
   * What the field holds: the typed value when it is one, or else the saved value. A button beside the field
   * builds on this, because pressing it leaves the field and main may not have answered that save yet.
   */
  value: T
  /** Whether the text in the field is one whose save failed. It stays in the field, and leaving the field saves it again. */
  failed: boolean
}

/**
 * A settings field that saves what was typed once the user leaves it, or presses Enter in a single-line
 * field. Saving on every keystroke would store the values on the way to the one meant, such as 9 on the
 * way from 90 to 30 days of logs, and a field that shows the saved value drops the keys pressed before
 * main has answered the save of the previous one.
 */
export function useFieldDraft<T>(saved: T, { format, parse, save }: FieldDraftOptions<T>): FieldDraft<T> {
  const shown = format(saved)
  // What was typed, and the saved text it was left over. Text being typed stays until the field is left,
  // whatever answer arrives for an earlier save. Text that was left stays while its save is under way, and
  // after a save that failed, and gives way for good once the saved value changes, by that save or from
  // anywhere else, such as a button beside the field; so a failed text, which leaving the field saves
  // again, never writes over a value saved after it was typed.
  const [draft, setDraft] = useState<{ text: string; leftOver: string | null; failed?: true } | null>(null)
  const typed = draft !== null && (draft.leftOver === null || draft.leftOver === shown) ? draft.text : null
  const parsed = typed === null ? null : parse(typed)
  useEffect(() => {
    setDraft((current) => (current !== null && current.leftOver !== null && current.leftOver !== shown ? null : current))
  }, [shown])
  const leave = (): void => {
    if (draft === null || typed === null || (draft.leftOver !== null && !draft.failed)) return
    if (parsed === null || format(parsed) === shown) {
      setDraft(null)
      return
    }
    const left = { text: typed, leftOver: shown }
    setDraft(left)
    void save(parsed).then((saved) => {
      if (!saved) setDraft((current) => (current === left ? { ...left, failed: true } : current))
    })
  }
  // The field also goes away while it has focus, as when Escape closes the settings, and Chromium sends no
  // blur then, so what was typed is saved on unmount by the same rule.
  const leaveOnUnmount = useRef(leave)
  useEffect(() => {
    leaveOnUnmount.current = leave
  })
  useEffect(() => () => leaveOnUnmount.current(), [])
  const failed = typed !== null && draft?.failed === true
  return {
    props: {
      value: typed ?? shown,
      onChange: (event) => setDraft({ text: event.target.value, leftOver: null }),
      onBlur: leave,
      onKeyDown: (event) => {
        // The Enter that confirms a conversion in the Japanese IME must not leave the field.
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.currentTarget instanceof HTMLInputElement) event.currentTarget.blur()
      },
      'aria-invalid': failed
    },
    value: parsed ?? saved,
    failed
  }
}

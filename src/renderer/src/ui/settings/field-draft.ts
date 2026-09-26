import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'

interface FieldDraftOptions<T> {
  format: (value: T) => string
  /** The value of the text, or null for a text that is not one, which is dropped when the user leaves the field. */
  parse: (text: string) => T | null
  save: (value: T) => void
}

type FieldElement = HTMLInputElement | HTMLTextAreaElement

interface FieldDraftProps {
  value: string
  onChange: (event: ChangeEvent<FieldElement>) => void
  onBlur: () => void
  onKeyDown: (event: KeyboardEvent<FieldElement>) => void
}

/**
 * The props of a settings field that saves what was typed once the user leaves it, or presses Enter in a
 * single-line field. Saving on every keystroke would store the values on the way to the one meant, such
 * as 9 on the way from 90 to 30 days of logs, and a field that shows the saved value drops the keys
 * pressed before main has answered the save of the previous one.
 */
export function useFieldDraft<T>(saved: T, { format, parse, save }: FieldDraftOptions<T>): FieldDraftProps {
  const shown = format(saved)
  // What was typed over the saved text, and whether it has gone to be saved. It stays on screen while its
  // save is under way, including after a save that failed, and gives way once the saved value changes, by
  // that save or from anywhere else.
  const [draft, setDraft] = useState<{ text: string; over: string; sent: boolean } | null>(null)
  const editing = draft !== null && draft.over === shown
  const leave = (): void => {
    if (!editing || draft.sent) return
    const value = parse(draft.text)
    if (value === null || format(value) === shown) {
      setDraft(null)
      return
    }
    setDraft({ ...draft, sent: true })
    save(value)
  }
  // The field also goes away while it has focus, as when Escape closes the settings, and Chromium sends no
  // blur then, so what was typed is saved on unmount by the same rule.
  const leaveOnUnmount = useRef(leave)
  useEffect(() => {
    leaveOnUnmount.current = leave
  })
  useEffect(() => () => leaveOnUnmount.current(), [])
  return {
    value: editing ? draft.text : shown,
    onChange: (event: ChangeEvent<FieldElement>) => setDraft({ text: event.target.value, over: shown, sent: false }),
    onBlur: leave,
    onKeyDown: (event: KeyboardEvent<FieldElement>) => {
      if (event.key === 'Enter' && event.currentTarget instanceof HTMLInputElement) event.currentTarget.blur()
    }
  }
}

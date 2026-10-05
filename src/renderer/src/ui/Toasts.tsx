import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useToastStore } from '@/state/stores'
import { Btn } from './settings/primitives'

const KIND_STYLE: Record<string, string> = {
  ok: 'border-holo-mint/45 text-holo-mint',
  error: 'border-holo-red/45 text-holo-red',
  info: 'border-holo-cyan/40 text-holo-cyan'
}

/**
 * The toasts at the top right. A body shows two lines, and the toast the pointer or the keyboard rests on
 * shows the whole of it and stays up until it is left, so that a long error can be read to the end.
 * A click on its text dismisses it, and so does its action, after running. The action is a button beside the
 * text rather than inside it, since a button cannot hold another. Each toast carries its kind in data-toast,
 * which the scripts that drive the app over CDP read to report an error the app showed.
 *
 * A heading is a sentence, not a label. With the HUD labels' letter spacing (0.16em) in a 320 px column, 85
 * headings over the eleven languages wrapped; with 0.04em in 384 px, 9 do, all longer than 55 characters
 * (measured in the demo on 2026-09-26).
 */
export function Toasts(): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const { remove, hold, release } = useToastStore.getState()
  // The pointer and the keyboard each hold a toast; it goes on showing the whole and staying up until neither does.
  const [pointerOn, setPointerOn] = useState<number | null>(null)
  const [focusOn, setFocusOn] = useState<number | null>(null)
  const read = (id: number, by: 'pointer' | 'focus'): void => {
    hold(id)
    if (by === 'pointer') setPointerOn(id)
    else setFocusOn(id)
  }
  const leave = (id: number, by: 'pointer' | 'focus'): void => {
    const other = by === 'pointer' ? focusOn : pointerOn
    if (by === 'pointer') setPointerOn(null)
    else setFocusOn(null)
    if (other !== id) release(id)
  }
  const reading = (id: number): boolean => pointerOn === id || focusOn === id
  return (
    <div className="pointer-events-none fixed top-14 right-4 z-50 flex w-96 flex-col gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 30 }}
            onPointerEnter={() => read(toast.id, 'pointer')}
            onPointerLeave={() => leave(toast.id, 'pointer')}
            onFocus={() => read(toast.id, 'focus')}
            onBlur={() => leave(toast.id, 'focus')}
            data-toast={toast.kind}
            className={`glass pointer-events-auto rounded-xl border px-4 py-2.5 ${KIND_STYLE[toast.kind]}`}
          >
            <button
              type="button"
              className="block w-full cursor-pointer text-left"
              onClick={() => remove(toast.id)}
              aria-expanded={toast.body ? reading(toast.id) : undefined}
            >
              <div className="font-mono text-[10px] font-semibold tracking-[0.04em]">{toast.title}</div>
              {toast.body && (
                <div
                  className={`mt-0.5 text-[11px] whitespace-pre-line text-holo-muted ${reading(toast.id) ? 'max-h-[60vh] overflow-y-auto' : 'line-clamp-2'}`}
                >
                  {toast.body}
                </div>
              )}
            </button>
            {toast.action && (
              <div className="mt-2 flex">
                <Btn
                  tone="primary"
                  onClick={() => {
                    toast.action!.run()
                    remove(toast.id)
                  }}
                >
                  {toast.action.label}
                </Btn>
              </div>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

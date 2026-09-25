import { AnimatePresence, motion } from 'motion/react'
import { useToastStore } from '@/state/stores'

const KIND_STYLE: Record<string, string> = {
  ok: 'border-holo-mint/45 text-holo-mint',
  error: 'border-holo-red/45 text-holo-red',
  info: 'border-holo-cyan/40 text-holo-cyan'
}

export function Toasts(): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const remove = useToastStore((s) => s.remove)
  return (
    <div className="pointer-events-none fixed top-14 right-4 z-50 flex w-80 flex-col gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.button
            key={toast.id}
            initial={{ opacity: 0, y: -10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 30 }}
            onClick={() => remove(toast.id)}
            className={`glass pointer-events-auto cursor-pointer rounded-xl border px-4 py-2.5 text-left ${KIND_STYLE[toast.kind]}`}
          >
            <div className="font-mono text-[10px] font-semibold tracking-[0.16em]">
              {toast.title}
            </div>
            {toast.body && (
              <div className="mt-0.5 line-clamp-2 text-[11px] text-holo-muted">{toast.body}</div>
            )}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  )
}

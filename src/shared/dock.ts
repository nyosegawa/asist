import { z } from 'zod'
import { errorText } from './i18n/error-text'

/**
 * The screens in the bottom navigation. ASIST, the conversation screen, is pinned leftmost and is not
 * listed here; the rest follow the `dockOrder` setting, which the user changes by dragging the
 * navigation icons rather than from the settings screen.
 */
export const DOCK_ITEMS = ['jobs', 'tasks', 'notes', 'mail', 'memory', 'calendar', 'settings'] as const
export type DockItem = (typeof DOCK_ITEMS)[number]

export const DEFAULT_DOCK_ORDER: readonly DockItem[] = DOCK_ITEMS

export const dockOrderSchema = z
  .array(z.enum(DOCK_ITEMS))
  .length(DOCK_ITEMS.length, {
    message: errorText('settings.errors.dockOrder', { items: DOCK_ITEMS.join(', '), count: DOCK_ITEMS.length })
  })
  .refine((order) => new Set(order).size === order.length, { message: errorText('settings.errors.dockOrderDuplicate') })

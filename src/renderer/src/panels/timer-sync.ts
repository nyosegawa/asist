import type { AppTimer, TimerEvent } from '@shared/ipc'

export interface TimerSyncTarget {
  show(timer: AppTimer): void
  dismiss(id: string): void
}

/** Turns a settled timer event from main into a display action that does not depend on the conversation turn. */
export function syncTimerEvent(event: TimerEvent, target: TimerSyncTarget): void {
  if (event.type === 'removed') {
    target.dismiss(event.id)
    return
  }
  if (event.timer.status === 'active' || event.timer.notificationStatus === 'pending') {
    target.show(event.timer)
  }
}

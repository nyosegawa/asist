import { useEffect, useRef } from 'react'
import type { SpeechModelNotice } from '@shared/ipc'
import { osMessageKey } from '@shared/i18n/os-message'
import { safetyNoticePending } from '@shared/settings'
import { displayError } from '@/display-error'
import { formatLocale, translate } from '@/i18n'
import { platformCapabilities } from '@/platform'
import { prepareAsrModel, prepareTtsModel } from '@/state/preparation'
import { useSettingsStore, useToastStore } from '@/state/stores'
import { useViewStore } from '@/state/view'

/**
 * Tells, once at launch, about each local speech model the settings use whose files are not on this computer,
 * as after an update that pinned other files. Each one is a toast that stays until it is closed, naming the
 * model and what preparing it downloads. Its button prepares the model as the settings do and opens the voice
 * page, whose row of the model shows the progress. It waits until the notice of the risks, which covers the app,
 * is answered. A launch that opened on the first-run setup asks for nothing: the setup prepares what it chooses.
 */
export function SpeechModelNotices(): null {
  const settings = useSettingsStore((s) => s.settings)
  const asked = useRef<'waiting' | 'asked' | 'setup'>('waiting')
  useEffect(() => {
    if (!settings || asked.current !== 'waiting') return
    if (settings.onboardingVersion < 1) {
      asked.current = 'setup'
      return
    }
    if (safetyNoticePending(settings)) return
    asked.current = 'asked'
    window.api.speechModelNotices().then(
      (notices) => notices.forEach(showNotice),
      (error: unknown) => useToastStore.getState().push({ kind: 'error', title: translate('app.status.checkFailed'), body: displayError(error) })
    )
  }, [settings])
  return null
}

function showNotice(notice: SpeechModelNotice): void {
  const settings = useSettingsStore.getState().settings
  const sizeGb = new Intl.NumberFormat(formatLocale(), { maximumFractionDigits: 1 }).format(notice.downloadBytes / 1e9)
  useToastStore.getState().push({
    kind: 'info',
    persistent: true,
    title: translate('settingsModels.notice.title', { model: notice.label }),
    body:
      notice.target === 'tts'
        ? translate(osMessageKey('settingsModels.notice.speech', platformCapabilities().os))
        : translate(settings?.localAsrEnabled ? 'settingsModels.notice.recognitionWhisper' : 'settingsModels.notice.recognition'),
    action: {
      label: translate('settingsModels.notice.prepare', { sizeGb }),
      run: () => {
        void (notice.target === 'asr' ? prepareAsrModel() : prepareTtsModel())
        void useViewStore.getState().openApp({ app: 'settings', page: 'voice' })
      }
    }
  })
}

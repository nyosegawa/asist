import { useEffect, useState } from 'react'
import type { MemoryOverview } from '@shared/ipc'
import { HoloSwitch } from '@/components/ui/switch'
import { useToastStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import type { SettingsContext } from '../context'
import { Btn, Chip, Group, Link, Page, Row } from '../primitives'
import { displayError } from '@/display-error'
import { useFormatLocale, useT } from '@/i18n'

/** The memory page: semantic search, curation of memories, and a link to the memory view. */
export function MemoryPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, embedding, set, go } = ctx
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const locale = useFormatLocale()
  const when = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const [overview, setOverview] = useState<MemoryOverview | null>(null)
  const [curating, setCurating] = useState(false)
  const embeddingReady = embedding?.runtimeInstalled === true && embedding.modelInstalled

  const refresh = async (): Promise<void> => {
    try {
      setOverview(await window.api.memoryOverview())
    } catch {
      setOverview(null)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  const curate = (): void => {
    setCurating(true)
    void window.api
      .memoryCurate()
      .then((job) => {
        toast(
          job
            ? { kind: 'ok', title: t('settingsMemory.curation.started'), body: t('settingsMemory.curation.startedBody', { title: job.title }) }
            : { kind: 'ok', title: t('settingsMemory.curation.nothingToCurate'), body: t('settingsMemory.curation.nothingToCurateBody') }
        )
        return refresh()
      })
      .catch((err: unknown) => toast({ kind: 'error', title: t('settingsMemory.curation.startFailed'), body: displayError(err) }))
      .finally(() => setCurating(false))
  }
  const failure = overview?.lastFailure ?? null
  const curationHint = overview?.unavailableReason
    ? overview.unavailableReason
    : overview?.pendingJobId
      ? t('settingsMemory.curation.pending')
      : failure
        ? t('settingsMemory.curation.failed', { when: when.format(failure.at), message: failure.message })
        : overview?.curatedThrough
          ? t('settingsMemory.curation.curatedThrough', { date: overview.curatedThrough })
          : t('settingsMemory.curation.neverRun')

  return (
    <Page title={t('settingsMemory.title')} lead={t('settingsMemory.lead')}>
      <Group title={t('settingsMemory.search.title')} description={t('settingsMemory.search.description')}>
        <Row
          label={t('settingsMemory.search.use')}
          hint={
            embeddingReady
              ? t(
                  embedding.converting
                    ? 'settingsMemory.search.converting'
                    : embedding.running
                      ? 'settingsMemory.search.convertedRunning'
                      : 'settingsMemory.search.converted',
                  { embedded: embedding.embedded, total: embedding.total }
                )
              : t('settingsMemory.search.notPrepared')
          }
        >
          {embeddingReady ? (
            <HoloSwitch checked={settings.memoryEmbeddingEnabled} onCheckedChange={(v) => set({ memoryEmbeddingEnabled: v })} />
          ) : (
            <Link onClick={() => go('models')}>{t('common.openModels')}</Link>
          )}
        </Row>
      </Group>

      <Group
        title={t('settingsMemory.curation.title')}
        description={t('settingsMemory.curation.description')}
        action={
          <Btn tone="primary" disabled={curating || Boolean(overview?.unavailableReason)} onClick={curate}>
            {curating ? t('settingsMemory.curation.starting') : t('settingsMemory.curation.start')}
          </Btn>
        }
      >
        <Row label={t('settingsMemory.curation.status')} hint={curationHint}>
          <Chip tone={overview?.unavailableReason || (failure && !overview?.pendingJobId) ? 'warn' : overview?.pendingJobId ? 'cyan' : 'dim'}>
            {overview?.unavailableReason
              ? t('settingsMemory.curation.unavailable')
              : overview?.pendingJobId
                ? t('settingsMemory.curation.waiting')
                : failure
                  ? t('settingsMemory.curation.failedChip')
                  : overview?.curatedThrough
                    ? t('settingsMemory.curation.done')
                    : t('settingsMemory.curation.notRun')}
          </Chip>
        </Row>
      </Group>

      <Group title={t('settingsMemory.view.title')} description={t('settingsMemory.view.description')}>
        <Row label={t('settingsMemory.view.dockHint')}>
          <Link onClick={() => useViewStore.getState().openApp({ app: 'memory' })}>{t('settingsMemory.view.open')}</Link>
        </Row>
      </Group>
    </Page>
  )
}

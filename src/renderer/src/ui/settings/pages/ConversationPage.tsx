import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_INFO,
  catalogModelsOf,
  defaultModelsFor,
  effortFor,
  effortOptions,
  type Effort,
  modelLabel,
  sameModel,
  type ConversationModel,
  type LlmProvider
} from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO, VOICE_ENGINES, isLiveEngine, voiceEngineLabel, type LiveEngine, type VoiceEngine } from '@shared/voice-engine'
import type { Translate } from '@shared/i18n'
import { keyReadable } from '@shared/ipc'
import { useToastStore } from '@/state/stores'
import type { SettingsContext } from '../context'
import { Btn, Chip, Group, Page, Row } from '../primitives'
import { PrepLine } from '../preparation'
import { credentialText, keyProviders } from '../pending'
import { openChatGptUsage, useChatGptSignIn } from '@/chatgpt'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/**
 * The conversation page: the voice engine and the models that answer. A key or sign-in that is missing for
 * a provider in use shows under the models, with the way to the API keys page; a key that works is not
 * repeated here. While the models run on the ChatGPT plan, the page says so next to them with the way to
 * the plan's usage, as OpenAI asks of apps.
 */
export function ConversationPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status, save, refreshStatus, go } = ctx
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const [saving, setSaving] = useState(false)
  const conversation = settings.conversationModel
  const bridge = settings.bridgeModel
  const conversationInfo = LLM_PROVIDER_INFO[conversation.provider]
  const engine = settings.voiceEngine
  const live = isLiveEngine(engine) ? engine : null

  const changeEngine = (next: VoiceEngine): void => {
    setSaving(true)
    void save({ voiceEngine: next })
      .then(() => refreshStatus())
      .then(() => toast({ kind: 'ok', title: t('settingsConversation.engine.changed', { engine: voiceEngineLabel(t, next) }) }))
      .catch((err: unknown) => toast({ kind: 'error', title: t('settingsConversation.engine.changeFailed'), body: displayError(err) }))
      .finally(() => setSaving(false))
  }

  const change = (field: 'conversationModel' | 'bridgeModel', model: ConversationModel): void => {
    setSaving(true)
    // When the conversation provider changes, the bridge look-ahead moves to that provider's light
    // model as well. Leaving them apart would demand two keys, and a missing key on either side
    // keeps a conversation from starting. The look-ahead can still be chosen on its own afterwards.
    const follow = field === 'conversationModel' && model.provider !== conversation.provider ? defaultModelsFor(model.provider).bridgeModel : null
    void save(follow ? { conversationModel: model, bridgeModel: follow } : { [field]: model })
      .then(() => refreshStatus())
      .then(() =>
        toast({
          kind: 'ok',
          title: follow
            ? t('settingsConversation.models.bothChanged', { model: modelLabel(model), bridge: modelLabel(follow) })
            : t(`settingsConversation.models.${field}Changed`, { model: modelLabel(model) })
        })
      )
      .catch((err: unknown) => toast({ kind: 'error', title: t(`settingsConversation.models.${field}ChangeFailed`), body: displayError(err) }))
      .finally(() => setSaving(false))
  }

  const providers = keyProviders(settings)
  const missingKeys = status === null ? [] : providers.flatMap((provider) => {
    const state = status.llmKeys[provider]
    return state === 'missing' || state === 'unreadable' ? [{ provider, state }] : []
  })
  const onPlan = status !== null && providers.includes('chatgpt') && keyReadable(status.llmKeys.chatgpt)
  const chatgpt = useChatGptSignIn(onPlan)

  return (
    <Page title={t('settingsConversation.title')} lead={t('settingsConversation.lead')}>
      <Group title={t('settingsConversation.engine.title')} description={t('settingsConversation.engine.description')}>
        <Row label={t('settingsConversation.engine.label')} hint={engineHint(t, engine)}>
          <select
            className="st-select"
            aria-label={t('settingsConversation.engine.selectLabel')}
            value={engine}
            disabled={saving}
            onChange={(e) => changeEngine(e.target.value as VoiceEngine)}
          >
            {VOICE_ENGINES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {voiceEngineLabel(t, candidate)}
              </option>
            ))}
          </select>
        </Row>
        {live && <LiveEngineRows engine={live} ctx={ctx} disabled={saving} />}
      </Group>

      <Group
        title={t('settingsConversation.models.title')}
        description={live ? t('settingsConversation.models.geminiLiveDescription') : t('settingsConversation.models.description')}
      >
        <Row label={t('settingsConversation.models.conversation')} hint={noteOf(t, conversation)}>
          <ModelPicker role="conversationModel" value={conversation} disabled={saving} onChange={(model) => change('conversationModel', model)} />
        </Row>
        {!live && (
          <Row label={t('settingsConversation.models.bridge')} hint={t('settingsConversation.models.bridgeHint')}>
            <ModelPicker role="bridgeModel" value={bridge} disabled={saving} onChange={(model) => change('bridgeModel', model)} />
          </Row>
        )}
        {onPlan && (
          <Row label={t('chatgpt.plan.using')} hint={chatgpt.status?.account ? <span data-fit="data">{chatgpt.status.account}</span> : undefined}>
            <Btn tone="quiet" onClick={openChatGptUsage}>
              <ExternalLink size={12} aria-hidden />
              {t('chatgpt.plan.manageUsage')}
            </Btn>
          </Row>
        )}
        {missingKeys.map(({ provider, state }) => {
          const text = credentialText(t, provider, state, live)
          return (
            <PrepLine key={provider} text={text.hint}>
              <Chip tone="warn">{text.state}</Chip>
              <Btn tone="primary" onClick={() => go('apiKeys')}>
                {text.action}
              </Btn>
            </PrepLine>
          )
        })}
        <Row
          label={t('settingsConversation.models.webSearch')}
          hint={
            // The wording for the API key providers says each search is billed, which a search on the ChatGPT plan is not.
            conversation.provider === 'chatgpt'
              ? t('chatgpt.plan.webSearch')
              : conversationInfo.webSearch
                ? t('settingsConversation.models.webSearchAvailable', { provider: conversationInfo.label })
                : t('settingsConversation.models.webSearchUnavailable', { provider: conversationInfo.label })
          }
        >
          <Chip tone={conversationInfo.webSearch ? 'ok' : 'dim'}>
            {conversationInfo.webSearch ? t('settingsConversation.models.available') : t('settingsConversation.models.unavailable')}
          </Chip>
        </Row>
      </Group>
    </Page>
  )
}

const noteOf = (t: Translate, model: ConversationModel): string => {
  const known = catalogModelsOf(model.provider).find((candidate) => sameModel(candidate, model))
  return known ? t(known.note) : t('settingsConversation.models.unlisted', { id: model.id })
}

const engineHint = (t: Translate, engine: VoiceEngine): string =>
  engine === 'cascade' ? t('voiceEngines.cascade.hint') : t('voiceEngines.geminiLive.hint')

/** The rows of a live engine: its model and how long it waits before closing the session. Its voice is chosen on the voice page. */
function LiveEngineRows({ engine, ctx, disabled }: { engine: LiveEngine; ctx: SettingsContext; disabled: boolean }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const info = LIVE_ENGINE_INFO[engine]
  const current = settings.geminiLive
  const model = info.models.find((candidate) => candidate.id === current.model)
  return (
    <>
      <Row label={t('settingsConversation.live.model')} hint={model ? t(model.note) : t('settingsConversation.models.unlisted', { id: current.model })}>
        <select
          className="st-select"
          aria-label={t('settingsConversation.live.modelLabel', { engine: info.label })}
          value={current.model}
          disabled={disabled}
          onChange={(e) => set({ geminiLive: { ...current, model: e.target.value } })}
        >
          {info.models.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
          {!model && <option value={current.model}>{current.model}</option>}
        </select>
      </Row>
      <Row label={t('settingsConversation.live.idle')} hint={t('settingsConversation.live.idleHint')}>
        <input
          type="range"
          aria-label={t('settingsConversation.live.idleLabel')}
          min={10}
          max={600}
          step={10}
          value={settings.liveIdleSeconds}
          onChange={(e) => set({ liveIdleSeconds: Number(e.target.value) })}
        />
        <span className="st-value">{t('settingsConversation.live.seconds', { count: settings.liveIdleSeconds })}</span>
      </Row>
    </>
  )
}

/**
 * A choice of provider and model in two steps, plus the depth of thinking for the models that accept
 * it. Changing the provider picks that provider's default model, the standard one for conversation
 * and the light one for the bridge look-ahead. Changing the model resets the depth to its default,
 * because the steps mean different things from one model to the next.
 */
function ModelPicker({
  role,
  value,
  disabled,
  onChange
}: {
  /** Which default model a change of provider picks: the standard one for conversation, the light one for the look-ahead. */
  role: 'conversationModel' | 'bridgeModel'
  value: ConversationModel
  disabled: boolean
  onChange: (model: ConversationModel) => void
}): React.JSX.Element {
  const t = useT()
  const models = catalogModelsOf(value.provider)
  const listed = models.some((model) => sameModel(model, value))
  const efforts = effortOptions(value)
  return (
    <>
      <select
        className="st-select"
        aria-label={t(`settingsConversation.models.${role}.provider`)}
        value={value.provider}
        disabled={disabled}
        onChange={(e) => {
          onChange(defaultModelsFor(e.target.value as LlmProvider)[role])
        }}
      >
        {LLM_PROVIDERS.map((provider) => (
          <option key={provider} value={provider}>
            {LLM_PROVIDER_INFO[provider].label}
          </option>
        ))}
      </select>
      <select
        className="st-select"
        aria-label={t(`settingsConversation.models.${role}.model`)}
        value={value.id}
        disabled={disabled}
        onChange={(e) => onChange({ provider: value.provider, id: e.target.value })}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
        {!listed && <option value={value.id}>{value.id}</option>}
      </select>
      {efforts.length > 0 && (
        <select
          className="st-select"
          aria-label={t(`settingsConversation.models.${role}.effort`)}
          value={effortFor(value) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ provider: value.provider, id: value.id, effort: e.target.value as Effort })}
        >
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {t(`llmModels.effort.${effort}`)}
            </option>
          ))}
        </select>
      )}
    </>
  )
}

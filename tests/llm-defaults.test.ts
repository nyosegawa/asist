import { describe, expect, it } from 'vitest'
import { CONVERSATION_MODELS, LLM_PROVIDERS, defaultModelsFor, sameModel } from '@shared/llm-catalog'

describe('the default models of each provider', () => {
  it('picks both the conversation model and the aizuchi model from the catalog of that same provider', () => {
    for (const provider of LLM_PROVIDERS) {
      const { conversationModel, bridgeModel } = defaultModelsFor(provider)
      for (const model of [conversationModel, bridgeModel]) {
        // A model from another provider would require a second key, so the first-run setup could not finish with one key.
        expect(model.provider).toBe(provider)
        expect(CONVERSATION_MODELS.some((known) => sameModel(known, model))).toBe(true)
      }
    }
  })
})

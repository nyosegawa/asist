import { describe, expect, it } from 'vitest'
import type { ToolSpec } from '@shared/conversation'
import { toGeminiFunctionDeclarations } from '../src/main/services/live/gemini-tools'

describe('toGeminiFunctionDeclarations', () => {
  it('passes the JSON Schema through, drops the additionalProperties and $schema that Gemini rejects, and marks the tool NON_BLOCKING', () => {
    const tools: ToolSpec[] = [
      {
        name: 'show_weather',
        description: '天気',
        inputSchema: {
          type: 'object',
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          additionalProperties: false,
          properties: { location: { type: 'string' }, days: { type: 'array', items: { type: 'object', additionalProperties: false } } },
          required: ['location']
        }
      }
    ]
    expect(toGeminiFunctionDeclarations(tools)).toEqual([
      {
        name: 'show_weather',
        description: '天気',
        parametersJsonSchema: {
          type: 'object',
          properties: { location: { type: 'string' }, days: { type: 'array', items: { type: 'object' } } },
          required: ['location']
        },
        behavior: 'NON_BLOCKING'
      }
    ])
  })
})

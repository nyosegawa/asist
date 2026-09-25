import type { ToolSpec } from '@shared/conversation'
import { withoutSchemaKeys } from '../llm/adapter'

/**
 * Turns ASIST's client tools into Gemini Live function declarations. The input schema is passed on as JSON
 * Schema in parametersJsonSchema, minus `$schema` and additionalProperties, which Gemini rejects. Every
 * declaration is NON_BLOCKING, so that the model keeps talking while a function runs.
 */
export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parametersJsonSchema: Record<string, unknown>
  behavior: 'NON_BLOCKING'
}

export function toGeminiFunctionDeclarations(tools: readonly ToolSpec[]): GeminiFunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parametersJsonSchema: withoutSchemaKeys(tool.inputSchema, ['$schema', 'additionalProperties']),
    behavior: 'NON_BLOCKING'
  }))
}

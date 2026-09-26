import { SYSTEM_LAYER_NAMES, type SystemLayer } from './conversation'

export type { SystemLayer }

/**
 * Diagnosis of why the prompt cache missed. A fingerprint of the request sent, holding a hash per
 * system cache breakpoint, a hash of the tools and one hash per message, is compared with the previous
 * one to locate where the prefix changed. The server's beta diagnostic is not used, because while
 * streaming it is often still undecided at message_start; this runs on the client and is
 * deterministic. Together with the measured cache_read it also shows a miss that should not have
 * happened.
 */

/** Each system layer has a reason of its own, `system_` followed by the layer's name. */
export const CACHE_MISS_REASONS = [
  'first',
  'hit',
  'ttl',
  'tools',
  'system_base',
  'system_memory',
  'system_summary',
  'messages',
  'unknown'
] as const

export type CacheMissReason = (typeof CACHE_MISS_REASONS)[number]

export interface RequestFingerprint {
  at: number
  /** The hash of each layer sent, by name. A layer that was left out has none. */
  systemLayers: Partial<Record<SystemLayer['name'], string>>
  tools: string
  messages: string[]
}

/** A cheap hash, two 32-bit FNV-1a passes, used only to tell two texts apart and never for security. */
export function hashText(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x7fffffff
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ ((c << 7) | (c >>> 9)), 0x01000193) >>> 0
  }
  return `${a.toString(16)}${b.toString(16)}`
}

export function fingerprintRequest(input: {
  at: number
  systemLayers: readonly SystemLayer[]
  tools: unknown
  messages: readonly unknown[]
}): RequestFingerprint {
  return {
    at: input.at,
    systemLayers: Object.fromEntries(input.systemLayers.map((layer) => [layer.name, hashText(layer.text)])),
    tools: hashText(JSON.stringify(input.tools)),
    messages: input.messages.map((message) => hashText(JSON.stringify(message)))
  }
}

export const CACHE_TTL_MS = 5 * 60_000

/**
 * Decides why the cache missed, by comparing with the previous request. A change in only the last of
 * the previous messages, the user message that carries notes and injections, is expected and counts
 * as a hit; a change anywhere before it is reported as `messages`.
 */
export function diagnoseCacheMiss(
  previous: RequestFingerprint | null,
  next: RequestFingerprint,
  usage: { cacheRead: number },
  ttlMs = CACHE_TTL_MS
): CacheMissReason {
  if (!previous) return 'first'
  if (next.at - previous.at >= ttlMs) return 'ttl'
  if (previous.tools !== next.tools) return 'tools'
  // The layers go out in one order, so the first one whose text changed, or that appeared or went
  // away, is where the cached prefix broke.
  for (const name of SYSTEM_LAYER_NAMES) {
    if (previous.systemLayers[name] !== next.systemLayers[name]) return `system_${name}`
  }
  const stablePrefix = previous.messages.length - 1
  for (let i = 0; i < stablePrefix; i++) {
    if (previous.messages[i] !== next.messages[i]) return 'messages'
  }
  return usage.cacheRead > 0 ? 'hit' : 'unknown'
}

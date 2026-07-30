// ABOUTME: Negative-result KV cache for the verify flow: failures and upstream
// ABOUTME: errors only. D1 owns platform successes; NIP-05 names are the one
// documented exception (no D1 store) and keep the legacy 24h success TTL.
import type { VerificationMethod, VerificationProvenance } from '../verify/identity-link'

export interface CachedResult {
  verified: boolean
  error?: string
  method?: VerificationMethod
  provenance?: VerificationProvenance
  checked_at: number
  type: 'verified' | 'failed' | 'platform_error'
}

// TTLs in seconds
const TTL_FAILED = 15 * 60            // 15 minutes
const TTL_PLATFORM_ERROR = 5 * 60     // 5 minutes
// Documented exception: D1 only stores platform verifications, not NIP-05
// names, so NIP-05 successes live here with the legacy 24h TTL.
const TTL_NIP05_VERIFIED = 24 * 60 * 60

export function getTtl(type: CachedResult['type']): number {
  switch (type) {
    case 'verified': return TTL_NIP05_VERIFIED
    case 'failed': return TTL_FAILED
    case 'platform_error': return TTL_PLATFORM_ERROR
  }
}

/** Escape pipe characters in cache key segments to prevent injection */
function escapeSegment(s: string): string {
  return s.replace(/\|/g, '||')
}

export function cacheKey(platform: string, identity: string, proof: string, pubkey: string): string {
  return `v|${escapeSegment(platform)}|${escapeSegment(identity)}|${escapeSegment(proof)}|${pubkey}`
}

export function nip05CacheKey(name: string, domain: string, pubkey: string): string {
  return `nip05|${escapeSegment(name)}@${escapeSegment(domain)}|${pubkey}`
}

export async function getCached(kv: KVNamespace, key: string): Promise<CachedResult | null> {
  const raw = await kv.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as CachedResult
  } catch {
    return null
  }
}

export async function putCached(kv: KVNamespace, key: string, result: CachedResult): Promise<void> {
  const ttl = getTtl(result.type)
  await kv.put(key, JSON.stringify(result), { expirationTtl: ttl })
}

// ABOUTME: Core verification flow: D1 success store -> KV negative cache ->
// ABOUTME: rate limits -> upstream proof fetch -> write D1 (success) / KV (failure).
import type { Env, VerificationPlatform } from '../types'
import { findLiveVerification, upsertProofPostVerificationStatement } from '../db/verifications'
import { getCached, putCached, cacheKey } from '../utils/cache'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'
import { getProofVerifier } from '../verify/registry'
import { isValidIdentity, isValidProof } from '../verify/validation'
import { hexToNpub } from '../utils/npub'
import type { VerificationMethod, VerificationProvenance } from '../verify/identity-link'

export interface VerifyClaim {
  pubkey: string
  platform: string   // accepts legacy 'twitter'; normalized to 'x'
  identity: string
  proof: string
}

export interface VerifyResult {
  platform: VerificationPlatform
  identity: string
  verified: boolean
  error?: string
  method?: VerificationMethod
  provenance?: VerificationProvenance
  checked_at: number
  cached: boolean
}

const PUBKEY_RE = /^[0-9a-f]{64}$/

export function normalizeVerifyPlatform(platform: string): VerificationPlatform | null {
  const p = platform.toLowerCase() === 'twitter' ? 'x' : platform.toLowerCase()
  switch (p) {
    case 'x': case 'instagram': case 'tiktok': case 'youtube':
    case 'bluesky': case 'github': case 'mastodon': case 'telegram': case 'discord':
      return p
    default:
      return null
  }
}

export async function verifySingleClaim(
  env: Env,
  claim: VerifyClaim,
  context: { ip: string },
): Promise<VerifyResult> {
  const now = Math.floor(Date.now() / 1000)
  const pubkey = claim.pubkey.toLowerCase()
  const platform = normalizeVerifyPlatform(claim.platform)
  const base = { identity: claim.identity, checked_at: now, cached: false }

  if (!platform) return { ...base, platform: 'x', verified: false, error: 'Unsupported platform' }
  const result = (partial: Partial<VerifyResult> & { verified: boolean }): VerifyResult =>
    ({ ...base, platform, ...partial })

  if (!PUBKEY_RE.test(pubkey)) return result({ verified: false, error: 'Invalid pubkey' })
  if (!isValidIdentity(claim.identity)) return result({ verified: false, error: 'Invalid identity' })
  const proofOptional = platform === 'bluesky'
  if (!proofOptional && !isValidProof(claim.proof)) return result({ verified: false, error: 'Invalid proof' })
  if (proofOptional && claim.proof && !isValidProof(claim.proof)) return result({ verified: false, error: 'Invalid proof' })

  // Instagram has no proof-post verifier by design; say so instead of erroring upstream.
  if (platform === 'instagram') {
    return result({ verified: false, error: 'Instagram verification uses account connection, not proof posts' })
  }

  // 1. Durable success store.
  const live = await findLiveVerification(env.DB, pubkey, platform, claim.identity)
  if (live) {
    return result({
      verified: true,
      method: live.method === 'oauth' ? 'oauth' : 'proof_post',
      checked_at: live.verifiedAt,
      cached: true,
    })
  }

  // 2. Negative cache (failures only; successes never live in KV).
  const key = cacheKey(platform, claim.identity, claim.proof, pubkey)
  const cached = await getCached(env.CACHE_KV, key)
  // A stored verified:true should be impossible (KV never holds successes);
  // if it appears, treat it as a miss and verify upstream.
  if (cached && !cached.verified) {
    return result({
      verified: false,
      error: cached.error,
      method: cached.method,
      provenance: cached.provenance,
      checked_at: cached.checked_at,
      cached: true,
    })
  }

  // 3. Rate limits — after cache lookups so cached results don't consume quota.
  const ipLimit = await checkRateLimit(env.CACHE_KV, RATE_LIMITS.ip, context.ip)
  if (!ipLimit.allowed) {
    return result({ verified: false, error: 'rate_limit_exceeded' })
  }
  const pubkeyLimit = await checkRateLimit(env.CACHE_KV, RATE_LIMITS.pubkey, pubkey)
  if (!pubkeyLimit.allowed) {
    return result({ verified: false, error: 'rate_limit_exceeded' })
  }
  const platformLimit = await checkRateLimit(env.CACHE_KV, RATE_LIMITS.platform, platform)
  if (!platformLimit.allowed) {
    return result({ verified: false, error: 'rate_limit_exceeded' })
  }

  // 4. Upstream proof fetch.
  const npub = hexToNpub(pubkey)
  try {
    const verifier = getProofVerifier(platform, env)
    const outcome = await verifier.verify(claim.identity, claim.proof, npub)
    if (outcome.verified) {
      await env.DB.batch([
        upsertProofPostVerificationStatement(env.DB, {
          pubkey, platform, identity: claim.identity,
          proofUrl: claim.proof || null, verifiedAt: now,
        }),
      ])
      return result({ verified: true, method: outcome.method ?? 'proof_post', provenance: outcome.provenance })
    }
    await putCached(env.CACHE_KV, key, { verified: false, error: outcome.error, checked_at: now, type: 'failed' })
    return result({ verified: false, error: outcome.error })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'upstream error'
    await putCached(env.CACHE_KV, key, { verified: false, error: 'Platform verification unavailable', checked_at: now, type: 'platform_error' })
    console.error(JSON.stringify({ event: 'verify_upstream_error', platform, message }))
    return result({ verified: false, error: 'Platform verification unavailable' })
  }
}

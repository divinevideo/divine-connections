// ABOUTME: Tests for the D1 -> KV -> rate-limit -> upstream verification flow.
// ABOUTME: Real miniflare D1/KV; upstream HTTP stubbed at the fetch boundary only.
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations, PUBKEY_A, PUBKEY_B } from '../db/test-helpers'
import { findLiveVerification, upsertOauthVerificationStatement, upsertProofPostVerificationStatement } from '../db/verifications'
import { cacheKey, putCached } from '../utils/cache'
import { hexToNpub } from '../utils/npub'
import { verifySingleClaim } from './verify'

const NPUB_A = hexToNpub(PUBKEY_A)

function gistResponse(login: string, content: string): Response {
  return Response.json({ owner: { login }, files: { 'proof.md': { content } } })
}

describe('verifySingleClaim', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await applyMigrations()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('short-circuits on a D1 hit without touching upstream or rate limits', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 1_000 }),
    ])

    const result = await verifySingleClaim(env, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', proof: 'unused' }, { ip: '1.1.1.1' })

    expect(result).toMatchObject({ platform: 'x', verified: true, method: 'oauth', checked_at: 1_000, cached: true })
    expect(fetchMock).not.toHaveBeenCalled()
    const window = Math.floor(Date.now() / 1000 / 60)
    await expect(env.CACHE_KV.get(`rl:ip:1.1.1.1:${window}`)).resolves.toBeNull()
  })

  it('normalizes the legacy twitter alias to x', async () => {
    await env.DB.batch([
      upsertProofPostVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', proofUrl: '123', verifiedAt: 1_000 }),
    ])

    const result = await verifySingleClaim(env, { pubkey: PUBKEY_A, platform: 'twitter', identity: 'alice', proof: '123' }, { ip: '2.2.2.2' })

    expect(result).toMatchObject({ platform: 'x', verified: true, cached: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves KV negative results without fetch or rate-limit consumption', async () => {
    const key = cacheKey('github', 'negalice', 'gist-missing', PUBKEY_A)
    await putCached(env.CACHE_KV, key, { verified: false, error: 'npub not found in gist content', checked_at: 1_000, type: 'failed' })

    const result = await verifySingleClaim(env, { pubkey: PUBKEY_A, platform: 'github', identity: 'negalice', proof: 'gist-missing' }, { ip: '3.3.3.3' })

    expect(result).toMatchObject({ verified: false, error: 'npub not found in gist content', checked_at: 1_000, cached: true })
    expect(fetchMock).not.toHaveBeenCalled()
    const window = Math.floor(Date.now() / 1000 / 60)
    await expect(env.CACHE_KV.get(`rl:ip:3.3.3.3:${window}`)).resolves.toBeNull()
  })

  it('verifies a full upstream success and writes the D1 row', async () => {
    fetchMock.mockResolvedValueOnce(gistResponse('freshalice', `Verifying that I control the following Nostr public key: ${NPUB_A}`))

    const result = await verifySingleClaim(env, { pubkey: PUBKEY_A, platform: 'github', identity: 'freshalice', proof: 'gist-ok' }, { ip: '4.4.4.4' })

    expect(result).toMatchObject({ platform: 'github', verified: true, cached: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(findLiveVerification(env.DB, PUBKEY_A, 'github', 'freshalice')).resolves.toMatchObject({
      method: 'proof-post',
      proofUrl: 'gist-ok',
      connectionId: null,
    })
  })

  it('caches failures negatively and serves the retry from KV', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: 'Not Found' }, { status: 404 }))

    const claim = { pubkey: PUBKEY_A, platform: 'github', identity: 'bobsalice', proof: 'gist-404' }
    const first = await verifySingleClaim(env, claim, { ip: '5.5.5.5' })
    expect(first).toMatchObject({ verified: false, cached: false })

    const second = await verifySingleClaim(env, claim, { ip: '5.5.5.5' })
    expect(second).toMatchObject({ verified: false, cached: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches upstream exceptions as platform errors and serves them from KV', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'))

    const claim = { pubkey: PUBKEY_A, platform: 'github', identity: 'erralice', proof: 'gist-err' }
    const first = await verifySingleClaim(env, claim, { ip: '6.6.6.6' })
    expect(first).toMatchObject({ verified: false, error: 'Platform verification unavailable', cached: false })

    const second = await verifySingleClaim(env, claim, { ip: '6.6.6.6' })
    expect(second).toMatchObject({ verified: false, error: 'Platform verification unavailable', cached: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not consume rate-limit quota on cached results, and limits uncached requests', async () => {
    await env.DB.batch([
      upsertProofPostVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'github', identity: 'cachedalice', proofUrl: 'gist-1', verifiedAt: 1_000 }),
    ])
    for (let i = 0; i < 61; i++) {
      const result = await verifySingleClaim(env, { pubkey: PUBKEY_A, platform: 'github', identity: 'cachedalice', proof: 'gist-1' }, { ip: '7.7.7.7' })
      expect(result.verified).toBe(true)
    }
    expect(fetchMock).not.toHaveBeenCalled()

    const window = Math.floor(Date.now() / 1000 / 60)
    await env.CACHE_KV.put(`rl:ip:8.8.8.8:${window}`, '60', { expirationTtl: 120 })
    const limited = await verifySingleClaim(env, { pubkey: PUBKEY_B, platform: 'github', identity: 'limitedalice', proof: 'gist-2' }, { ip: '8.8.8.8' })
    expect(limited).toMatchObject({ verified: false, error: 'rate_limit_exceeded' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lets proofless Bluesky claims reach the verifier but rejects empty proofs elsewhere without fetch', async () => {
    fetchMock.mockResolvedValue(Response.json({}, { status: 404 }))
    const bluesky = await verifySingleClaim(env, { pubkey: PUBKEY_A, platform: 'bluesky', identity: 'alice.bsky.social', proof: '' }, { ip: '9.9.9.9' })
    expect(bluesky.verified).toBe(false)
    expect(fetchMock).toHaveBeenCalled()

    fetchMock.mockClear()
    const github = await verifySingleClaim(env, { pubkey: PUBKEY_A, platform: 'github', identity: 'alice', proof: '' }, { ip: '9.9.9.9' })
    expect(github).toMatchObject({ verified: false, error: 'Invalid proof' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects Instagram proof-post claims with a connect-account message before upstream', async () => {
    const result = await verifySingleClaim(env, { pubkey: PUBKEY_A, platform: 'instagram', identity: 'alice', proof: 'abc' }, { ip: '10.10.10.10' })
    expect(result).toMatchObject({ verified: false, error: 'Instagram verification uses account connection, not proof posts' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a stored verified KV result as a miss and verifies upstream', async () => {
    const key = cacheKey('github', 'stalealice', 'gist-stale', PUBKEY_A)
    await env.CACHE_KV.put(key, JSON.stringify({ verified: true, checked_at: 500, type: 'verified' }))
    fetchMock.mockResolvedValueOnce(gistResponse('stalealice', NPUB_A))

    const result = await verifySingleClaim(env, { pubkey: PUBKEY_A, platform: 'github', identity: 'stalealice', proof: 'gist-stale' }, { ip: '11.11.11.11' })

    expect(result).toMatchObject({ verified: true, cached: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

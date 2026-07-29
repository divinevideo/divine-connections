// ABOUTME: Tests for the negative-result KV cache helpers.
// ABOUTME: Key-shape and TTL tests are pure; get/put tests use real miniflare KV.
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { cacheKey, getCached, getTtl, nip05CacheKey, putCached } from './cache'

const pubkey = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'

describe('cache keys', () => {
  it('generates correct cache key with full pubkey', () => {
    expect(cacheKey('github', 'octocat', 'abc123', pubkey)).toBe(`v|github|octocat|abc123|${pubkey}`)
  })

  it('escapes pipe characters in key segments', () => {
    expect(cacheKey('github', 'octo|cat', 'ab|c', pubkey)).toBe(`v|github|octo||cat|ab||c|${pubkey}`)
  })

  it('generates correct NIP-05 cache key with full pubkey', () => {
    expect(nip05CacheKey('_', 'divine.video', pubkey)).toBe(`nip05|_@divine.video|${pubkey}`)
  })

  it('uses different cache keys for different pubkeys', () => {
    const pubkey2 = '7e7e9c42ffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    expect(cacheKey('github', 'octocat', 'abc123', pubkey)).not.toBe(cacheKey('github', 'octocat', 'abc123', pubkey2))
  })
})

describe('ttl selection', () => {
  it('caches failures for 15 minutes and platform errors for 5 minutes', () => {
    expect(getTtl('failed')).toBe(900)
    expect(getTtl('platform_error')).toBe(300)
  })

  it('throws on verified results — D1 is the success store, KV never holds successes', () => {
    expect(() => getTtl('verified')).toThrow()
  })
})

describe('get/put roundtrip', () => {
  it('stores and reads back a failed result', async () => {
    const key = cacheKey('github', 'octocat', 'missing-gist', pubkey)
    await putCached(env.CACHE_KV, key, { verified: false, error: 'not found', checked_at: 1000, type: 'failed' })
    await expect(getCached(env.CACHE_KV, key)).resolves.toMatchObject({
      verified: false,
      error: 'not found',
      checked_at: 1000,
    })
  })

  it('returns null for missing keys and corrupt JSON', async () => {
    await expect(getCached(env.CACHE_KV, 'v|never|written|x|z')).resolves.toBeNull()
    await env.CACHE_KV.put('v|corrupt|x|y|z', '{nope')
    await expect(getCached(env.CACHE_KV, 'v|corrupt|x|y|z')).resolves.toBeNull()
  })

  it('refuses to store a verified result', async () => {
    await expect(
      putCached(env.CACHE_KV, 'v|nope|x|y|z', { verified: true, checked_at: 1000, type: 'verified' }),
    ).rejects.toThrow()
  })
})

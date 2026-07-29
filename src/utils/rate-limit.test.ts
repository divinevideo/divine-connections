// ABOUTME: Tests for the fixed-window rate limiter on the shared KV namespace.
// ABOUTME: Uses real miniflare KV; no mocks.
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { checkRateLimit, RATE_LIMITS } from './rate-limit'

const WINDOW_SECONDS = 60

function expectedKey(prefix: string, id: string): string {
  return `${prefix}:${id}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}`
}

describe('checkRateLimit', () => {
  it('allows up to the limit in a window, then rejects', async () => {
    const config = { prefix: 'rl:test', limit: 3 }
    for (let i = 0; i < 3; i++) {
      const result = await checkRateLimit(env.CACHE_KV, config, '1.2.3.4')
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(3 - i - 1)
    }
    const rejected = await checkRateLimit(env.CACHE_KV, config, '1.2.3.4')
    expect(rejected.allowed).toBe(false)
    expect(rejected.remaining).toBe(0)
  })

  it('gives a different id its own window', async () => {
    const config = { prefix: 'rl:test2', limit: 1 }
    expect((await checkRateLimit(env.CACHE_KV, config, 'alice')).allowed).toBe(true)
    expect((await checkRateLimit(env.CACHE_KV, config, 'bob')).allowed).toBe(true)
    expect((await checkRateLimit(env.CACHE_KV, config, 'alice')).allowed).toBe(false)
  })

  it('writes keys shaped prefix:id:window with a two-window TTL', async () => {
    const key = expectedKey('rl:ip', '1.2.3.4')
    await checkRateLimit(env.CACHE_KV, RATE_LIMITS.ip, '1.2.3.4')
    await expect(env.CACHE_KV.get(key)).resolves.toBe('1')
    const { keys } = await env.CACHE_KV.list({ prefix: 'rl:ip:1.2.3.4:' })
    expect(keys[0]?.name).toBe(key)
    expect(keys[0]?.expiration).toBeGreaterThan(Date.now() / 1000 + 100)
    expect(keys[0]?.expiration).toBeLessThanOrEqual(Date.now() / 1000 + 121)
  })

  it('exports the ip/pubkey/platform limits used by the verify flow', () => {
    expect(RATE_LIMITS).toEqual({
      ip: { prefix: 'rl:ip', limit: 60 },
      pubkey: { prefix: 'rl:pk', limit: 20 },
      platform: { prefix: 'rl:plat', limit: 30 },
    })
  })
})

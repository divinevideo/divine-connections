// ABOUTME: Tests for the NIP-05 verification route (well-known lookup, SSRF guard,
// ABOUTME: route-level IP limit, KV caching incl. the 24h success exception).
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../index'
import { applyMigrations, PUBKEY_A, PUBKEY_B } from '../db/test-helpers'

describe('nip05 route', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await applyMigrations()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('verifies a matching NIP-05 registration and caches the success', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ names: { alice: PUBKEY_A } }))

    const first = await app.request(`/nip05/verify?name=alice@example.com&pubkey=${PUBKEY_A}`, {}, env)
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      name: 'alice',
      domain: 'example.com',
      pubkey: PUBKEY_A,
      verified: true,
      cached: false,
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.com/.well-known/nostr.json?name=alice')
    expect(init.redirect).toBe('manual')

    const second = await app.request(`/nip05/verify?name=alice@example.com&pubkey=${PUBKEY_A}`, {}, env)
    await expect(second.json()).resolves.toMatchObject({ verified: true, cached: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a pubkey that does not match the registration', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ names: { alice: PUBKEY_B } }))

    const response = await app.request(`/nip05/verify?name=alice@example.com&pubkey=${PUBKEY_A}`, {}, env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      verified: false,
      error: 'Pubkey does not match NIP-05 registration',
    })
  })

  it('caches upstream HTTP failures as platform errors', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 404 }))

    const first = await app.request(`/nip05/verify?name=bob@example.net&pubkey=${PUBKEY_A}`, {}, env)
    await expect(first.json()).resolves.toMatchObject({ verified: false, error: 'NIP-05 fetch failed: HTTP 404' })

    const second = await app.request(`/nip05/verify?name=bob@example.net&pubkey=${PUBKEY_A}`, {}, env)
    await expect(second.json()).resolves.toMatchObject({ verified: false, cached: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects private/internal domains via the SSRF guard', async () => {
    const response = await app.request(`/nip05/verify?name=alice@localhost&pubkey=${PUBKEY_A}`, {}, env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid NIP-05 name format (expected user@domain)' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires name and a valid pubkey', async () => {
    const noName = await app.request(`/nip05/verify?pubkey=${PUBKEY_A}`, {}, env)
    expect(noName.status).toBe(400)
    await expect(noName.json()).resolves.toEqual({ error: 'Missing "name" query parameter (format: user@domain)' })

    const badPubkey = await app.request('/nip05/verify?name=alice@example.com&pubkey=nope', {}, env)
    expect(badPubkey.status).toBe(400)
    await expect(badPubkey.json()).resolves.toEqual({ error: 'Missing or invalid "pubkey" query parameter (64-char hex)' })
  })

  it('keeps route-level IP rate limiting with a 429', async () => {
    const window = Math.floor(Date.now() / 1000 / 60)
    await env.CACHE_KV.put(`rl:ip:5.6.7.8:${window}`, '60', { expirationTtl: 120 })

    const response = await app.request(`/nip05/verify?name=alice@example.com&pubkey=${PUBKEY_A}`, {
      headers: { 'cf-connecting-ip': '5.6.7.8' },
    }, env)
    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({ error: 'Rate limit exceeded' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

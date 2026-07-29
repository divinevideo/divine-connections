// ABOUTME: Tests for the public verify routes' legacy-compatible contract.
// ABOUTME: Real miniflare D1/KV; upstream HTTP stubbed at the fetch boundary only.
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../index'
import { applyMigrations, PUBKEY_A } from '../db/test-helpers'
import { hexToNpub } from '../utils/npub'

const NPUB_A = hexToNpub(PUBKEY_A)

function gistResponse(login: string, content: string): Response {
  return Response.json({ owner: { login }, files: { 'proof.md': { content } } })
}

function gistClaim(overrides: Record<string, string> = {}) {
  return { pubkey: PUBKEY_A, platform: 'github', identity: 'octocat', proof: 'gist-1', ...overrides }
}

describe('verify routes', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await applyMigrations()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST /verify verifies a batch of claims', async () => {
    fetchMock.mockResolvedValueOnce(gistResponse('octocat', NPUB_A))

    const response = await app.request('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claims: [gistClaim()] }),
    }, env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { results: Array<Record<string, unknown>> }
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ platform: 'github', identity: 'octocat', verified: true, cached: false })
  })

  it('POST /verify rejects more than 10 claims', async () => {
    const claims = Array.from({ length: 11 }, (_, i) => gistClaim({ identity: `user${i}` }))
    const response = await app.request('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claims }),
    }, env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Maximum 10 claims per request' })
  })

  it('POST /verify reports per-claim validation failures in the legacy shape', async () => {
    const response = await app.request('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claims: [gistClaim(), gistClaim({ pubkey: 'not-hex' })] }),
    }, env)

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; details: Array<{ index: number; error: string }> }
    expect(body.error).toBe('Validation failed')
    expect(body.details).toHaveLength(1)
    expect(body.details[0]).toMatchObject({ index: 1 })
    expect(body.details[0].error).toContain('Invalid pubkey')
  })

  it('POST /verify/single verifies a flat-body claim', async () => {
    fetchMock.mockResolvedValueOnce(gistResponse('octocat', NPUB_A))

    const response = await app.request('/verify/single', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(gistClaim({ proof: 'gist-single' })),
    }, env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ platform: 'github', verified: true })
  })

  it('POST /verify/single rejects a missing proof for non-bluesky platforms', async () => {
    const response = await app.request('/verify/single', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(gistClaim({ proof: '' })),
    }, env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid or missing proof' })
  })

  it('POST /api/verify aliases /verify/single for divine-web', async () => {
    fetchMock.mockResolvedValueOnce(gistResponse('octocat', NPUB_A))

    const response = await app.request('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(gistClaim({ proof: 'gist-alias' })),
    }, env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ platform: 'github', verified: true })
  })

  it('GET /verify/:platform/:identity/:proof returns JSON by default', async () => {
    fetchMock.mockResolvedValueOnce(gistResponse('octocat', NPUB_A))

    const response = await app.request(`/verify/github/octocat/gist-get?pubkey=${PUBKEY_A}`, {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ platform: 'github', identity: 'octocat', verified: true })
  })

  it('GET /verify/:platform/:identity/:proof renders the HTML result page for browsers', async () => {
    fetchMock.mockResolvedValueOnce(gistResponse('octocat', NPUB_A))

    const response = await app.request(`/verify/github/octocat/gist-html?pubkey=${PUBKEY_A}`, {
      headers: { accept: 'text/html' },
    }, env)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('Divine Identity Verification')
    expect(html).toContain('octocat is verified on GitHub')
    expect(html).not.toContain('octocat is not verified on GitHub')
  })

  it('GET /verify/:platform/* renders the failed HTML page when the proof does not match', async () => {
    fetchMock.mockResolvedValueOnce(gistResponse('octocat', 'npub1someoneelse'))

    const response = await app.request(`/verify/github/octocat/gist-html-fail?pubkey=${PUBKEY_A}`, {
      headers: { accept: 'text/html' },
    }, env)

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('octocat is not verified on GitHub')
  })

  it('GET /verify/:platform/* rejects a missing or invalid pubkey', async () => {
    const missing = await app.request('/verify/github/octocat/gist-1', {}, env)
    expect(missing.status).toBe(400)

    const invalid = await app.request('/verify/github/octocat/gist-1?pubkey=nope', {}, env)
    expect(invalid.status).toBe(400)
  })

  it('returns 200 with verified:false for verification failures, never 4xx/5xx', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: 'Not Found' }, { status: 404 }))

    const response = await app.request('/verify/single', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(gistClaim({ proof: 'gist-missing' })),
    }, env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ verified: false })
  })
})

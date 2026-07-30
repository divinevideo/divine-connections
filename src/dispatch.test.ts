// ABOUTME: Host-dispatch tests: verifier host isolation, crossposter host parity,
// ABOUTME: and the fallback union where the verifier shape wins collision paths.
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { app } from './index'
import { applyMigrations, connection, PUBKEY_A } from './db/test-helpers'
import { upsertConnection } from './db/connections'
import type { Env } from './types'

const VERIFIER = 'https://verifier.divine.video'
const CROSSPOSTER = 'https://crossposter.divine.video'

function dispatchEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as Env),
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    ...overrides,
  }
}

function hostRequest(url: string, init: RequestInit, env: Env): Promise<Response> {
  return Promise.resolve(worker.fetch!(new Request(url, init), env, {} as ExecutionContext))
}

function authResponse(): Response {
  return Response.json({ result: PUBKEY_A })
}

describe('host dispatch', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await applyMigrations()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('verifier.divine.video', () => {
    it('serves the landing page, verifier health, and verifier platforms shape', async () => {
      const landing = await hostRequest(`${VERIFIER}/`, {}, dispatchEnv())
      expect(landing.status).toBe(200)

      const healthRes = await hostRequest(`${VERIFIER}/health`, {}, dispatchEnv())
      await expect(healthRes.json()).resolves.toMatchObject({ status: 'ok', service: 'divine-connections' })

      const platformsRes = await hostRequest(`${VERIFIER}/platforms`, {}, dispatchEnv())
      const body = (await platformsRes.json()) as { platforms: Record<string, { label: string; supported: boolean }> }
      expect(body.platforms.github).toMatchObject({ label: 'GitHub', supported: true })
      expect(body.platforms.x).toMatchObject({ label: 'Twitter / X' })
    })

    it('serves the public verify, verified, and nip05 routes', async () => {
      fetchMock.mockResolvedValueOnce(Response.json({ owner: { login: 'octocat' }, files: { 'p.md': { content: 'junk' } } }))

      const verifyRes = await hostRequest(`${VERIFIER}/verify/single`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pubkey: PUBKEY_A, platform: 'github', identity: 'octocat', proof: 'gist-dispatch' }),
      }, dispatchEnv())
      expect(verifyRes.status).toBe(200)

      const verifiedRes = await hostRequest(`${VERIFIER}/verified/${PUBKEY_A}`, {}, dispatchEnv())
      expect(verifiedRes.status).toBe(200)

      const nip05Res = await hostRequest(`${VERIFIER}/nip05/verify`, {}, dispatchEnv())
      expect(nip05Res.status).toBe(400)
    })

    it('serves the /api/verify alias', async () => {
      fetchMock.mockResolvedValueOnce(Response.json({ owner: { login: 'octocat' }, files: { 'p.md': { content: 'junk' } } }))

      const response = await hostRequest(`${VERIFIER}/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pubkey: PUBKEY_A, platform: 'github', identity: 'octocat', proof: 'gist-alias-dispatch' }),
      }, dispatchEnv())
      expect(response.status).toBe(200)
    })

    it('serves keycast-authenticated connection routes', async () => {
      fetchMock.mockResolvedValueOnce(authResponse())
      const start = await hostRequest(`${VERIFIER}/connections/x/start`, {
        method: 'POST',
        headers: { authorization: 'Bearer keycast-token', 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://verifier.divine.video/' }),
      }, dispatchEnv({ ENABLE_X: 'true', TWITTER_CLIENT_ID: 'x-client', TWITTER_CLIENT_SECRET: 'x-secret' }))
      expect(start.status).toBe(200)

      fetchMock.mockResolvedValueOnce(authResponse())
      const list = await hostRequest(`${VERIFIER}/connections`, {
        headers: { authorization: 'Bearer keycast-token' },
      }, dispatchEnv())
      expect(list.status).toBe(200)

      await upsertConnection(dispatchEnv().DB, connection({ id: 'conn_v', platform: 'x' }))
      fetchMock.mockResolvedValueOnce(authResponse())
      const del = await hostRequest(`${VERIFIER}/connections/x/conn_v`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer keycast-token' },
      }, dispatchEnv())
      expect(del.status).toBe(200)

      const callback = await hostRequest(`${VERIFIER}/connections/x/callback?code=c&state=missing`, {}, dispatchEnv())
      expect(callback.status).toBe(302)
    })

    it('never reaches publisher paths', async () => {
      for (const [method, path] of [
        ['POST', '/videos/abc/crossposts'],
        ['GET', '/jobs/job_1'],
        ['GET', '/preferences'],
        ['POST', '/webhooks/instagram'],
      ] as const) {
        const response = await hostRequest(`${VERIFIER}${path}`, { method }, dispatchEnv())
        expect(response.status).toBe(404)
      }
    })
  })

  describe('crossposter.divine.video', () => {
    it('serves its own home, health, and platforms shapes', async () => {
      const home = await hostRequest(`${CROSSPOSTER}/`, {}, dispatchEnv())
      const html = await home.text()
      expect(html).toContain('<title>Divine Crossposter</title>')

      const healthRes = await hostRequest(`${CROSSPOSTER}/health`, {}, dispatchEnv())
      await expect(healthRes.json()).resolves.toEqual({ ok: true, service: 'divine-connections' })

      const platformsRes = await hostRequest(`${CROSSPOSTER}/platforms?format=json`, {}, dispatchEnv())
      const body = (await platformsRes.json()) as { platforms: Array<{ platform: string; enabled: boolean }> }
      expect(Array.isArray(body.platforms)).toBe(true)
      expect(body.platforms.map((p) => p.platform)).toEqual(['instagram', 'tiktok', 'x', 'youtube'])
    })

    it('does not serve the verifier-only surface', async () => {
      const verifiedRes = await hostRequest(`${CROSSPOSTER}/verified/${PUBKEY_A}`, {}, dispatchEnv())
      expect(verifiedRes.status).toBe(404)

      const nip05Res = await hostRequest(`${CROSSPOSTER}/nip05/verify?name=a@b.co&pubkey=${PUBKEY_A}`, {}, dispatchEnv())
      expect(nip05Res.status).toBe(404)
    })
  })

  describe('fallback host', () => {
    it('serves the union with the verifier shape winning collision paths', async () => {
      const landing = await app.request('/', {}, dispatchEnv())
      expect(landing.status).toBe(200)
      await expect(landing.text()).resolves.not.toContain('<title>Divine Crossposter</title>')

      const healthRes = await app.request('/health', {}, dispatchEnv())
      await expect(healthRes.json()).resolves.toMatchObject({ status: 'ok', service: 'divine-connections' })

      const platformsRes = await app.request('/platforms', {}, dispatchEnv())
      const body = (await platformsRes.json()) as { platforms: Record<string, unknown> }
      expect(body.platforms).toHaveProperty('github')
    })

    it('keeps crossposter provider JSON at /api/providers and crossposter routes reachable', async () => {
      const providers = await app.request('/api/providers', {}, dispatchEnv())
      expect(providers.status).toBe(200)
      const body = (await providers.json()) as { platforms: Array<{ platform: string }> }
      expect(body.platforms.map((p) => p.platform)).toEqual(['instagram', 'tiktok', 'x', 'youtube'])

      fetchMock.mockResolvedValueOnce(authResponse())
      const prefs = await app.request('/preferences', { headers: { authorization: 'Bearer keycast-token' } }, dispatchEnv())
      expect(prefs.status).toBe(200)
    })
  })

  it('dispatches the default export fetch by hostname', async () => {
    const response = await worker.fetch!(
      new Request(`${VERIFIER}/health`),
      dispatchEnv(),
      {} as ExecutionContext,
    )
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', service: 'divine-connections' })
  })
})

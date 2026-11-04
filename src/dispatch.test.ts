// ABOUTME: Host tests: every Host header gets the crossposter app, and none of
// ABOUTME: them reaches the identity-verification routes this worker no longer serves.
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { applyMigrations, PUBKEY_A } from './db/test-helpers'
import type { Env } from './types'

const CROSSPOSTER = 'https://crossposter.divine.video'
const ANY_HOSTS = [
  'crossposter.divine.video',
  'verify.divine.video',
  'verifier.divine.video',
  'unknown.example',
]

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

describe('every host', () => {
  beforeEach(async () => {
    await applyMigrations()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('crossposter.divine.video', () => {
    it('serves its own home, health, and platforms shapes', async () => {
      const home = await hostRequest(`${CROSSPOSTER}/`, {}, dispatchEnv())
      const html = await home.text()
      expect(html).toContain('<title>Divine Crossposter</title>')

      const healthRes = await hostRequest(`${CROSSPOSTER}/health`, {}, dispatchEnv())
      await expect(healthRes.json()).resolves.toEqual({ ok: true, service: 'divine-connections', release: 'unknown' })

      const platformsRes = await hostRequest(`${CROSSPOSTER}/platforms?format=json`, {}, dispatchEnv())
      const body = (await platformsRes.json()) as { platforms: Array<{ platform: string; enabled: boolean }> }
      expect(Array.isArray(body.platforms)).toBe(true)
      expect(body.platforms.map((p) => p.platform)).toEqual(['instagram', 'tiktok', 'x', 'youtube'])
    })

    // CI's post-deploy check reads /api/providers.
    it('serves provider JSON at /api/providers', async () => {
      const providers = await hostRequest(`${CROSSPOSTER}/api/providers`, {}, dispatchEnv())
      expect(providers.status).toBe(200)
      const body = (await providers.json()) as { platforms: Array<{ platform: string }> }
      expect(body.platforms.map((p) => p.platform)).toEqual(['instagram', 'tiktok', 'x', 'youtube'])
    })
  })

  it.each(ANY_HOSTS)('serves the crossposter home page on %s', async (host) => {
    const home = await hostRequest(`https://${host}/`, {}, dispatchEnv())
    expect(home.status).toBe(200)
    await expect(home.text()).resolves.toContain('<title>Divine Crossposter</title>')
  })

  // Identity verification lives in the separate verifier service. These paths
  // were served by the copy this worker used to carry, and must stay gone.
  it.each(ANY_HOSTS)('does not serve the identity-verification routes on %s', async (host) => {
    for (const [method, path] of [
      ['POST', '/verify'],
      ['POST', '/verify/single'],
      ['GET', '/verify/github/x'],
      ['GET', '/verified'],
      ['GET', `/verified/${PUBKEY_A}`],
      ['GET', `/nip05/verify?name=a@b.co&pubkey=${PUBKEY_A}`],
      ['GET', '/docs'],
      ['POST', '/api/verify'],
    ] as const) {
      const response = await hostRequest(`https://${host}${path}`, { method }, dispatchEnv())
      expect(response.status, `${method} ${path}`).toBe(404)
    }
  })
})

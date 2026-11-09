// ABOUTME: Host tests: verify.divine.video redirects to the live verifier, every other
// ABOUTME: host gets the crossposter app, and none reaches the removed verification routes.
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { applyMigrations, PUBKEY_A } from './db/test-helpers'
import type { Env } from './types'

const CROSSPOSTER = 'https://crossposter.divine.video'
const VERIFY = 'https://verify.divine.video'
const ANY_HOSTS = [
  'crossposter.divine.video',
  'verifier.divine.video',
  'unknown.example',
]

function testEnv(): Env {
  return {
    ...(env as Env),
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
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
    it('serves its own health and platforms shapes', async () => {
      const healthRes = await hostRequest(`${CROSSPOSTER}/health`, {}, testEnv())
      await expect(healthRes.json()).resolves.toEqual({ ok: true, service: 'divine-connections', release: 'unknown' })

      const platformsRes = await hostRequest(`${CROSSPOSTER}/platforms?format=json`, {}, testEnv())
      const body = (await platformsRes.json()) as { platforms: Array<{ platform: string; enabled: boolean }> }
      expect(Array.isArray(body.platforms)).toBe(true)
      expect(body.platforms.map((p) => p.platform)).toEqual(['instagram', 'tiktok', 'x', 'youtube', 'snapchat'])
    })

    // CI's post-deploy check reads /api/providers.
    it('serves provider JSON at /api/providers', async () => {
      const providers = await hostRequest(`${CROSSPOSTER}/api/providers`, {}, testEnv())
      expect(providers.status).toBe(200)
      const body = (await providers.json()) as { platforms: Array<{ platform: string }> }
      expect(body.platforms.map((p) => p.platform)).toEqual(['instagram', 'tiktok', 'x', 'youtube', 'snapchat'])
    })
  })

  // verify.divine.video served the verification copy this worker used to carry.
  // Until the cutover finishes it only redirects to the live verifier.
  describe('verify.divine.video', () => {
    it('redirects / to the verifier with a 308', async () => {
      const response = await hostRequest(`${VERIFY}/`, {}, testEnv())
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://verifier.divine.video/')
    })

    it('keeps the path when redirecting', async () => {
      const response = await hostRequest(`${VERIFY}/verified/${PUBKEY_A}`, {}, testEnv())
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe(`https://verifier.divine.video/verified/${PUBKEY_A}`)
    })

    // Sign-in codes arrive at / only; they must not be handed to another
    // service.
    it('drops the query string on /', async () => {
      const response = await hostRequest(`${VERIFY}/?code=x&state=y`, {}, testEnv())
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://verifier.divine.video/')
    })

    // GET calls elsewhere need their query to be answered at all.
    it('keeps the query string on any other path', async () => {
      const response = await hostRequest(`${VERIFY}/nip05/verify?name=alice&pubkey=${PUBKEY_A}`, {}, testEnv())
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe(
        `https://verifier.divine.video/nip05/verify?name=alice&pubkey=${PUBKEY_A}`,
      )
    })

    it('redirects a POST with 308 so the method and body are kept', async () => {
      const response = await hostRequest(
        `${VERIFY}/verify/single`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        testEnv(),
      )
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://verifier.divine.video/verify/single')
    })

    it('allows any origin on the redirect', async () => {
      const response = await hostRequest(`${VERIFY}/health`, { headers: { origin: 'https://divine.video' } }, testEnv())
      expect(response.status).toBe(308)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
    })

    // Cloudflare keeps a trailing dot in the hostname when the request has one.
    it('redirects the fully qualified host with a trailing dot', async () => {
      const response = await hostRequest('https://verify.divine.video./', {}, testEnv())
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://verifier.divine.video/')
    })

    // An open crossposting page on this host makes authenticated connection
    // calls; they must not follow to the verifier.
    it.each([
      ['GET', '/connections'],
      ['GET', '/connections/x/abc'],
      ['DELETE', '/connections/x/abc'],
      ['POST', '/connections/x/start'],
    ] as const)('answers %s %s with 404 instead of redirecting', async (method, path) => {
      const response = await hostRequest(
        `${VERIFY}${path}`,
        { method, headers: { authorization: 'Bearer keycast-token' } },
        testEnv(),
      )
      expect(response.status).toBe(404)
      expect(response.headers.get('location')).toBeNull()
    })

    it('still redirects paths that only start with "connections"', async () => {
      const response = await hostRequest(`${VERIFY}/connectionsx`, {}, testEnv())
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://verifier.divine.video/connectionsx')
    })

    // The CORS preflight answer the verification copy sent on this host.
    it('answers a CORS preflight with 204 and allows any origin', async () => {
      const response = await hostRequest(
        `${VERIFY}/verify/single`,
        {
          method: 'OPTIONS',
          headers: {
            origin: 'https://divine.video',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type',
          },
        },
        testEnv(),
      )
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-allow-methods')).toBe('GET,HEAD,PUT,POST,DELETE,PATCH')
      expect(response.headers.get('access-control-allow-headers')).toBe('content-type')
      expect(response.headers.get('location')).toBeNull()
    })
  })

  it.each(ANY_HOSTS)('serves the crossposter home page on %s', async (host) => {
    const home = await hostRequest(`https://${host}/`, {}, testEnv())
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
      const response = await hostRequest(`https://${host}${path}`, { method }, testEnv())
      expect(response.status, `${method} ${path}`).toBe(404)
    }
  })
})

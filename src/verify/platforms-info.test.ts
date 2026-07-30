// ABOUTME: Tests for the merged platform info behind the verifier surface /platforms.
// ABOUTME: Pure config mapping over Env; no mocks.
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Env } from '../types'
import { getVerificationPlatformInfo, platformsInfoHandler } from './platforms-info'

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    CACHE_KV: {} as KVNamespace,
    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: 'test-key',
    ...overrides,
  }
}

describe('getVerificationPlatformInfo', () => {
  it('covers all nine platforms with legacy keys plus methods', () => {
    const { platforms } = getVerificationPlatformInfo(testEnv())
    expect(Object.keys(platforms).sort()).toEqual(
      ['bluesky', 'discord', 'github', 'instagram', 'mastodon', 'telegram', 'tiktok', 'x', 'youtube'],
    )
    for (const info of Object.values(platforms)) {
      expect(info).toHaveProperty('label')
      expect(info).toHaveProperty('supported')
      expect(info).toHaveProperty('methods')
    }
  })

  it('keeps proof-post-only platforms supported with no configuration', () => {
    const { platforms } = getVerificationPlatformInfo(testEnv())
    for (const key of ['github', 'mastodon', 'telegram', 'bluesky', 'discord'] as const) {
      expect(platforms[key]).toMatchObject({ supported: true, methods: ['proof_post'] })
    }
  })

  it('marks x and tiktok proof-capable even without OAuth, and adds oauth when enabled', () => {
    const bare = getVerificationPlatformInfo(testEnv())
    expect(bare.platforms.x).toMatchObject({ label: 'Twitter / X', supported: true, methods: ['proof_post'] })
    expect(bare.platforms.tiktok).toMatchObject({ supported: true, methods: ['proof_post'] })

    const oauth = getVerificationPlatformInfo(testEnv({
      ENABLE_X: 'true',
      TWITTER_CLIENT_ID: 'x-client',
      TWITTER_CLIENT_SECRET: 'x-secret',
      ENABLE_TIKTOK: 'true',
      TIKTOK_CLIENT_KEY: 'tiktok-client',
      TIKTOK_CLIENT_SECRET: 'tiktok-secret',
    }))
    expect(oauth.platforms.x.methods).toEqual(['oauth', 'proof_post'])
    expect(oauth.platforms.tiktok.methods).toEqual(['oauth', 'proof_post'])
  })

  it('gates instagram entirely on OAuth configuration', () => {
    expect(getVerificationPlatformInfo(testEnv()).platforms.instagram).toMatchObject({
      label: 'Instagram',
      supported: false,
      methods: ['oauth'],
    })

    const enabled = getVerificationPlatformInfo(testEnv({
      ENABLE_INSTAGRAM: 'true',
      INSTAGRAM_CLIENT_ID: 'ig-client',
      INSTAGRAM_CLIENT_SECRET: 'ig-secret',
    }))
    expect(enabled.platforms.instagram).toMatchObject({ supported: true, methods: ['oauth'] })
  })

  it('supports youtube via OAuth even without the proof-post API key', () => {
    const oauthOnly = getVerificationPlatformInfo(testEnv({
      ENABLE_YOUTUBE: 'true',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
    }))
    expect(oauthOnly.platforms.youtube).toMatchObject({ label: 'YouTube', supported: true, methods: ['oauth'] })

    const keyOnly = getVerificationPlatformInfo(testEnv({ YOUTUBE_API_KEY: 'yt-key' }))
    expect(keyOnly.platforms.youtube).toMatchObject({ supported: true, methods: ['proof_post'] })

    const both = getVerificationPlatformInfo(testEnv({
      ENABLE_YOUTUBE: 'true',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      YOUTUBE_API_KEY: 'yt-key',
    }))
    expect(both.platforms.youtube.methods).toEqual(['oauth', 'proof_post'])

    const neither = getVerificationPlatformInfo(testEnv())
    expect(neither.platforms.youtube).toMatchObject({ supported: false, methods: [] })
  })

  it('serves the verifier-shape JSON envelope from the handler', async () => {
    const app = new Hono<{ Bindings: Env }>().get('/platforms', platformsInfoHandler)
    const response = await app.request('/platforms', {}, testEnv())

    expect(response.status).toBe(200)
    const body = (await response.json()) as { platforms: Record<string, { label: string; supported: boolean }> }
    expect(body.platforms.github).toMatchObject({ label: 'GitHub', supported: true })
    expect(body.platforms.x).toMatchObject({ label: 'Twitter / X', supported: true })
  })
})

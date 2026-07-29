// ABOUTME: Tests for the landing page's connections-OAuth rewiring and the
// ABOUTME: removal of every legacy /auth/* call path from the page JS.
import { describe, it, expect } from 'vitest'
import { renderLandingPage } from './landing'
import type { Env } from '../types'

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

const allProvidersEnv = testEnv({
  ENABLE_X: 'true',
  TWITTER_CLIENT_ID: 'x-client',
  TWITTER_CLIENT_SECRET: 'x-secret',
  ENABLE_INSTAGRAM: 'true',
  INSTAGRAM_CLIENT_ID: 'ig-client',
  INSTAGRAM_CLIENT_SECRET: 'ig-secret',
  ENABLE_TIKTOK: 'true',
  TIKTOK_CLIENT_KEY: 'tt-client',
  TIKTOK_CLIENT_SECRET: 'tt-secret',
  ENABLE_YOUTUBE: 'true',
  GOOGLE_CLIENT_ID: 'g-client',
  GOOGLE_CLIENT_SECRET: 'g-secret',
})

const html = renderLandingPage(allProvidersEnv, 'https://verifier.divine.video')

describe('landing page connections wiring', () => {
  it('starts Quick Connect via POST /connections/:platform/start with a keycast bearer', () => {
    expect(html).toContain("'/connections/' + platform + '/start'")
    expect(html).toContain("'Authorization': 'Bearer ' + session.accessToken")
    expect(html).toContain('returnUrl: window.location.origin')
    expect(html).toContain('data.authorizationUrl')
  })

  it('offers exactly x, instagram, tiktok, and youtube when all providers are enabled', () => {
    expect(html).toContain('<option value="x">Twitter / X</option>')
    expect(html).toContain('<option value="instagram">Instagram</option>')
    expect(html).toContain('<option value="tiktok">TikTok</option>')
    expect(html).toContain('<option value="youtube">YouTube</option>')
    expect(html).not.toContain('oauth-bluesky-handle-wrap')
  })

  it('contains no legacy /auth/* call paths', () => {
    expect(html).not.toContain('/auth/twitter/start')
    expect(html).not.toContain('/auth/bluesky/start')
    expect(html).not.toContain('/auth/youtube/start')
    expect(html).not.toContain('/auth/tiktok/start')
    expect(html).not.toContain('/auth/nostr/login')
    expect(html).not.toContain('/auth/oauth/revoke')
    expect(html).not.toContain('/auth/twitter/status')
    expect(html).not.toContain("'/auth/'")
  })

  it('reads the new connection= callback params, not oauth_verified', () => {
    expect(html).toContain("params.get('connection')")
    expect(html).not.toContain('oauth_verified')
  })

  it('keeps the kind 10011 publish wiring and the embed bridge script', () => {
    expect(html).toContain('kind: 10011')
    expect(html).toContain('installDivineEmbedBridge')
  })

  it('loads the manage list from /verified/:pubkey', () => {
    expect(html).toContain("'/verified/' + pubkey")
  })

  it('revokes OAuth rows via DELETE /connections and shows no revoke for proof posts', () => {
    expect(html).toContain("method: 'DELETE'")
    expect(html).toContain('re-verify to replace')
  })

  it('omits Quick Connect options for unconfigured providers', () => {
    const bare = renderLandingPage(testEnv(), 'https://verifier.divine.video')
    const oauthSelect = bare.match(/<select id="oauth-platform-select"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? ''
    expect(oauthSelect).not.toContain('<option')

    // Proof-post platforms stay offered; TikTok oEmbed needs no app credentials.
    const proofSelect = bare.match(/<select id="proof-platform-select"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? ''
    expect(proofSelect).toContain('<option value="tiktok">')
  })

  it('explains Quick Connect instead of showing an empty dropdown when no providers are configured', () => {
    const bare = renderLandingPage(testEnv(), 'https://verifier.divine.video')
    expect(bare).toContain('No connection providers are configured on this deployment yet')
    expect(bare).not.toContain('Continue to secure sign-in')

    expect(html).toContain('Continue to secure sign-in')
  })

  it('clears the Loading placeholder when the manage list fails to load', () => {
    const catchBlock = html.match(/async function loadLinkedVerifications[\s\S]*?catch \(e\) \{[\s\S]*?\}/)?.[0] ?? ''
    expect(catchBlock).toContain("container.textContent = '';")
  })

  it('says what is happening when no browser signer exists instead of silently falling back', () => {
    expect(html).toContain('No browser signer found')
    expect(html).toContain('login.divine.video instead')
  })

  it('labels the sign-in paths for humans', () => {
    expect(html).toContain('Sign in to your Divine account')
    expect(html).not.toContain('Sign in with your Nostr account')
    expect(html).toContain('Use browser signer (NIP-07)')
    expect(html).toContain('Sign in above, or paste your account')
  })
})

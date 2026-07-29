// ABOUTME: Tests pinning the landing page's kind-10011 publish, manage, and
// ABOUTME: revoke wiring plus its footer links. Reads the rendered HTML.
import { describe, it, expect } from 'vitest'
import { renderLandingPage } from './routes/landing'
import type { Env } from './types'

function testEnv(): Env {
  return {
    DB: {} as D1Database,
    CACHE_KV: {} as KVNamespace,
    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: 'test-key',
  }
}

const html = renderLandingPage(testEnv(), 'https://verifier.divine.video')

describe('kind 10011 migration', () => {
  it('publish function uses kind 10011, not kind 0', () => {
    expect(html).toContain('kind: 10011')
    expect(html).not.toMatch(/unsignedEvent\s*=\s*\{[^}]*kind:\s*0/)
  })

  it('fetchIdentityEvent queries kind 10011', () => {
    expect(html).toContain('fetchIdentityEvent')
  })

  it('doLookup reads from both kind 10011 and kind 0', () => {
    expect(html).toContain('fetchIdentityEvent')
    expect(html).toContain('fetchProfileLegacy')
  })
})

describe('manage linked verifications UI', () => {
  it('serves a manage section with load and remove controls', () => {
    expect(html).toContain('Manage verified links')
    expect(html).toContain('loadLinkedVerifications')
  })
})

describe('remove verification flow', () => {
  it('includes confirmation dialog markup', () => {
    expect(html).toContain('Remove this verification?')
    expect(html).toContain('confirmRemoveVerification')
  })

  it('disconnects the connection to revoke OAuth verifications', () => {
    expect(html).toContain("'/connections/' + platform + '/' + exact.id")
    expect(html).toContain("method: 'DELETE'")
    expect(html).not.toContain('/auth/oauth/revoke')
  })
})

describe('footer', () => {
  it('links to the privacy policy and terms of service', () => {
    expect(html).toContain('https://divine.video/privacy')
    expect(html).toContain('https://divine.video/terms')
  })
})

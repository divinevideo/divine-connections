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

// The page attaches listeners by id at startup. If any of those ids is absent
// from the markup, the whole init block throws at that line and every later
// binding silently never happens — which is how a deployment with no OAuth
// providers ended up with a dead "Verify this link" button.
describe('landing page event wiring integrity', () => {
  const noProvidersEnv = testEnv()

  function listenerTargets(page: string): string[] {
    const ids = new Set<string>()
    for (const m of page.matchAll(/getElementById\('([^']+)'\)\s*\.addEventListener/g)) ids.add(m[1])
    for (const m of page.matchAll(/bindEvent\('([^']+)'/g)) ids.add(m[1])
    return [...ids]
  }

  for (const [name, env] of [
    ['every provider enabled', allProvidersEnv],
    ['no providers configured', noProvidersEnv],
  ] as const) {
    it(`binds listeners only to elements that exist (${name})`, () => {
      const page = renderLandingPage(env, 'https://verifier.divine.video')
      const targets = listenerTargets(page)
      expect(targets.length).toBeGreaterThan(0)

      const missing = targets.filter((id) => !page.includes(`id="${id}"`))
      expect(missing).toEqual([])
    })
  }

  it('does not label a Platform control that is absent without providers', () => {
    const page = renderLandingPage(noProvidersEnv, 'https://verifier.divine.video')
    expect(page).not.toContain('id="oauth-platform-select"')
    expect(page).not.toContain('for="oauth-platform-select"')
  })
})

// The page described its platform support in four places that had drifted apart:
// Instagram was missing from the chips, YouTube from the API table, and Bluesky
// was advertised as OAuth-capable even though that is deferred (#1). All of it now
// renders from one capability matrix.
describe('landing page platform capability matrix', () => {
  const noProvidersEnv = testEnv()
  const ALL_NINE = ['Twitter / X', 'Instagram', 'YouTube', 'TikTok', 'GitHub', 'Bluesky', 'Mastodon', 'Telegram', 'Discord']

  // Split on the markup, not the CSS rule of the same name.
  const chipMarkup = (page: string) => page.split('<div class="platform-grid">')[1].split('</div>')[0]

  it('shows every supported platform in the hero chips, including Instagram', () => {
    const chips = chipMarkup(html)
    for (const label of ALL_NINE) expect(chips).toContain(label)
  })

  it('makes the hero chips jump to the verify section instead of looking inert', () => {
    expect(chipMarkup(html)).toContain('href="#verify-here"')
  })

  it('documents Quick Connect only for platforms that have an OAuth adapter', () => {
    const table = html.split('Supported Platforms')[1].split('</table>')[0]
    for (const key of ['x', 'instagram', 'youtube', 'tiktok', 'github', 'bluesky', 'mastodon', 'telegram', 'discord']) {
      expect(table).toContain(`<code>${key}</code>`)
    }
    // Bluesky OAuth is deferred, so it must not be advertised as available.
    const blueskyRow = table.split('<code>bluesky</code>')[1].split('</tr>')[0]
    expect(blueskyRow).not.toContain('>Yes<')
  })

  it('marks Instagram as connect-only, since it has no proof-post verifier', () => {
    const table = html.split('Supported Platforms')[1].split('</table>')[0]
    const igRow = table.split('<code>instagram</code>')[1].split('</tr>')[0]
    expect(igRow).toContain('Not supported')
    // And it must never appear as a proof-post option in the advanced form.
    const proofSelect = html.split('id="proof-platform-select"')[1].split('</select>')[0]
    expect(proofSelect).not.toContain('instagram')
  })

  it('offers YouTube as a proof-post option when its API key is configured', () => {
    const withKey = renderLandingPage(testEnv({ YOUTUBE_API_KEY: 'yt-key' }), 'https://verifier.divine.video')
    const proofSelect = withKey.split('id="proof-platform-select"')[1].split('</select>')[0]
    expect(proofSelect).toContain('youtube')
  })

  it('stops calling Quick Connect "Recommended" and opens the proof form when no provider is live', () => {
    const page = renderLandingPage(noProvidersEnv, 'https://verifier.divine.video')
    expect(page).not.toContain('Step 2 (Recommended)')
    expect(page).toContain('<details class="advanced-proof" id="advanced-proof" open>')
  })

  it('keeps Quick Connect as the recommended path when providers are live', () => {
    expect(html).toContain('Step 2 (Recommended)')
    expect(html).toContain('<details class="advanced-proof" id="advanced-proof">')
  })
})

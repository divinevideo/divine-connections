// ABOUTME: Tests for the landing page's connections-OAuth rewiring and the
// ABOUTME: removal of every legacy /auth/* call path from the page JS.
import { describe, it, expect } from 'vitest'
import { renderLandingPage } from './landing'
import { hexToNpub } from '../utils/npub'
import { app } from '../index'
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

  // Rendering the Quick Connect card with nothing in it produced a tall empty
  // box that said "Sign in with the platform account you want to link" and then
  // admitted there was nothing to sign in with. Omit the step entirely instead,
  // and promote proof-post verification from "Step 3 (Advanced)" to Step 2.
  it('omits the Quick Connect step entirely when no providers are configured', () => {
    const bare = renderLandingPage(testEnv(), 'https://verifier.divine.video')

    expect(bare).not.toContain('Quick Connect (no posting)')
    expect(bare).not.toContain('Sign in with the platform account you want to link')
    expect(bare).not.toContain('No connection providers are configured on this deployment yet')
    expect(bare).not.toContain('Continue to secure sign-in')
  })

  it('renumbers proof verification to Step 2 when Quick Connect is absent', () => {
    const bare = renderLandingPage(testEnv(), 'https://verifier.divine.video')

    expect(bare).toContain('Step 2: verify an account by post or link')
    expect(bare).not.toContain('Step 3 (Advanced)')
  })

  it('keeps Quick Connect as Step 2 and proof as Step 3 when providers exist', () => {
    expect(html).toContain('Quick Connect (no posting)')
    expect(html).toContain('Step 2 (Recommended)')
    expect(html).toContain('Step 3 (Advanced)')
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

  it('never offers Instagram as a proof-post option, since it has no verifier', () => {
    // The API table's view of this moved to the docs page with the reference.
    const proofSelect = html.split('id="proof-platform-select"')[1].split('</select>')[0]
    expect(proofSelect).not.toContain('instagram')
  })

  it('offers YouTube as a proof-post option when its API key is configured', () => {
    const withKey = renderLandingPage(testEnv({ YOUTUBE_API_KEY: 'yt-key' }), 'https://verifier.divine.video')
    const proofSelect = withKey.split('id="proof-platform-select"')[1].split('</select>')[0]
    expect(proofSelect).toContain('youtube')
  })


  it('drops Discord from the proof form until its bot token is configured', () => {
    const noToken = renderLandingPage(noProvidersEnv, 'https://verifier.divine.video')
    expect(noToken.split('id="proof-platform-select"')[1].split('</select>')[0]).not.toContain('discord')

    const withToken = renderLandingPage(testEnv({ DISCORD_BOT_TOKEN: 'bot' }), 'https://verifier.divine.video')
    expect(withToken.split('id="proof-platform-select"')[1].split('</select>')[0]).toContain('discord')
  })

  it('never suggests a Discord server invite anywhere on the page', () => {
    const withToken = renderLandingPage(testEnv({ DISCORD_BOT_TOKEN: 'bot' }), 'https://verifier.divine.video')
    expect(withToken).not.toContain('discord.gg')
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

// A verification recorded by this service was invisible in "Look up someone":
// the lookup only read NIP-39 i-tags from relays, so a proof-post or OAuth
// verification sitting in the verifications table showed as "no claims" until the
// user separately published a NIP-39 tag — which needs a signer session.
describe('landing page lookup reads the verifications store', () => {
  it('queries /verified/:pubkey so recorded verifications show without a NIP-39 tag', () => {
    const lookup = html.split('async function doLookup')[1].split('\n    }')[0]
    expect(lookup).toContain("'/verified/'")
  })

  it('does not dereference an undeclared `profile` variable', () => {
    // `doLookup` resolves `legacyProfile`, never `profile`; the stray reference threw
    // ReferenceError for every pubkey that actually had supported i-tags.
    const lookup = html.split('async function doLookup')[1].split('\n    }')[0]
    expect(lookup).not.toMatch(/tryParseJSON\(profile\./)
  })
})

// Stored verifications arrive in one fast request, but the lookup used to hold them
// back until the relay round-trip finished — up to ~25s of "Checking verified
// links..." with an empty table, which reads as broken. Render what we already know
// first, then enrich once relays answer.
describe('landing page lookup renders stored results before waiting on relays', () => {
  const lookupBody = () => html.split('async function doLookup')[1].split('\n    }')[0]

  it('renders the stored verifications before the relay fetch begins', () => {
    const lookup = lookupBody()
    const earlyRender = lookup.indexOf('renderResults(storedResults')
    const relayFetch = lookup.indexOf('fetchIdentityEvent')

    expect(earlyRender).toBeGreaterThan(-1)
    expect(relayFetch).toBeGreaterThan(-1)
    expect(earlyRender).toBeLessThan(relayFetch)
  })

  it('tells the reader the relay check is still running', () => {
    expect(lookupBody()).toContain('Checking relays')
  })
})

// The landing page is one HTML document with all of its JS inlined, so a stale
// copy in a browser cache means a tester runs last week's code and reports bugs
// that are already fixed. It shipped with no Cache-Control at all, which leaves
// freshness entirely to heuristic browser caching.
describe('landing page cache headers', () => {
  const dispatchEnv = () => testEnv()

  it('tells the browser to revalidate instead of serving from cache blindly', async () => {
    const response = await app.request('/', {}, dispatchEnv())

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-cache')
  })

  it('always answers with the current page rather than a conditional 304', async () => {
    // Cloudflare strips `ETag` from this worker's responses at the edge, so we
    // never issue a validator and must never answer 304 to a client that
    // invented one. Every load returns the page as it is right now.
    const response = await app.request(
      '/',
      { headers: { 'if-none-match': 'W/"deadbeef"' } },
      dispatchEnv(),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<!DOCTYPE html>')
  })

  it('does not compute an ETag the edge will discard', async () => {
    const response = await app.request('/', {}, dispatchEnv())

    expect(response.headers.get('etag')).toBeNull()
  })
})

// keycast decides which form to show from the authorize URL:
//
//   const defaultRegister = params.get('default_register') === 'true'
//   if (defaultRegister || byokPubkey) showForm('register'); else showForm('login')
//
// We were sending default_register=true, so a button labelled "sign in" landed
// existing users on "Create account". Both views already link to each other, so
// letting keycast default to login costs a new user one click and stops sending
// returning users to the wrong form.
describe('landing page sign-in lands on the sign-in form', () => {
  it('does not force keycast into its register view', () => {
    // Asserts the parameter is never set, rather than that the string is
    // absent — the comment explaining this decision names it too.
    expect(html).not.toMatch(/searchParams\.set\(\s*'default_register'/)
  })

  it('still starts the authorize round trip with the PKCE parameters', () => {
    expect(html).toContain("url.searchParams.set('client_id', KEYCAST_CLIENT_ID)")
    expect(html).toContain("url.searchParams.set('code_challenge_method', 'S256')")
    expect(html).toContain("url.searchParams.set('redirect_uri', getKeycastRedirectUrl())")
  })
})

// Signing in changed almost nothing on screen: all three sign-in buttons, the
// account paste field, the "if a signer session is not available" fallback copy
// and the remote-signer disclosure all stayed, with a one-line "Connected"
// note underneath. The screen should reflect that you are done with step 1.
describe('landing page collapses step 1 once a signer is active', () => {
  it('wraps the sign-in controls so they can be hidden together', () => {
    expect(html).toContain('id="signin-controls"')
  })

  it('renders a signed-in panel that starts hidden', () => {
    const panel = html.match(/<div id="signed-in-panel"[^>]*>/)?.[0] ?? ''
    expect(panel).toBeTruthy()
    expect(panel).toContain('display:none')
  })

  it('swaps controls for the signed-in panel when a key is active', () => {
    const summary = html.split('function updateSignerSummary')[1].split('\n    }')[0]

    expect(summary).toContain("getElementById('signin-controls')")
    expect(summary).toContain("getElementById('signed-in-panel')")
    // The active key is what decides, not merely having clicked a button.
    expect(summary).toContain('signerPubkeyHex')
  })

  it('names the account you are signed in as', () => {
    expect(html).toContain('id="signed-in-identity"')
  })

  it('offers a way back out to sign in as somebody else', () => {
    expect(html).toContain('id="sign-out-btn"')

    const signOut = html.split('function signOutSigner')[1]?.split('\n    }')[0] ?? ''
    expect(signOut).toContain('clearKeycastSession()')
    expect(signOut).toContain('signerPubkeyHex = null')
    expect(signOut).toContain('updateSignerSummary()')
  })
})

// "d95aa8fc0eff...8b5ae540 via login.divine.video" tells a person nothing about
// who they are signed in as. The page already fetches kind 0 metadata for the
// lookup tool; use the same path to show a name.
describe('landing page names the signed-in account', () => {
  it('resolves a display name from the signer pubkey', () => {
    expect(html).toContain('function resolveSignerDisplayName')

    const resolver = html.split('async function resolveSignerDisplayName')[1].split('\n    }')[0]
    expect(resolver).toContain('fetchProfileLegacy')
    expect(resolver).toContain('display_name')
    expect(resolver).toContain('nip05')
  })

  it('falls back to an npub rather than raw hex', () => {
    expect(html).toContain('function hexToNpub')

    const summary = html.split('function updateSignerSummary')[1].split('\n    }')[0]
    expect(summary).toContain('hexToNpub')
  })

  it('encodes npub with the bech32 checksum, not just the charset', () => {
    const encoder = html.split('function hexToNpub')[1].split('\n    }')[0]
    expect(encoder).toContain('bech32Checksum')
  })
})

// Most people have no NIP-07 extension — the page's own fallback copy says as
// much ("No browser signer found... login.divine.video instead"). Leading with
// the extension button sends the majority down the path that fails for them.
describe('landing page leads with the hosted sign-in', () => {
  const signinBlock = () =>
    html.split('id="signin-controls"')[1].split('</div>')[0]

  it('offers the Divine account sign-in before the browser extension', () => {
    const block = signinBlock()
    const keycast = block.indexOf('connect-keycast-btn')
    const nip07 = block.indexOf('connect-nostr-btn')

    expect(keycast).toBeGreaterThan(-1)
    expect(nip07).toBeGreaterThan(-1)
    expect(keycast).toBeLessThan(nip07)
  })

  it('styles the hosted sign-in as the primary action', () => {
    const block = signinBlock()
    const keycastBtn = block.match(/<button id="connect-keycast-btn"[^>]*>/)?.[0] ?? ''
    const nip07Btn = block.match(/<button id="connect-nostr-btn"[^>]*>/)?.[0] ?? ''

    expect(keycastBtn).toContain('verify-btn-primary')
    expect(nip07Btn).not.toContain('verify-btn-primary')
  })
})

// Asserting that the encoder exists proves nothing about whether it produces a
// valid npub, and a wrong one would be worse than showing hex. Extract the
// functions the page ships and check them against the server implementation.
describe('landing page npub encoder is actually correct', () => {
  const src = html.split('function bech32Checksum')[1]
  const body =
    'const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";\nfunction bech32Checksum' +
    src.split('function shortNpub')[0] +
    '\nreturn hexToNpub;'
  // eslint-disable-next-line no-new-func
  const pageHexToNpub = new Function(body)() as (hex: string) => string

  it.each([
    '0000000000000000000000000000000000000000000000000000000000000001',
    'd95aa8fc0eff8e488952495b8064991d27fb96f1a4c0a1b2c3d4e5f60718b5ae',
    'ae35ec87e49f3ca2c92a0bbb40c507ae4a6a8e01de29eb9518bc941ed285f943',
    '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e',
  ])('matches the server encoder for %s', (hex) => {
    expect(pageHexToNpub(hex)).toBe(hexToNpub(hex))
  })

  it('returns empty string for input that is not a 64-char hex key', () => {
    expect(pageHexToNpub('not-hex')).toBe('')
    expect(pageHexToNpub('')).toBe('')
  })
})

// Picking a platform from a bare <select> gives no sense of what the product
// connects to. The capability matrix already carries an SVG path per platform —
// the hero chips use it — so the picker can use the same artwork.
describe('landing page platform picker uses logos', () => {
  const picker = (page: string) =>
    page.match(/<div class="platform-picker"[\s\S]*?<\/div>\s*<select id="proof-platform-select"/)?.[0] ?? ''

  it('renders a clickable choice per proof-capable platform', () => {
    const markup = picker(html)
    for (const label of ['GitHub', 'Twitter / X', 'Bluesky', 'Mastodon', 'Telegram', 'TikTok']) {
      expect(markup).toContain(label)
    }
  })

  it('gives every choice its logo', () => {
    const markup = picker(html)
    const buttons = markup.match(/<button[^>]*class="platform-choice"/g) ?? []
    const svgs = markup.match(/<svg viewBox="0 0 24 24"/g) ?? []

    expect(buttons.length).toBeGreaterThanOrEqual(6)
    expect(svgs.length).toBe(buttons.length)
  })

  it('includes TikTok as a first-class choice, not a leftover', () => {
    expect(picker(html)).toContain('data-platform="tiktok"')
  })

  it('sends the same platform values the API expects, including the x/twitter alias', () => {
    const markup = picker(html)
    expect(markup).toContain('data-platform="twitter"')
    expect(markup).not.toContain('data-platform="x"')
  })

  it('starts on GitHub, matching the default the select already had', () => {
    const first = picker(html).match(/<button[^>]*data-platform="([^"]+)"[^>]*aria-checked="true"/)
    expect(first?.[1]).toBe('github')
  })

  it('keeps a real radio group rather than unlabelled buttons', () => {
    const markup = picker(html)
    expect(markup).toContain('role="radiogroup"')
    expect((markup.match(/role="radio"/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it('keeps the select as the state the rest of the page already reads', () => {
    // Six call sites read proof-platform-select.value; the picker drives it
    // rather than replacing it, so none of them had to change.
    expect(html).toContain('<select id="proof-platform-select"')
    expect(html).toMatch(/<select id="proof-platform-select"[^>]*(hidden|display:\s*none)/)
  })

  it('drives the select and re-runs the existing change handler', () => {
    const wiring = html.split('function bindPlatformPicker')[1].split('\n    }')[0]
    expect(wiring).toContain('platform-choice')
    expect(wiring).toContain("dispatchEvent(new Event('change'))")
    expect(wiring).toContain('aria-checked')
  })

  it('omits platforms whose proof path needs a secret this deployment lacks', () => {
    // discord and youtube are gated on DISCORD_BOT_TOKEN / YOUTUBE_API_KEY.
    const markup = picker(html)
    expect(markup).not.toContain('data-platform="discord"')
    expect(markup).not.toContain('data-platform="youtube"')
  })
})

// "Reconnected login.divine.video signer session." fired on page load whenever
// a stored session was restored. It describes our plumbing, not anything the
// reader did, and the signed-in panel already says who they are — so restoring
// a session should be silent. Messages are for actions people just took.
describe('landing page does not narrate session plumbing', () => {
  it('restores a stored session without announcing it', () => {
    const restore = html.split('async function restoreKeycastSession')[1].split('\n    }')[0]

    expect(restore).toContain('activateSigner')
    expect(restore).not.toContain('Reconnected')
    expect(restore).not.toContain('signer session')
  })

  it('says nothing about "signer sessions" anywhere a user can read it', () => {
    expect(html).not.toContain('Reconnected login.divine.video signer session')
  })

  it('still confirms a sign-in the reader actually initiated', () => {
    expect(html).toContain("'browser', 'Signed in with your browser signer.'")
    expect(html).toContain("'keycast', 'Signed in with Divine.'")
  })
})

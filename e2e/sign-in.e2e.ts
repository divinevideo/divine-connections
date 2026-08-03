// ABOUTME: End-to-end check that keycast will actually accept a sign-in started
// ABOUTME: from this deployment's origin — the precondition every signer flow needs.
import { describe, expect, it } from 'vitest'
import { BASE_URL } from './support/deployment'

// The exact client the landing page identifies as. Keycast matches its
// redirect_uri allowlist per client, so this string has to stay in step with
// KEYCAST_CLIENT_ID in src/routes/landing.ts.
const KEYCAST_CLIENT_ID = 'Divine Identity Verification'
const KEYCAST_BASE = 'https://login.divine.video'

// Reproduces the authorize URL that startKeycastLogin() sends the browser to,
// including the redirect_uri that getKeycastRedirectUrl() derives from the
// page's own origin.
function authorizeUrl(origin: string): string {
  const url = new URL(`${KEYCAST_BASE}/api/oauth/authorize`)
  url.searchParams.set('client_id', KEYCAST_CLIENT_ID)
  url.searchParams.set('redirect_uri', `${origin}/`)
  url.searchParams.set('scope', 'sign_event')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('code_challenge', 'e2e-probe-challenge')
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', 'e2e-probe-state')
  return url.toString()
}

// Sign-in is the gate in front of everything a signed-in user can do: no
// keycast session means no signer, which means the NIP-39 identity event can
// never be published, which means a completed verification looks to the user
// like nothing happened. Testers hit exactly this and reported the app as
// broken. It is a deployment/allowlist fact rather than a code fact, so no
// unit test can see it — which is why it lives here.
describe('keycast accepts a sign-in started from this deployment', () => {
  it('does not reject this origin as a redirect_uri', async () => {
    const response = await fetch(authorizeUrl(BASE_URL))
    const body = await response.text()

    expect(
      body,
      `keycast refuses to redirect back to ${BASE_URL}. Sign-in cannot work from this origin, ` +
        `so no signer session, no NIP-39 publish, and every verification looks like it failed. ` +
        `Fix by allowlisting this redirect_uri for the '${KEYCAST_CLIENT_ID}' client, or by ` +
        `completing the domain cutover (issue #2) onto an origin that is already allowed.`,
    ).not.toMatch(/redirect_uri .* is not allowed/i)
  })

  it('serves the sign-in page rather than an error payload', async () => {
    const response = await fetch(authorizeUrl(BASE_URL))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('<!DOCTYPE html>')
  })
})

// Records which origins keycast already trusts. These are the destinations the
// cutover can move onto without touching keycast configuration at all, so a
// change here is a change in what the cutover is allowed to assume.
describe('the production verifier origins are already allowlisted', () => {
  it.each(['https://verify.divine.video', 'https://verifier.divine.video'])(
    'keycast accepts %s as a redirect_uri',
    async (origin) => {
      const body = await (await fetch(authorizeUrl(origin))).text()

      expect(body).not.toMatch(/redirect_uri .* is not allowed/i)
    },
  )
})

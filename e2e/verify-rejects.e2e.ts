// ABOUTME: End-to-end proof that the live deployment refuses forged and malformed
// ABOUTME: verification claims, calling the real upstream platform APIs to decide.
import { describe, expect, it } from 'vitest'
import { postJson, UNCLAIMED_PUBKEY, verifySingle, type VerifyResult } from './support/deployment'

// GitHub allows 60 unauthenticated API calls per hour per IP, and a Worker's
// egress IPs are shared across the whole Cloudflare edge — so without a
// GITHUB_TOKEN on the deployment that budget is being spent by strangers and
// every GitHub verification returns 403. That is an outage, not a verdict about
// the proof, and it must not be reported as though the forgery check failed.
function assertUpstreamAnswered(body: VerifyResult): void {
  expect(
    body.error ?? '',
    'GitHub refused the request rather than answering it. Unauthenticated calls are ' +
      'limited to 60/hour per IP and Cloudflare egress IPs are shared, so this affects ' +
      'real users, not just this test. Install a token: npx wrangler secret put GITHUB_TOKEN',
  ).not.toMatch(/API error: (401|403|429)/)
}

// A real, long-lived gist owned by GitHub's own mascot account. Nothing about
// this test depends on its contents beyond the fact that octocat owns it and
// that it does not contain our unclaimed npub.
const OCTOCAT_GIST = '6cad326836d38bd3a7ae'
const OCTOCAT = 'octocat'

describe('the deployment refuses proof that does not prove anything', () => {
  it('rejects a gist owned by somebody other than the claimed identity', async () => {
    // The forgery this blocks: point at any public gist and claim to be its owner.
    const { status, body } = await verifySingle({
      platform: 'github',
      identity: 'definitely-not-octocat',
      proof: OCTOCAT_GIST,
      pubkey: UNCLAIMED_PUBKEY,
    })

    expect(status).toBe(200)
    expect(body.verified).toBe(false)
    assertUpstreamAnswered(body)
    expect(body.error).toMatch(/owner/i)
  })

  it('rejects a real gist owned by the claimed identity that lacks the npub', async () => {
    // Ownership alone is not proof: the claimant must have written *their* npub
    // into it, which is what ties the GitHub account to the Nostr key.
    const { status, body } = await verifySingle({
      platform: 'github',
      identity: OCTOCAT,
      proof: OCTOCAT_GIST,
      pubkey: UNCLAIMED_PUBKEY,
    })

    expect(status).toBe(200)
    expect(body.verified).toBe(false)
    assertUpstreamAnswered(body)
    expect(body.error).toMatch(/npub not found/i)
  })

  it('rejects a gist that does not exist', async () => {
    const { body } = await verifySingle({
      platform: 'github',
      identity: OCTOCAT,
      proof: '00000000000000000000000000000000',
      pubkey: UNCLAIMED_PUBKEY,
    })

    expect(body.verified).toBe(false)
    assertUpstreamAnswered(body)
    expect(body.error).toMatch(/not found/i)
  })
})

// Regression net for the forgery fixed in divine-connections#20 and
// divine-identify-verification-service#32. Accepting a server invite as proof
// let anyone verify any Discord handle: create a server, put the target's npub
// in its description, hand over the invite. The invite says nothing about who
// owns the account presenting it.
describe('the deployment refuses Discord server invites as proof of account ownership', () => {
  it.each([
    ['an invite code', 'discord-gg-invite-code'],
    ['an invite URL', 'https://discord.gg/discord-gg-invite-code'],
  ])('does not verify a Discord identity from %s', async (_label, proof) => {
    const { status, body } = await verifySingle({
      platform: 'discord',
      identity: 'someone-elses-handle',
      proof,
      pubkey: UNCLAIMED_PUBKEY,
    })

    expect(status).toBe(200)
    // The security invariant, which must hold whether or not this deployment
    // has DISCORD_BOT_TOKEN installed. An unconfigured deployment refuses for a
    // different reason, but it must still refuse.
    expect(body.verified).toBe(false)
  })
})

describe('the deployment rejects malformed claims before calling any upstream', () => {
  it('rejects a pubkey that is not 64-char hex', async () => {
    const { status, body } = await verifySingle({
      platform: 'github',
      identity: OCTOCAT,
      proof: OCTOCAT_GIST,
      pubkey: 'npub1definitelynothex',
    })

    expect(status).toBe(400)
    expect(body.error).toMatch(/pubkey/i)
  })

  it('rejects an unknown platform', async () => {
    const { status, body } = await verifySingle({
      platform: 'friendster',
      identity: 'someone',
      proof: 'whatever',
      pubkey: UNCLAIMED_PUBKEY,
    })

    expect(status).toBe(400)
    expect(body.error).toMatch(/platform/i)
  })

  it.each([
    ['angle brackets', '<script>alert(1)</script>'],
    ['a quote', "o'brien\"; DROP TABLE verifications;--"],
    ['a backtick', 'name`whoami`'],
  ])('rejects an identity containing %s', async (_label, identity) => {
    const { status } = await verifySingle({
      platform: 'github',
      identity,
      proof: OCTOCAT_GIST,
      pubkey: UNCLAIMED_PUBKEY,
    })

    expect(status).toBe(400)
  })

  it('rejects a batch larger than the documented maximum', async () => {
    const claims = Array.from({ length: 11 }, () => ({
      platform: 'github',
      identity: OCTOCAT,
      proof: OCTOCAT_GIST,
      pubkey: UNCLAIMED_PUBKEY,
    }))

    const { status, body } = await postJson<{ error: string }>('/verify', { claims })

    expect(status).toBe(400)
    expect(body.error).toMatch(/maximum/i)
  })

  it('rejects a body that is not JSON', async () => {
    const { status } = await postJson('/verify', undefined)

    expect(status).toBe(400)
  })
})

// Nothing above should ever have produced a stored verification. If one did,
// the badge API would now vouch for an identity nobody proved.
describe('none of the refused claims left a stored verification behind', () => {
  it('has no verifications recorded for the unclaimed pubkey', async () => {
    const { status, body } = await postJson<{ verifications: unknown[] }>('/verify', {
      claims: [{ platform: 'github', identity: OCTOCAT, proof: OCTOCAT_GIST, pubkey: UNCLAIMED_PUBKEY }],
    })
    expect(status).toBe(200)

    const stored = await fetch(
      `${process.env.E2E_BASE_URL || 'https://verify.divine.video'}/verified/${UNCLAIMED_PUBKEY}`,
    )
    const payload = (await stored.json()) as { verifications: unknown[] }

    expect(payload.verifications).toEqual([])
  })
})

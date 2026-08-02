// ABOUTME: The end-to-end happy path: a real proof post on a real platform, verified
// ABOUTME: by the live deployment, stored, and readable back through the badge API.
import { describe, expect, it } from 'vitest'
import { api, githubProofFixture, verifySingle } from './support/deployment'

const fixture = githubProofFixture()

// Without the fixture there is nothing honest to assert: the whole point of
// this file is that real content on a real platform, fetched over the real
// network, produces a real stored verification. A stubbed version of that
// would be testing our own stub. See e2e/README.md for the setup command.
describe.skipIf(!fixture)('a real GitHub gist verifies end to end', () => {
  const proof = fixture as NonNullable<typeof fixture>

  it('verifies the claim against the real GitHub API', async () => {
    const { status, body } = await verifySingle({
      platform: 'github',
      identity: proof.user,
      proof: proof.gist,
      pubkey: proof.pubkey,
    })

    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
    expect(body.verified).toBe(true)
  })

  it('records the verification against the pubkey', async () => {
    const { status, body } = await api<{
      pubkey: string
      verifications: Array<{ platform: string; identity: string; method: string; proof_url: string }>
    }>(`/verified/${proof.pubkey.toLowerCase()}`)

    expect(status).toBe(200)
    const github = body.verifications.find((row) => row.platform === 'github')
    expect(github, `no github verification stored for ${proof.pubkey}`).toBeDefined()
    expect(github?.identity.toLowerCase()).toBe(proof.user.toLowerCase())
    expect(github?.method).toBe('proof-post')
    expect(github?.proof_url).toBe(proof.gist)
  })

  it('answers the reverse lookup from the platform identity back to the pubkey', async () => {
    const { status, body } = await api<{ pubkey: string; platform: string; identity: string }>(
      `/verified?platform=github&identity=${encodeURIComponent(proof.user)}`,
    )

    expect(status).toBe(200)
    expect(body.pubkey.toLowerCase()).toBe(proof.pubkey.toLowerCase())
  })

  it('is idempotent — verifying twice leaves exactly one row', async () => {
    await verifySingle({ platform: 'github', identity: proof.user, proof: proof.gist, pubkey: proof.pubkey })

    const { body } = await api<{ verifications: Array<{ platform: string }> }>(
      `/verified/${proof.pubkey.toLowerCase()}`,
    )
    const githubRows = body.verifications.filter((row) => row.platform === 'github')

    expect(githubRows).toHaveLength(1)
  })

  it('matches the identity case-insensitively, the way a user would type it', async () => {
    const { body } = await verifySingle({
      platform: 'github',
      identity: proof.user.toUpperCase(),
      proof: proof.gist,
      pubkey: proof.pubkey,
    })

    expect(body.verified).toBe(true)
  })
})

// Runs whether or not the fixture is present: it needs no stored state, only
// the deployment's ability to reach GitHub and read a public gist.
describe('the deployment can reach the platform APIs it verifies against', () => {
  it('gets a decision from GitHub rather than an upstream error', async () => {
    const { body } = await verifySingle({
      platform: 'github',
      identity: 'octocat',
      proof: '6cad326836d38bd3a7ae',
      pubkey: '0000000000000000000000000000000000000000000000000000000000000001',
    })

    // A real answer about the content — not a network or credential failure.
    expect(body.error).not.toMatch(/API error|not configured|fetch failed/i)
    expect(body.verified).toBe(false)
  })
})

// ABOUTME: Tests for the /verified badge-read API (by pubkey + reverse lookup).
// ABOUTME: Real miniflare D1; asserts the projection exposes no connection/token data.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../index'
import { applyMigrations, PUBKEY_A, PUBKEY_B } from '../db/test-helpers'
import {
  revokeVerificationsForConnectionStatement,
  upsertOauthVerificationStatement,
  upsertProofPostVerificationStatement,
} from '../db/verifications'

describe('verified read API', () => {
  beforeEach(async () => {
    await applyMigrations()
  })

  it('GET /verified/:pubkey lists live verifications with the exact badge key set', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 1_000 }),
      upsertProofPostVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'github', identity: 'alice-gh', proofUrl: 'gist-1', verifiedAt: 2_000 }),
    ])

    const response = await app.request(`/verified/${PUBKEY_A}`, {}, env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { pubkey: string; verifications: Array<Record<string, unknown>> }
    expect(body.pubkey).toBe(PUBKEY_A)
    expect(body.verifications).toEqual([
      { platform: 'github', identity: 'alice-gh', method: 'proof-post', proof_url: 'gist-1', verified_at: 2_000 },
      { platform: 'x', identity: 'alice', method: 'oauth', proof_url: null, verified_at: 1_000 },
    ])
  })

  it('GET /verified/:pubkey returns an empty list for unknown pubkeys, not 404', async () => {
    const response = await app.request(`/verified/${PUBKEY_B}`, {}, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ pubkey: PUBKEY_B, verifications: [] })
  })

  it('GET /verified/:pubkey rejects malformed pubkeys', async () => {
    const response = await app.request('/verified/not-a-pubkey', {}, env)

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('invalid_pubkey')
  })

  it('GET /verified?platform&identity reverse-looks up the owning pubkey', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'Alice', connectionId: 'conn_1', verifiedAt: 1_000 }),
    ])

    const response = await app.request('/verified?platform=x&identity=ALICE', {}, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      platform: 'x',
      identity: 'Alice',
      pubkey: PUBKEY_A,
      method: 'oauth',
      verified_at: 1_000,
    })
  })

  it('GET /verified?platform&identity 404s when no live row exists', async () => {
    const response = await app.request('/verified?platform=x&identity=nobody', {}, env)

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('not_found')
  })

  it('GET /verified requires both query params', async () => {
    const response = await app.request('/verified?platform=x', {}, env)

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_request')
  })

  it('never returns revoked rows from either endpoint', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 1_000 }),
    ])
    await env.DB.batch([
      revokeVerificationsForConnectionStatement(env.DB, { connectionId: 'conn_1', pubkey: PUBKEY_A, now: 2_000 }),
    ])

    const byPubkey = await app.request(`/verified/${PUBKEY_A}`, {}, env)
    await expect(byPubkey.json()).resolves.toEqual({ pubkey: PUBKEY_A, verifications: [] })

    const reverse = await app.request('/verified?platform=x&identity=alice', {}, env)
    expect(reverse.status).toBe(404)
  })
})

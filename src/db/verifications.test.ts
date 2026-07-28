// ABOUTME: Tests for the verifications table migration and its D1 access helpers.
// ABOUTME: Uses real miniflare D1 via applyMigrations; no mocks.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, PUBKEY_A, PUBKEY_B } from './test-helpers'
import {
  findLiveVerification,
  findVerificationByIdentity,
  listVerificationsByPubkey,
  revokeVerificationsForConnectionStatement,
  upsertOauthVerificationStatement,
  upsertProofPostVerificationStatement,
} from './verifications'

describe('verifications migration', () => {
  beforeEach(async () => {
    await applyMigrations()
  })

  it('creates the verifications table with the composite primary key', async () => {
    await env.DB.prepare(
      `INSERT INTO verifications (pubkey, platform, identity, method, verified_at)
       VALUES (?, 'x', 'alice', 'oauth', 1000)`,
    ).bind(PUBKEY_A).run()
    const row = await env.DB.prepare(
      `SELECT pubkey, platform, identity, method, revoked_at FROM verifications WHERE pubkey = ?`,
    ).bind(PUBKEY_A).first()
    expect(row).toMatchObject({ pubkey: PUBKEY_A, platform: 'x', identity: 'alice', method: 'oauth', revoked_at: null })
  })
})

describe('verifications access helpers', () => {
  beforeEach(async () => {
    await applyMigrations()
  })

  it('oauth upsert inserts a row', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 1000 }),
    ])
    const row = await findLiveVerification(env.DB, PUBKEY_A, 'x', 'alice')
    expect(row).toMatchObject({
      pubkey: PUBKEY_A,
      platform: 'x',
      identity: 'alice',
      method: 'oauth',
      proofUrl: null,
      connectionId: 'conn_1',
      verifiedAt: 1000,
      revokedAt: null,
    })
  })

  it('re-upsert on conflict clears revoked_at', async () => {
    const now = 1000
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: now }),
    ])
    await env.DB.batch([
      revokeVerificationsForConnectionStatement(env.DB, { connectionId: 'conn_1', pubkey: PUBKEY_A, now: 2000 }),
    ])
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 3000 }),
    ])
    const row = await findLiveVerification(env.DB, PUBKEY_A, 'x', 'ALICE')
    expect(row).toMatchObject({ connectionId: 'conn_1', verifiedAt: 3000, revokedAt: null })
  })

  it('proof-post upsert stores proof_url and null connection_id', async () => {
    await env.DB.batch([
      upsertProofPostVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'github', identity: 'alice', proofUrl: 'gist-123', verifiedAt: 1000 }),
    ])
    const row = await findLiveVerification(env.DB, PUBKEY_A, 'github', 'alice')
    expect(row).toMatchObject({ method: 'proof-post', proofUrl: 'gist-123', connectionId: null, revokedAt: null })
  })

  it('revoke sets revoked_at only for the matching connection and pubkey', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 1000 }),
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'tiktok', identity: 'alice.t', connectionId: 'conn_2', verifiedAt: 1000 }),
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_B, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 1000 }),
    ])
    await env.DB.batch([
      revokeVerificationsForConnectionStatement(env.DB, { connectionId: 'conn_1', pubkey: PUBKEY_A, now: 2000 }),
    ])
    expect(await findLiveVerification(env.DB, PUBKEY_A, 'x', 'alice')).toBeNull()
    const otherPlatform = await findLiveVerification(env.DB, PUBKEY_A, 'tiktok', 'alice.t')
    expect(otherPlatform?.revokedAt).toBeNull()
    const otherPubkey = await findLiveVerification(env.DB, PUBKEY_B, 'x', 'alice')
    expect(otherPubkey?.revokedAt).toBeNull()
  })

  it('listVerificationsByPubkey returns only live rows ordered by platform', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 1000 }),
      upsertProofPostVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'github', identity: 'alice-gh', proofUrl: 'gist-1', verifiedAt: 1000 }),
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'tiktok', identity: 'alice.t', connectionId: 'conn_2', verifiedAt: 1000 }),
    ])
    await env.DB.batch([
      revokeVerificationsForConnectionStatement(env.DB, { connectionId: 'conn_2', pubkey: PUBKEY_A, now: 2000 }),
    ])
    const rows = await listVerificationsByPubkey(env.DB, PUBKEY_A)
    expect(rows.map((r) => r.platform)).toEqual(['github', 'x'])
  })

  it('findLiveVerification matches identity case-insensitively and misses revoked rows', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'Alice', connectionId: 'conn_1', verifiedAt: 1000 }),
    ])
    expect(await findLiveVerification(env.DB, PUBKEY_A, 'x', 'ALICE')).not.toBeNull()
    await env.DB.batch([
      revokeVerificationsForConnectionStatement(env.DB, { connectionId: 'conn_1', pubkey: PUBKEY_A, now: 2000 }),
    ])
    expect(await findLiveVerification(env.DB, PUBKEY_A, 'x', 'Alice')).toBeNull()
  })

  it('findVerificationByIdentity reverse lookup returns the row', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 1000 }),
    ])
    const row = await findVerificationByIdentity(env.DB, 'x', 'ALICE')
    expect(row).toMatchObject({ pubkey: PUBKEY_A, platform: 'x', identity: 'alice' })
  })
})

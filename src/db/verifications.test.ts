// ABOUTME: Tests for the verifications table migration and its D1 access helpers.
// ABOUTME: Uses real miniflare D1 via applyMigrations; no mocks.
import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test'
import { beforeEach, describe, expect, inject, it } from 'vitest'
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

// Handle platforms treat case as insignificant, so writes must dedupe the same
// way reads match. YouTube is the exception: it proves a channel id, where case
// is significant and two ids differing only by case are different channels.
describe('verification identity casing', () => {
  const CHANNEL_LOWER = 'UCabcdefghijklmnopqrstuv'
  const CHANNEL_UPPER = 'UCABCDEFGHIJKLMNOPQRSTUV'

  beforeEach(async () => {
    await applyMigrations()
  })

  it('collapses case-variant handles into a single row instead of duplicating the badge', async () => {
    await env.DB.batch([
      upsertProofPostVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'github', identity: 'Alice', proofUrl: 'gist-1', verifiedAt: 1000 }),
    ])
    await env.DB.batch([
      upsertProofPostVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'github', identity: 'alice', proofUrl: 'gist-2', verifiedAt: 2000 }),
    ])

    const rows = await listVerificationsByPubkey(env.DB, PUBKEY_A)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ platform: 'github', proofUrl: 'gist-2', verifiedAt: 2000 })
  })

  it('keeps youtube channel ids that differ only by case as separate verifications', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'youtube', identity: CHANNEL_LOWER, connectionId: 'conn_1', verifiedAt: 1000 }),
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'youtube', identity: CHANNEL_UPPER, connectionId: 'conn_2', verifiedAt: 1000 }),
    ])

    const rows = await listVerificationsByPubkey(env.DB, PUBKEY_A)
    expect(rows).toHaveLength(2)
    expect(await findLiveVerification(env.DB, PUBKEY_A, 'youtube', CHANNEL_LOWER)).toMatchObject({ connectionId: 'conn_1' })
    expect(await findLiveVerification(env.DB, PUBKEY_A, 'youtube', CHANNEL_UPPER)).toMatchObject({ connectionId: 'conn_2' })
  })

  it('does not resolve a youtube channel id to a different-cased channel', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'youtube', identity: CHANNEL_LOWER, connectionId: 'conn_1', verifiedAt: 1000 }),
    ])

    expect(await findVerificationByIdentity(env.DB, 'youtube', CHANNEL_UPPER)).toBeNull()
    expect(await findVerificationByIdentity(env.DB, 'youtube', CHANNEL_LOWER)).toMatchObject({ pubkey: PUBKEY_A })
  })

  it('preserves the stored handle casing for display', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'AliceInChains', connectionId: 'conn_1', verifiedAt: 1000 }),
    ])

    const row = await findLiveVerification(env.DB, PUBKEY_A, 'x', 'aliceinchains')
    expect(row?.identity).toBe('AliceInChains')
  })
})

// A proof-post verification layered on top of an OAuth connection must not
// orphan the row: revocation matches on connection_id, so dropping the link
// would leave a badge that disconnecting the account can never remove.
describe('proof-post over an existing oauth verification', () => {
  beforeEach(async () => {
    await applyMigrations()
  })

  it('keeps the connection link so an explicit disconnect still revokes the badge', async () => {
    await env.DB.batch([
      upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 1000 }),
    ])
    await env.DB.batch([
      upsertProofPostVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', proofUrl: 'https://x.com/alice/status/1', verifiedAt: 2000 }),
    ])

    const upgraded = await findLiveVerification(env.DB, PUBKEY_A, 'x', 'alice')
    expect(upgraded).toMatchObject({ method: 'proof-post', proofUrl: 'https://x.com/alice/status/1', connectionId: 'conn_1' })

    await env.DB.batch([
      revokeVerificationsForConnectionStatement(env.DB, { connectionId: 'conn_1', pubkey: PUBKEY_A, now: 3000 }),
    ])
    expect(await findLiveVerification(env.DB, PUBKEY_A, 'x', 'alice')).toBeNull()
  })
})

// 0004 shipped to production before this fix, so 0005 has to upgrade a table that
// may already hold the case-variant duplicates the new unique index forbids.
// A fresh test database never exercises that path; this applies the migrations in
// two stages to cover it.
describe('0005 migration on an existing 0004 table', () => {
  const upTo0004 = (all: D1Migration[]) => all.filter((m) => m.name < '0005')
  const only0005 = (all: D1Migration[]) => all.filter((m) => m.name >= '0005')

  it('collapses case-variant duplicates, keeps the newest, and backfills identity_key', async () => {
    const migrations = inject('migrations') as D1Migration[]
    await applyD1Migrations(env.DB, upTo0004(migrations))

    // Two rows that only 0004's case-sensitive primary key allowed to coexist,
    // plus a youtube pair whose casing genuinely distinguishes two channels.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO verifications (pubkey, platform, identity, method, proof_url, verified_at)
         VALUES (?, 'github', 'Alice', 'proof-post', 'gist-old', 1000)`,
      ).bind(PUBKEY_A),
      env.DB.prepare(
        `INSERT INTO verifications (pubkey, platform, identity, method, proof_url, verified_at)
         VALUES (?, 'github', 'alice', 'proof-post', 'gist-new', 2000)`,
      ).bind(PUBKEY_A),
      env.DB.prepare(
        `INSERT INTO verifications (pubkey, platform, identity, method, connection_id, verified_at)
         VALUES (?, 'youtube', 'UCabcdefghijklmnopqrstuv', 'oauth', 'conn_1', 1000)`,
      ).bind(PUBKEY_B),
      env.DB.prepare(
        `INSERT INTO verifications (pubkey, platform, identity, method, connection_id, verified_at)
         VALUES (?, 'youtube', 'UCABCDEFGHIJKLMNOPQRSTUV', 'oauth', 'conn_2', 1000)`,
      ).bind(PUBKEY_B),
    ])

    await applyD1Migrations(env.DB, only0005(migrations))

    const github = await listVerificationsByPubkey(env.DB, PUBKEY_A)
    expect(github).toHaveLength(1)
    expect(github[0]).toMatchObject({ identity: 'alice', proofUrl: 'gist-new', verifiedAt: 2000 })

    // Case-significant youtube channels must both survive the collapse.
    expect(await listVerificationsByPubkey(env.DB, PUBKEY_B)).toHaveLength(2)

    const keys = await env.DB.prepare(
      `SELECT platform, identity, identity_key FROM verifications ORDER BY platform, identity_key`,
    ).all<{ platform: string; identity: string; identity_key: string }>()
    expect(keys.results).toEqual([
      { platform: 'github', identity: 'alice', identity_key: 'alice' },
      { platform: 'youtube', identity: 'UCABCDEFGHIJKLMNOPQRSTUV', identity_key: 'UCABCDEFGHIJKLMNOPQRSTUV' },
      { platform: 'youtube', identity: 'UCabcdefghijklmnopqrstuv', identity_key: 'UCabcdefghijklmnopqrstuv' },
    ])
  })
})

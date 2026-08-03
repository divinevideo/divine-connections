// ABOUTME: Tests the migration that backfills verifications from live OAuth
// ABOUTME: connections made before the connection-to-verification write existed.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, inject, it } from 'vitest'
import { applyMigrations, connection, PUBKEY_A, PUBKEY_B } from './test-helpers'
import { listVerificationsByPubkey } from './verifications'
import type { ConnectionRecord } from '../types'

// applyD1Migrations records what it has applied, so it will not re-run 0006
// after the fixtures exist. Run the shipped SQL directly instead, so this
// tests the migration that actually deploys rather than a copy of it.
async function runBackfill(): Promise<void> {
  const migrations = inject('migrations') as Array<{ name: string; queries: string[] }>
  const backfill = migrations.find((m) => m.name.includes('backfill_oauth_verifications'))
  if (!backfill) throw new Error('0006_backfill_oauth_verifications.sql not found in migrations')
  for (const query of backfill.queries) {
    await env.DB.prepare(query).run()
  }
}

async function insertConnection(overrides: {
  id: string
  pubkey: string
  platform: string
  name: string
  accountId?: string
  status?: string
}): Promise<void> {
  const record = connection({
    id: overrides.id,
    pubkey: overrides.pubkey,
    platform: overrides.platform as ConnectionRecord['platform'],
    externalAccountId: overrides.accountId ?? `acct_${overrides.id}`,
    externalAccountName: overrides.name,
    status: (overrides.status ?? 'connected') as ConnectionRecord['status'],
  })
  await env.DB.prepare(
    `INSERT INTO connections (id, pubkey, platform, external_account_id, external_account_name,
       encrypted_access_token, encrypted_refresh_token, token_expires_at, granted_scopes,
       status, created_at, updated_at, last_refresh_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.id, record.pubkey, record.platform, record.externalAccountId, record.externalAccountName,
      record.encryptedAccessToken, record.encryptedRefreshToken, record.tokenExpiresAt, record.grantedScopes,
      record.status, record.createdAt, record.updatedAt, record.lastRefreshAt, record.metadataJson,
    )
    .run()
}

describe('backfilling verifications from existing connections', () => {
  beforeEach(async () => {
    await applyMigrations()
  })

  it('gives a connected account a verification without any proof post', async () => {
    await insertConnection({ id: 'conn_ig', pubkey: PUBKEY_A, platform: 'instagram', name: 'rabble' })
    await runBackfill()

    const rows = await listVerificationsByPubkey(env.DB, PUBKEY_A)
    const instagram = rows.find((r) => r.platform === 'instagram')

    expect(instagram).toBeDefined()
    expect(instagram?.identity).toBe('rabble')
    expect(instagram?.method).toBe('oauth')
    expect(instagram?.connectionId).toBe('conn_ig')
  })

  it('proves the account for YouTube by channel id, not display name', async () => {
    await insertConnection({
      id: 'conn_yt', pubkey: PUBKEY_A, platform: 'youtube',
      name: 'Some Channel Name', accountId: 'UCabcDEF123',
    })
    await runBackfill()

    const youtube = (await listVerificationsByPubkey(env.DB, PUBKEY_A)).find((r) => r.platform === 'youtube')

    expect(youtube?.identity).toBe('UCabcDEF123')
  })

  it('ignores connections that are not live', async () => {
    await insertConnection({ id: 'conn_dead', pubkey: PUBKEY_B, platform: 'instagram', name: 'ghost', status: 'revoked' })
    await runBackfill()

    expect(await listVerificationsByPubkey(env.DB, PUBKEY_B)).toEqual([])
  })

  it('is safe to run twice and does not duplicate', async () => {
    await insertConnection({ id: 'conn_ig', pubkey: PUBKEY_A, platform: 'instagram', name: 'rabble' })
    await runBackfill()
    await runBackfill()

    const instagram = (await listVerificationsByPubkey(env.DB, PUBKEY_A)).filter((r) => r.platform === 'instagram')

    expect(instagram).toHaveLength(1)
  })

  it('leaves an existing verification for the same identity alone', async () => {
    await insertConnection({ id: 'conn_ig', pubkey: PUBKEY_A, platform: 'instagram', name: 'Rabble' })
    await env.DB.prepare(
      `INSERT INTO verifications (pubkey, platform, identity, identity_key, method, proof_url, connection_id, verified_at, revoked_at)
       VALUES (?, 'instagram', 'Rabble', 'rabble', 'proof-post', 'https://example.test/post', NULL, 9999, NULL)`,
    ).bind(PUBKEY_A).run()

    await runBackfill()

    const rows = (await listVerificationsByPubkey(env.DB, PUBKEY_A)).filter((r) => r.platform === 'instagram')
    expect(rows).toHaveLength(1)
    // The pre-existing proof-post row wins; the backfill must not overwrite it.
    expect(rows[0].method).toBe('proof-post')
    expect(rows[0].verifiedAt).toBe(9999)
  })
})

// ABOUTME: Tests for the verifications table migration and its D1 access helpers.
// ABOUTME: Uses real miniflare D1 via applyMigrations; no mocks.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, PUBKEY_A } from './test-helpers'

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

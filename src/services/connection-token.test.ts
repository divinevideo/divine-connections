// ABOUTME: Exercises token refresh compare-and-swap against Snapchat selection races.
// ABOUTME: Preserves the winning connection rather than reviving or overwriting stale state.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyMigrations, connection, PUBKEY_A } from '../db/test-helpers'
import { getConnection, upsertConnection } from '../db/connections'
import { encryptToken } from '../utils/crypto'
import { ConnectionTokenReauthError, usableConnectionToken } from './connection-token'
import type { Env } from '../types'
const key = '0123456789abcdef0123456789abcdef'
const profile = '11111111-1111-4111-8111-111111111111'
let env: Env
beforeEach(async () => {
  env = { DB: await applyMigrations(), TOKEN_ENCRYPTION_KEY: key, ENABLE_SNAPCHAT: 'true', SNAPCHAT_PUBLIC_PROFILE_APPROVED: 'true', SNAPCHAT_CLIENT_ID: 'client', SNAPCHAT_CLIENT_SECRET: 'secret' } as Env
  await upsertConnection(env.DB, connection({ platform: 'snapchat', externalAccountId: profile, encryptedAccessToken: await encryptToken('old', key), encryptedRefreshToken: await encryptToken('refresh', key), tokenExpiresAt: 1, metadataJson: JSON.stringify({ account: { profileConfirmed: true, selectionRevision: 'selection-a' } }) }))
})
afterEach(() => vi.unstubAllGlobals())

it.each(['new profile', 'same profile new revision', 'same profile new revision and token'])('rejects refresh results after %s without damaging the winner', async change => {
  const previous = (await getConnection(env.DB, 'conn_1', PUBKEY_A))!
  const winningAccess = await encryptToken('winning', key)
  const accountId = change === 'new profile' ? '22222222-2222-4222-8222-222222222222' : profile
  vi.stubGlobal('fetch', vi.fn(async () => {
    await env.DB.prepare("UPDATE connections SET external_account_id = ?, metadata_json = ?, encrypted_access_token = ?, token_expires_at = NULL WHERE id = 'conn_1'")
      .bind(accountId, JSON.stringify({ account: { profileConfirmed: true, selectionRevision: 'selection-b' } }), change.endsWith('and token') ? winningAccess : previous.encryptedAccessToken).run()
    return Response.json({ access_token: 'losing-refresh', refresh_token: 'losing-refresh-token', expires_in: 3600 })
  }))
  await expect(usableConnectionToken(env, previous, 2000)).rejects.toBeInstanceOf(ConnectionTokenReauthError)
  const saved = (await getConnection(env.DB, 'conn_1', PUBKEY_A))!
  expect(saved.status).toBe('connected')
  expect(saved.externalAccountId).toBe(accountId)
  expect(saved.encryptedAccessToken).toBe(change.endsWith('and token') ? winningAccess : previous.encryptedAccessToken)
})

it('does not invalidate a newly selected profile when the old refresh grant is rejected', async () => {
  const previous = (await getConnection(env.DB, 'conn_1', PUBKEY_A))!
  vi.stubGlobal('fetch', vi.fn(async () => {
    await env.DB.prepare("UPDATE connections SET metadata_json = ? WHERE id = 'conn_1'").bind(JSON.stringify({ account: { profileConfirmed: true, selectionRevision: 'selection-b' } })).run()
    return Response.json({ error: 'invalid_grant' }, { status: 400 })
  }))
  await expect(usableConnectionToken(env, previous, 2000)).rejects.toBeInstanceOf(ConnectionTokenReauthError)
  expect((await getConnection(env.DB, 'conn_1', PUBKEY_A))!.status).toBe('connected')
})

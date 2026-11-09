// ABOUTME: Exercises token refresh compare-and-swap against Snapchat selection races.
// ABOUTME: Preserves the winning connection rather than reviving or overwriting stale state.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyMigrations, connection, PUBKEY_A, PUBKEY_B } from '../db/test-helpers'
import { getConnection, upsertConnection } from '../db/connections'
import { decryptToken, encryptToken } from '../utils/crypto'
import { ConnectionTokenReauthError, usableConnectionCredentials, usableConnectionToken } from './connection-token'
import type { Env, Platform } from '../types'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function concurrentRefreshResponses(platform: Platform = 'snapchat') {
  const firstEntered = deferred<void>()
  const secondEntered = deferred<void>()
  const success = deferred<Response>()
  const rejection = deferred<Response>()
  let requests = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (requests++ === 0) {
      firstEntered.resolve()
      return success.promise
    }
    secondEntered.resolve()
    return rejection.promise
  }))
  return {
    firstEntered: firstEntered.promise,
    secondEntered: secondEntered.promise,
    succeed: () => success.resolve(Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, scope: 'video.publish', token_type: 'Bearer' })),
    reject: () => rejection.resolve(Response.json({ error: 'invalid_grant' }, { status: platform === 'tiktok' ? 200 : 400 })),
  }
}

async function selectPlatform(platform: Platform) {
  env.ENABLE_TIKTOK = 'true'
  env.TIKTOK_CLIENT_KEY = 'client'
  env.TIKTOK_CLIENT_SECRET = 'secret'
  await env.DB.prepare("UPDATE connections SET platform = ? WHERE id = 'conn_1'").bind(platform).run()
  return (await getConnection(env.DB, 'conn_1', PUBKEY_A))!
}

it.each(['tiktok', 'snapchat'] as const)('persists a successful %s rotation after the competing refresh is rejected first', async platform => {
  const previous = await selectPlatform(platform)
  const responses = concurrentRefreshResponses(platform)
  const first = usableConnectionCredentials(env, previous, 2000)
  await responses.firstEntered
  const second = usableConnectionCredentials(env, previous, 2000)
  await responses.secondEntered
  responses.reject()
  await expect(second).rejects.toBeInstanceOf(ConnectionTokenReauthError)
  expect((await getConnection(env.DB, 'conn_1', PUBKEY_A))!.status).toBe('needs_reauth')
  responses.succeed()
  const result = await first
  expect(result.accessToken).toBe('rotated-access')
  expect(result.connection.status).toBe('connected')
  const saved = (await getConnection(env.DB, 'conn_1', PUBKEY_A))!
  expect(saved.status).toBe('connected')
  expect(await decryptToken(saved.encryptedAccessToken, key)).toBe('rotated-access')
  expect(await decryptToken(saved.encryptedRefreshToken!, key)).toBe('rotated-refresh')
  expect(await usableConnectionToken(env, previous, 2000)).toBe('rotated-access')
})

it.each(['tiktok', 'snapchat'] as const)('uses the persisted %s rotation when the competing rejection arrives last', async platform => {
  const previous = await selectPlatform(platform)
  const responses = concurrentRefreshResponses(platform)
  const first = usableConnectionCredentials(env, previous, 2000)
  await responses.firstEntered
  const second = usableConnectionCredentials(env, previous, 2000)
  await responses.secondEntered
  responses.succeed()
  const firstResult = await first
  responses.reject()
  const secondResult = await second
  expect(firstResult.accessToken).toBe('rotated-access')
  expect(secondResult.accessToken).toBe('rotated-access')
  expect(secondResult.connection.encryptedRefreshToken).toBe(firstResult.connection.encryptedRefreshToken)
  expect((await getConnection(env.DB, 'conn_1', PUBKEY_A))!.status).toBe('connected')
})

it.each(['disconnect', 'reconnect', 'replaced refresh token', 'new owner', 'new platform', 'new account', 'new selection'] as const)(
  'does not recover rejected credentials after a concurrent %s', async change => {
    const previous = (await getConnection(env.DB, 'conn_1', PUBKEY_A))!
    const responses = concurrentRefreshResponses()
    const first = usableConnectionCredentials(env, previous, 2000)
    await responses.firstEntered
    const second = usableConnectionCredentials(env, previous, 2000)
    await responses.secondEntered
    responses.reject()
    await expect(second).rejects.toBeInstanceOf(ConnectionTokenReauthError)
    switch (change) {
      case 'disconnect':
        await env.DB.prepare("UPDATE connections SET status = 'disconnected' WHERE id = 'conn_1'").run()
        break
      case 'reconnect':
        await upsertConnection(env.DB, { ...previous, encryptedAccessToken: await encryptToken('reconnected-access', key), encryptedRefreshToken: await encryptToken('reconnected-refresh', key), tokenExpiresAt: 1 })
        break
      case 'replaced refresh token':
        await env.DB.prepare("UPDATE connections SET encrypted_refresh_token = ? WHERE id = 'conn_1'").bind(await encryptToken('replacement-refresh', key)).run()
        break
      case 'new owner':
        await env.DB.prepare("UPDATE connections SET pubkey = ? WHERE id = 'conn_1'").bind(PUBKEY_B).run()
        break
      case 'new platform':
        await env.DB.prepare("UPDATE connections SET platform = 'tiktok' WHERE id = 'conn_1'").run()
        break
      case 'new account':
        await env.DB.prepare("UPDATE connections SET external_account_id = ? WHERE id = 'conn_1'").bind('22222222-2222-4222-8222-222222222222').run()
        break
      case 'new selection':
        await env.DB.prepare("UPDATE connections SET metadata_json = ? WHERE id = 'conn_1'").bind(JSON.stringify({ account: { profileConfirmed: true, selectionRevision: 'selection-b' } })).run()
        break
    }
    const before = await getConnection(env.DB, 'conn_1', change === 'new owner' ? PUBKEY_B : PUBKEY_A)
    responses.succeed()
    const error = await first.catch(error => error)
    expect(error).toBeInstanceOf(ConnectionTokenReauthError)
    expect(error).not.toHaveProperty('retryAt')
    expect(await getConnection(env.DB, 'conn_1', change === 'new owner' ? PUBKEY_B : PUBKEY_A)).toEqual(before)
  },
)

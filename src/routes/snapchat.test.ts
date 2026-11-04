// ABOUTME: Verifies authenticated Snapchat profile selection and preference contracts.
// ABOUTME: Keeps encrypted credentials bound to the owner and guards changes during refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { app } from '../index'
import { applyMigrations, connection, PUBKEY_A, PUBKEY_B } from '../db/test-helpers'
import { getConnection, upsertConnection } from '../db/connections'
import { encryptToken, decryptToken } from '../utils/crypto'
import type { Env } from '../types'
const profile = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const key = '0123456789abcdef0123456789abcdef'
let env: Env; let db: D1Database; let owner: string
beforeEach(async () => {
  db = await applyMigrations(); owner = PUBKEY_A
  env = { DB: db, CACHE_KV: {} as KVNamespace, CROSSPOST_QUEUE: {} as Env['CROSSPOST_QUEUE'], KEYCAST_URL: 'https://login.divine.video', FUNNELCAKE_URL: 'https://api.divine.video', OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video', TOKEN_ENCRYPTION_KEY: key, ENABLE_SNAPCHAT: 'true', SNAPCHAT_CLIENT_ID: 'client', SNAPCHAT_CLIENT_SECRET: 'secret', SNAPCHAT_PUBLIC_PROFILE_APPROVED: 'true' }
  await upsertConnection(db, connection({ platform: 'snapchat', externalAccountId: profile, tokenExpiresAt: null, encryptedAccessToken: await encryptToken('access', key), metadataJson: JSON.stringify({ account: { profileConfirmed: false } }) }))
  vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('login.divine.video') ? Response.json({ result: owner }) : String(url).endsWith('/my_profile') ? Response.json({ request_status: 'SUCCESS', public_profile: { id: profile, snap_user_name: 'creator', organization_id: other } }) : Response.json({ request_status: 'SUCCESS', public_profiles: [{ sub_request_status: 'SUCCESS', public_profile: { id: other, snap_user_name: 'second', display_name: 'Mutable name' } }] })))
})
afterEach(() => vi.unstubAllGlobals())
function req(path: string, body?: unknown, host = 'crossposter.divine.video') { return worker.fetch(new Request('https://' + host + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer divine-login', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, {} as ExecutionContext) }
describe('Snapchat authorized profile selection', () => {
  it('lists authorized profiles without leaking tokens and requires explicit selection', async () => {
    const response = await req('/connections/snapchat/conn_1/profiles'); expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.profiles.map((p: any) => p.id)).toEqual([profile, other]); expect(JSON.stringify(body)).not.toContain('encryptedAccessToken')
    expect((await getConnection(db, 'conn_1', PUBKEY_A))!.externalAccountId).toBe(profile)
    const missing = await req('/connections/snapchat/conn_1/profile', { profileId: other }); expect(missing.status).toBe(400)
    const confirmed = await req('/connections/snapchat/conn_1/profile', { profileId: other, confirmed: true }); expect(confirmed.status).toBe(200)
    const result = (await getConnection(db, 'conn_1', PUBKEY_A))!
    expect(result.externalAccountId).toBe(other); expect(result.externalAccountName).toBe('second'); expect(JSON.parse(result.metadataJson).account.profileConfirmed).toBe(true)
    expect(await decryptToken(result.encryptedAccessToken, key)).toBe('access')
  })
  it('rejects foreign ownership, forged profiles and verifier host', async () => {
    owner = PUBKEY_B
    expect((await req('/connections/snapchat/conn_1/profiles')).status).toBe(404)
    owner = PUBKEY_A
    expect((await req('/connections/snapchat/conn_1/profile', { profileId: '33333333-3333-4333-8333-333333333333', confirmed: true })).status).toBe(400)
    expect((await req('/connections/snapchat/conn_1/profile', { profileId: other, confirmed: true }, 'verifier.divine.video')).status).toBe(404)
  })
  it('does not revive a connection disconnected during provider discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (String(url).includes('login.divine.video')) return Response.json({ result: owner })
      await db.prepare("UPDATE connections SET status = 'disconnected' WHERE id = 'conn_1'").run()
      return Response.json({ request_status: 'SUCCESS', public_profile: { id: profile, snap_user_name: 'creator' } })
    }))
    expect((await req('/connections/snapchat/conn_1/profile', { profileId: profile, confirmed: true })).status).toBe(409)
    expect((await getConnection(db, 'conn_1', PUBKEY_A))!.status).toBe('disconnected')
  })
  it('saves Snapchat destination and rejects unknown destinations', async () => {
    await req('/connections/snapchat/conn_1/profile', { profileId: profile, confirmed: true })
    const put = (destination: string) => app.request('https://crossposter.divine.video/preferences/snapchat', { method: 'PUT', headers: { Authorization: 'Bearer divine-login', 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'automatic', snapchatDestination: destination }) }, env)
    expect((await put('friends')).status).toBe(400)
    const response = await put('story'); expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ preference: { mode: 'automatic', snapchatDestination: 'story' } })
  })
})

it('refreshes an expired profile-listing token and persists only encrypted credentials', async () => {
  await db.prepare("UPDATE connections SET token_expires_at = 1, encrypted_refresh_token = ? WHERE id = 'conn_1'").bind(await encryptToken('refresh', key)).run()
  let refreshed = false
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).includes('login.divine.video')) return Response.json({ result: owner })
    if (String(url).includes('/access_token')) { refreshed = true; return Response.json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }) }
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fresh-access')
    return Response.json({ request_status: 'SUCCESS', public_profile: { id: profile, snap_user_name: 'creator' } })
  }))
  const response = await req('/connections/snapchat/conn_1/profiles'); expect(response.status).toBe(200); expect(refreshed).toBe(true)
  const saved = (await getConnection(db, 'conn_1', PUBKEY_A))!
  expect(saved.encryptedAccessToken).not.toContain('fresh-access'); expect(await decryptToken(saved.encryptedAccessToken, key)).toBe('fresh-access')
  expect(JSON.stringify(await response.json())).not.toContain('fresh-access')
})

it('OAuth callback records an unconfirmed profile with crossposting off', async () => {
  const { createOAuthState } = await import('../db/oauth-states')
  const { completeConnectionCallback, verificationIdentityForConnection } = await import('../services/connections')
  const now = Math.floor(Date.now()/1000)
  await createOAuthState(db, { stateId: 'state-snap', pubkey: PUBKEY_B, platform: 'snapchat', codeVerifier: null, returnUrl: 'https://crossposter.divine.video/', createdAt: now, expiresAt: now + 600, metadataJson: '{}' })
  vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/access_token') ? Response.json({ access_token: 'callback-access', refresh_token: 'callback-refresh', expires_in: 3600 }) : Response.json({ request_status: 'SUCCESS', public_profile: { id: profile, display_name: 'Mutable display name' } })))
  expect(await completeConnectionCallback(env, 'snapchat', 'code', 'state-snap')).toContain('connection=connected')
  const { listConnections } = await import('../db/connections'); const { getPreferences } = await import('../db/preferences')
  const saved = (await listConnections(db, PUBKEY_B))[0]
  expect(JSON.parse(saved.metadataJson).account.profileConfirmed).toBe(false)
  expect(verificationIdentityForConnection(saved)).toBe(profile)
  expect((await getPreferences(db, PUBKEY_B))[0].mode).toBe('disabled')
})

it('updates the OAuth verification to the stable confirmed public-profile ID', async () => {
  const response = await req('/connections/snapchat/conn_1/profile', { profileId: other, confirmed: true }); expect(response.status).toBe(200)
  const row = await db.prepare("SELECT identity FROM verifications WHERE pubkey = ? AND platform = 'snapchat' AND revoked_at IS NULL").bind(PUBKEY_A).first<{ identity: string }>()
  expect(row?.identity).toBe(other)
})

it('reselects an existing organization profile after reconnecting the OAuth owner without a unique-key collision', async () => {
  await upsertConnection(db, connection({ id: 'conn_existing_profile', platform: 'snapchat', pubkey: PUBKEY_A, externalAccountId: other, status: 'needs_reauth', encryptedAccessToken: await encryptToken('old', key), metadataJson: '{}' }))
  const response = await req('/connections/snapchat/conn_1/profile', { profileId: other, confirmed: true })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ connectionId: 'conn_existing_profile', profileId: other })
  const selected = (await getConnection(db, 'conn_existing_profile', PUBKEY_A))!
  expect(selected.status).toBe('connected'); expect(await decryptToken(selected.encryptedAccessToken, key)).toBe('access')
  expect((await getConnection(db, 'conn_1', PUBKEY_A))!.status).toBe('disconnected')
})

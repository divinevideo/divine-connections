// ABOUTME: Verifies crossposting persistence and API behavior.
// ABOUTME: Preserves existing opt-in and provider isolation guarantees.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../index'
import { upsertConnection } from '../db/connections'
import { getPreferences, setPreference } from '../db/preferences'
import { applyMigrations, connection, PUBKEY_A } from '../db/test-helpers'
import type { Env } from '../types'
import { nip98Header, signNip98Event } from '../auth/test-helpers'

function testEnv(db: D1Database): Env {
  return {
    DB: db,
    CACHE_KV: {} as KVNamespace,    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    ENABLE_TIKTOK: 'true',
    TIKTOK_CLIENT_KEY: 'tiktok-client',
    TIKTOK_CLIENT_SECRET: 'tiktok-secret',
  }
}

function authResponse(): Response {
  return Response.json({ result: PUBKEY_A })
}

describe('preference routes', () => {
  let db: D1Database
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = await applyMigrations()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('saves and returns an Instagram destination and preserves it on a mode-only update', async () => {
    await upsertConnection(db, connection({ id: 'conn_instagram', platform: 'instagram' }))
    fetchMock.mockImplementation(async () => authResponse())
    const put = (body: unknown) => app.request('/preferences/instagram', { method: 'PUT', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify(body) }, testEnv(db))
    const first = await put({ mode: 'manual', instagramDestination: 'story' })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ preference: { instagramDestination: 'story' } })
    const second = await put({ mode: 'automatic' })
    expect(await second.json()).toMatchObject({ preference: { mode: 'automatic', instagramDestination: 'story' } })
  })

  it.each([['instagram', 'post'], ['instagram', null], ['tiktok', 'story']])('rejects invalid destination %s %s without saving a preference', async (platform, instagramDestination) => {
    fetchMock.mockImplementation(async () => authResponse())
    const response = await app.request('/preferences/' + platform, { method: 'PUT', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'disabled', instagramDestination }) }, testEnv(db))
    expect(response.status).toBe(400)
    expect(await getPreferences(db, PUBKEY_A)).toEqual([])
  })

  it('lists authenticated preferences', async () => {
    await upsertConnection(db, connection({ id: 'conn_tiktok' }))
    await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'tiktok',
      connectionId: 'conn_tiktok',
      mode: 'manual',
      automaticEnabledAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    fetchMock.mockResolvedValueOnce(authResponse())

    const response = await app.request('/preferences', { headers: { authorization: 'Bearer token' } }, testEnv(db))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      preferences: [
        {
          platform: 'tiktok',
          connectionId: 'conn_tiktok',
          mode: 'manual',
          automaticEnabledAt: null,
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      ],
    })
  })

  it('requires a connected platform for automatic mode and stores automatic_enabled_at', async () => {
    fetchMock.mockResolvedValueOnce(authResponse())

    const missingConnection = await app.request(
      '/preferences/tiktok',
      {
        method: 'PUT',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'automatic' }),
      },
      testEnv(db),
    )

    expect(missingConnection.status).toBe(400)
    await expect(missingConnection.json()).resolves.toMatchObject({
      error: { code: 'not_connected' },
    })

    await upsertConnection(db, connection({ id: 'conn_tiktok' }))
    fetchMock.mockResolvedValueOnce(authResponse())

    const connected = await app.request(
      '/preferences/tiktok',
      {
        method: 'PUT',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'automatic' }),
      },
      testEnv(db),
    )

    expect(connected.status).toBe(200)
    await expect(connected.json()).resolves.toEqual({
      preference: {
        platform: 'tiktok',
        connectionId: 'conn_tiktok',
        mode: 'automatic',
        automaticEnabledAt: 1_783_382_400,
        createdAt: 1_783_382_400,
        updatedAt: 1_783_382_400,
      },
    })
  })

  it('clears automatic_enabled_at when switching to manual or disabled', async () => {
    await upsertConnection(db, connection({ id: 'conn_tiktok' }))
    await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'tiktok',
      connectionId: 'conn_tiktok',
      mode: 'automatic',
      automaticEnabledAt: 1_500,
      createdAt: 1_000,
      updatedAt: 1_500,
    })
    fetchMock.mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(authResponse())

    const manual = await app.request(
      '/preferences/tiktok',
      {
        method: 'PUT',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'manual' }),
      },
      testEnv(db),
    )
    const disabled = await app.request(
      '/preferences/tiktok',
      {
        method: 'PUT',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'disabled' }),
      },
      testEnv(db),
    )

    expect(manual.status).toBe(200)
    await expect(manual.json()).resolves.toMatchObject({
      preference: { mode: 'manual', connectionId: 'conn_tiktok', automaticEnabledAt: null },
    })
    expect(disabled.status).toBe(200)
    await expect(disabled.json()).resolves.toMatchObject({
      preference: { mode: 'disabled', connectionId: null, automaticEnabledAt: null },
    })
    await expect(getPreferences(db, PUBKEY_A)).resolves.toMatchObject([
      { platform: 'tiktok', mode: 'disabled', connectionId: null, automaticEnabledAt: null },
    ])
  })

  it('authenticates a NIP-98 signed PUT and still reads its JSON body', async () => {
    const body = JSON.stringify({ mode: 'automatic' })
    const event = await signNip98Event({
      url: 'http://localhost/preferences/tiktok',
      method: 'PUT',
      createdAt: Math.floor(Date.now() / 1000),
      body,
    })

    const response = await app.request(
      '/preferences/tiktok',
      {
        method: 'PUT',
        headers: { authorization: nip98Header(event), 'content-type': 'application/json' },
        body,
      },
      testEnv(db),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_connected' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a NIP-98 signed PUT whose body was changed after signing', async () => {
    const event = await signNip98Event({
      url: 'http://localhost/preferences/tiktok',
      method: 'PUT',
      createdAt: Math.floor(Date.now() / 1000),
      body: JSON.stringify({ mode: 'off' }),
    })

    const response = await app.request(
      '/preferences/tiktok',
      {
        method: 'PUT',
        headers: { authorization: nip98Header(event), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'automatic' }),
      },
      testEnv(db),
    )

    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

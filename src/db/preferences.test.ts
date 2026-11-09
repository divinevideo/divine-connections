// ABOUTME: Exercises preference round trips against the additive D1 schema.
// ABOUTME: Keeps provider defaults separate from immutable job choices.
import { beforeEach, describe, expect, it } from 'vitest'
import { upsertConnection } from './connections'
import { getPreferences, listAutomaticPreferences, setPreference } from './preferences'
import { applyMigrations, connection, PUBKEY_A } from './test-helpers'

describe('preference repository', () => {
  let db: D1Database

  beforeEach(async () => {
    db = await applyMigrations()
    await upsertConnection(db, connection({ id: 'conn_x', platform: 'x' }))
  })

  it.each(['private', 'unlisted', 'public'] as const)('round trips YouTube %s without affecting legacy preferences', async (youtubePrivacyStatus) => {
    const saved = await setPreference(db, { pubkey: PUBKEY_A, platform: 'youtube', connectionId: null, mode: 'automatic', automaticEnabledAt: 1000, createdAt: 1000, updatedAt: 1000, youtubePrivacyStatus })
    expect(saved.youtubePrivacyStatus).toBe(youtubePrivacyStatus)
    expect((await getPreferences(db, PUBKEY_A))[0].youtubePrivacyStatus).toBe(youtubePrivacyStatus)
    expect((await listAutomaticPreferences(db, 10, 0))[0].youtubePrivacyStatus).toBe(youtubePrivacyStatus)
  })

  it('stores automatic_enabled_at when mode is automatic', async () => {
    const preference = await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'x',
      connectionId: 'conn_x',
      mode: 'automatic',
      automaticEnabledAt: 2_000,
      createdAt: 1_000,
      updatedAt: 2_000,
    })

    expect(preference).toMatchObject({ mode: 'automatic', automaticEnabledAt: 2_000 })
    await expect(getPreferences(db, PUBKEY_A)).resolves.toEqual([preference])
    await expect(listAutomaticPreferences(db, 10, 0)).resolves.toEqual([preference])
  })

  it('clears automatic_enabled_at for non-automatic modes', async () => {
    await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'x',
      connectionId: 'conn_x',
      mode: 'automatic',
      automaticEnabledAt: 2_000,
      createdAt: 1_000,
      updatedAt: 2_000,
    })

    const manual = await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'x',
      connectionId: 'conn_x',
      mode: 'manual',
      automaticEnabledAt: 3_000,
      createdAt: 1_000,
      updatedAt: 3_000,
    })

    expect(manual).toMatchObject({ mode: 'manual', automaticEnabledAt: null })
    await expect(listAutomaticPreferences(db, 10, 0)).resolves.toEqual([])
  })
})

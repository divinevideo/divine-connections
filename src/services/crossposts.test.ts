// ABOUTME: Verifies crossposting persistence and API behavior.
// ABOUTME: Preserves existing opt-in and provider isolation guarantees.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SOURCE_METADATA_CASES } from '../funnelcake/source-metadata.test-helpers'
import { createAutomaticCrossposts, createManualCrossposts } from './crossposts'
import { upsertConnection } from '../db/connections'
import { setPreference } from '../db/preferences'
import { applyMigrations, connection, PUBKEY_A, PUBKEY_B, VIDEO_EVENT_ID } from '../db/test-helpers'
import type { Env, Platform } from '../types'

const YOUTUBE_EVENT_ID = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: VIDEO_EVENT_ID,
    pubkey: PUBKEY_A,
    kind: 34236,
    created_at: 2_000,
    content: 'six seconds of weird human internet',
    tags: [['imeta', 'url', 'https://media.divine.video/video.mp4', 'x', 'abc123']],
    sig: 'f'.repeat(128),
    ...overrides,
  }
}

function nip71Event(overrides: Record<string, unknown> = {}) {
  return event({
    tags: [['imeta', 'url https://media.divine.video/video.mp4', 'm video/mp4', 'x abc123']],
    ...overrides,
  })
}

function testEnv(db: D1Database, queueSend: ReturnType<typeof vi.fn>): Env {
  return {
    DB: db,
    CROSSPOST_QUEUE: { send: queueSend } as unknown as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://login.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    ENABLE_X: 'true',
    ENABLE_YOUTUBE: 'true',
    TWITTER_CLIENT_ID: 'x-client',
    TWITTER_CLIENT_SECRET: 'x-secret',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
  }
}

async function addConnectedPlatform(db: D1Database, platform: Platform, id: string) {
  await upsertConnection(
    db,
    connection({
      id,
      platform,
      externalAccountId: `${platform}-external-account`,
      externalAccountName: `${platform} account`,
    }),
  )
}

describe('crosspost service', () => {
  let db: D1Database
  let queueSend: ReturnType<typeof vi.fn>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = await applyMigrations()
    queueSend = vi.fn()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['new channel', 'disconnected'])('refuses a YouTube %s change during source lookup before creating jobs', async change => {
    await addConnectedPlatform(db, 'youtube', 'conn_youtube')
    fetchMock.mockImplementation(async () => {
      if (change === 'new channel') await upsertConnection(db, connection({ id: 'conn_new', platform: 'youtube', externalAccountId: 'synthetic_new_channel', createdAt: 2000, updatedAt: 2000 }))
      else await db.prepare("UPDATE connections SET status = 'disconnected' WHERE id = ?").bind('conn_youtube').run()
      return Response.json({ event: event() })
    })
    await expect(createManualCrossposts(testEnv(db, queueSend), { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' } })).rejects.toMatchObject({ status: 409, code: 'youtube_channel_changed' })
    expect((await db.prepare('SELECT COUNT(*) AS count FROM jobs').first<{ count: number }>())?.count).toBe(0)
    expect(queueSend).not.toHaveBeenCalled()
  })

  it('rejects YouTube channel confirmation when YouTube is not selected', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    fetchMock.mockImplementation(async () => Response.json({ event: event() }))
    await expect(createManualCrossposts(testEnv(db, queueSend), { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['x'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' } })).rejects.toMatchObject({ status: 400, code: 'not_eligible' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(queueSend).not.toHaveBeenCalled()
  })

  it('bounds YouTube descriptions in UTF-8 bytes without splitting emoji and retains attribution', async () => {
    await addConnectedPlatform(db, 'youtube', 'conn_youtube')
    fetchMock.mockImplementation(async () => Response.json({ event: event({ content: '🎉'.repeat(1300) }) }))
    const result = await createManualCrossposts(testEnv(db, queueSend), { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' } })
    expect(new TextEncoder().encode(result.jobs[0].caption).length).toBeLessThanOrEqual(5000)
    expect(result.jobs[0].caption).toContain('https://divine.video/video/' + VIDEO_EVENT_ID)
    expect(result.jobs[0].caption).not.toContain('�')
  })

  it('uses saved visibility for manual YouTube uploads when the override is absent', async () => {
    await addConnectedPlatform(db, 'youtube', 'conn_youtube')
    await setPreference(db, { pubkey: PUBKEY_A, platform: 'youtube', connectionId: 'conn_youtube', mode: 'manual', automaticEnabledAt: null, createdAt: 1000, updatedAt: 1000, youtubePrivacyStatus: 'public' })
    fetchMock.mockImplementation(async () => Response.json({ event: event() }))
    const result = await createManualCrossposts({ ...testEnv(db, queueSend), YOUTUBE_DEFAULT_PRIVACY_STATUS: 'unlisted' }, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' } })
    expect(result.jobs[0].youtubePrivacyStatus).toBe('public')
  })

  it.each(['private', 'unlisted', 'public'] as const)('snapshots saved YouTube %s and retains it for duplicates', async (youtubePrivacyStatus) => {
    await addConnectedPlatform(db, 'youtube', 'conn_youtube')
    const env = testEnv(db, queueSend)
    await setPreference(db, { pubkey: PUBKEY_A, platform: 'youtube', connectionId: 'conn_youtube', mode: 'automatic', automaticEnabledAt: 1000, createdAt: 1000, updatedAt: 1000, youtubePrivacyStatus })
    fetchMock.mockImplementation(async () => Response.json({ event: event({ tags: [...event().tags, ['title', 'Human 🎉 title']] }) }))
    const auto = await createAutomaticCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID })
    expect(auto.jobs[0]).toMatchObject({ youtubePrivacyStatus, youtubeTitle: 'Human 🎉 title' })
    const duplicate = await createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' }, youtubePrivacyStatus: 'unlisted' })
    expect(duplicate.jobs[0].youtubePrivacyStatus).toBe(youtubePrivacyStatus)
    expect(queueSend).toHaveBeenCalledTimes(1)
    fetchMock.mockImplementation(async () => Response.json({ event: event({ id: YOUTUBE_EVENT_ID }) }))
    const manual = await createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: YOUTUBE_EVENT_ID, platforms: ['youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' }, youtubePrivacyStatus: 'public' })
    expect(manual.jobs[0].youtubePrivacyStatus).toBe('public')
  })

  it('uses configured YouTube fallback and a Unicode-safe source title without attribution', async () => {
    await addConnectedPlatform(db, 'youtube', 'conn_youtube')
    fetchMock.mockImplementation(async () => Response.json({ event: event({ content: '🎉'.repeat(101) }) }))
    const result = await createManualCrossposts({ ...testEnv(db, queueSend), YOUTUBE_DEFAULT_PRIVACY_STATUS: 'unlisted' }, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' } })
    expect(result.jobs[0]).toMatchObject({ youtubePrivacyStatus: 'unlisted', youtubeTitle: '🎉'.repeat(100) })
    expect(result.jobs[0].caption).toContain('🎉'.repeat(101))
  })

  it.each([null, 'friends', 1, {}, false])('rejects invalid YouTube visibility %j before lookup', async (youtubePrivacyStatus) => {
    await expect(createManualCrossposts(testEnv(db, queueSend), { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' }, youtubePrivacyStatus })).rejects.toMatchObject({ status: 400, code: 'invalid_youtube_privacy_status' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(queueSend).not.toHaveBeenCalled()
  })

  it('rejects YouTube visibility when YouTube is not selected', async () => {
    await expect(createManualCrossposts(testEnv(db, queueSend), { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['x'], youtubePrivacyStatus: 'public' })).rejects.toMatchObject({ status: 400, code: 'invalid_youtube_privacy_status' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['story', 'reel', 'reel_feed'] as const)('uses saved Instagram %s for automatic posts and explicit overrides for manual posts', async (destination) => {
    await addConnectedPlatform(db, 'instagram', 'conn_instagram')
    const env = { ...testEnv(db, queueSend), ENABLE_INSTAGRAM: 'true', INSTAGRAM_CLIENT_ID: 'client', INSTAGRAM_CLIENT_SECRET: 'secret' }
    await setPreference(db, { pubkey: PUBKEY_A, platform: 'instagram', connectionId: 'conn_instagram', mode: 'automatic', automaticEnabledAt: 1000, createdAt: 1000, updatedAt: 1000, instagramDestination: destination })
    fetchMock.mockImplementation(async () => Response.json({ event: event() }))
    const auto = await createAutomaticCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID })
    expect(auto.jobs[0].instagramDestination).toBe(destination)
    const duplicate = await createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['instagram'], instagramDestination: 'reel_feed' })
    expect(duplicate.jobs[0].instagramDestination).toBe(destination)
    expect(queueSend).toHaveBeenCalledTimes(1)
    fetchMock.mockImplementation(async () => Response.json({ event: event({ id: YOUTUBE_EVENT_ID }) }))
    const manual = await createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: YOUTUBE_EVENT_ID, platforms: ['instagram'], instagramDestination: 'story' })
    expect(manual.jobs[0].instagramDestination).toBe('story')
  })

  it('rejects a destination without Instagram before provider lookup or queue dispatch', async () => {
    await expect(createManualCrossposts(testEnv(db, queueSend), { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['x'], instagramDestination: 'story' })).rejects.toMatchObject({ status: 400, code: 'invalid_instagram_destination' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(queueSend).not.toHaveBeenCalled()
  })

  describe.each(['manual', 'automatic'] as const)('%s post text', (mode) => {
    it.each([
      { name: 'title-only post', content: '', title: 'A tiny human loop #loops', summary: '', expected: 'A tiny human loop #loops' },
      { name: 'blank content', content: ' \n ', title: '  A small dance 🎉  ', summary: '', expected: 'A small dance 🎉' },
      { name: 'summary fallback', content: '', title: 'Short title', summary: 'A complete description from the post', expected: 'A complete description from the post' },
      { name: 'original description', content: 'Original words\nwith a second line', title: 'Short title', summary: 'Older summary', expected: 'Original words\nwith a second line' },
    ])('preserves $name in X and Instagram captions', async ({ content, title, summary, expected }) => {
      await addConnectedPlatform(db, 'x', 'conn_x')
      await addConnectedPlatform(db, 'instagram', 'conn_instagram')
      const env = { ...testEnv(db, queueSend), ENABLE_X: 'true', TWITTER_CLIENT_ID: 'client', TWITTER_CLIENT_SECRET: 'secret', ENABLE_INSTAGRAM: 'true', INSTAGRAM_CLIENT_ID: 'client', INSTAGRAM_CLIENT_SECRET: 'secret' }
      const source = event({ content, tags: [...event().tags, ['title', title], ['summary', summary]] })
      fetchMock.mockResolvedValueOnce(Response.json({ event: source }))
      if (mode === 'automatic') {
        for (const platform of ['x', 'instagram'] as const) {
          await setPreference(db, { pubkey: PUBKEY_A, platform, connectionId: 'conn_' + platform, mode: 'automatic', automaticEnabledAt: 1000, createdAt: 1000, updatedAt: 1000 })
        }
      }
      const result = mode === 'manual'
        ? await createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['x', 'instagram'] })
        : await createAutomaticCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID })
      expect(result.jobs).toHaveLength(2)
      for (const job of result.jobs) {
        expect(job.caption).toBe(expected + '\n\non Divine\nhttps://divine.video/video/' + VIDEO_EVENT_ID)
      }
      expect(queueSend).toHaveBeenCalledTimes(2)
    })
  })

  it('manual crosspost creates one job per selected connected platform', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    await addConnectedPlatform(db, 'youtube', 'conn_youtube')
    fetchMock.mockResolvedValueOnce(Response.json({ event: event() }))

    const result = await createManualCrossposts(testEnv(db, queueSend), {
      pubkey: PUBKEY_A,
      eventId: VIDEO_EVENT_ID,
      platforms: ['x', 'youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' },
    })

    expect(result.jobs).toHaveLength(2)
    expect(result.jobs.map((job) => job.platform)).toEqual(['x', 'youtube'])
    expect(result.jobs[0]).toMatchObject({
      pubkey: PUBKEY_A,
      videoEventId: VIDEO_EVENT_ID,
      sourceMediaUrl: 'https://media.divine.video/video.mp4',
      sourceMediaHash: 'abc123',
      status: 'queued',
    })
    // Every job carries attribution: without it a crosspost hands content to
    // another platform with no creator credit and no route back to Divine.
    expect(result.jobs[0].caption).toContain('six seconds of weird human internet')
    expect(result.jobs[0].caption).toContain(`https://divine.video/video/${VIDEO_EVENT_ID}`)
    expect(result.jobs[0].expiresAt - result.jobs[0].createdAt).toBe(48 * 60 * 60)
    expect(queueSend).toHaveBeenCalledTimes(2)
    expect(queueSend).toHaveBeenNthCalledWith(1, { jobId: result.jobs[0].id })
    expect(queueSend).toHaveBeenNthCalledWith(2, { jobId: result.jobs[1].id })
  })

  it('accepts real NIP-71 imeta entries for Divine media URLs and hashes', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    fetchMock.mockResolvedValueOnce(Response.json({ event: nip71Event() }))

    const result = await createManualCrossposts(testEnv(db, queueSend), {
      pubkey: PUBKEY_A,
      eventId: VIDEO_EVENT_ID,
      platforms: ['x'],
    })

    expect(result.jobs[0]).toMatchObject({
      sourceMediaUrl: 'https://media.divine.video/video.mp4',
      sourceMediaHash: 'abc123',
    })
  })

  it('rejects non-Divine media URLs', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    fetchMock.mockResolvedValueOnce(
      Response.json({ event: nip71Event({ tags: [['imeta', 'url https://example.com/video.mp4', 'x abc123']] }) }),
    )

    await expect(
      createManualCrossposts(testEnv(db, queueSend), {
        pubkey: PUBKEY_A,
        eventId: VIDEO_EVENT_ID,
        platforms: ['x'],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'not_eligible' })
  })

  it('duplicate manual request returns the same jobs and does not enqueue duplicates', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ event: event() })))

    const first = await createManualCrossposts(testEnv(db, queueSend), {
      pubkey: PUBKEY_A,
      eventId: VIDEO_EVENT_ID,
      platforms: ['x'],
    })
    const duplicate = await createManualCrossposts(testEnv(db, queueSend), {
      pubkey: PUBKEY_A,
      eventId: VIDEO_EVENT_ID,
      platforms: ['x'],
    })

    expect(duplicate.jobs).toEqual(first.jobs)
    expect(queueSend).toHaveBeenCalledTimes(1)
  })

  it('auto endpoint uses only automatic preferences', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    await addConnectedPlatform(db, 'youtube', 'conn_youtube')
    await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'x',
      connectionId: 'conn_x',
      mode: 'automatic',
      automaticEnabledAt: 1_500,
      createdAt: 1_000,
      updatedAt: 1_500,
    })
    await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'youtube',
      connectionId: 'conn_youtube',
      mode: 'manual',
      automaticEnabledAt: null,
      createdAt: 1_000,
      updatedAt: 1_500,
    })
    fetchMock.mockResolvedValueOnce(Response.json({ event: event() }))

    const result = await createAutomaticCrossposts(testEnv(db, queueSend), {
      pubkey: PUBKEY_A,
      eventId: VIDEO_EVENT_ID,
    })

    expect(result.jobs.map((job) => job.platform)).toEqual(['x'])
    expect(queueSend).toHaveBeenCalledTimes(1)
  })

  it('auto endpoint ignores events older than automatic_enabled_at', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'x',
      connectionId: 'conn_x',
      mode: 'automatic',
      automaticEnabledAt: 3_000,
      createdAt: 1_000,
      updatedAt: 3_000,
    })
    fetchMock.mockResolvedValueOnce(Response.json({ event: event({ created_at: 2_000 }) }))

    const result = await createAutomaticCrossposts(testEnv(db, queueSend), {
      pubkey: PUBKEY_A,
      eventId: VIDEO_EVENT_ID,
    })

    expect(result.jobs).toEqual([])
    expect(queueSend).not.toHaveBeenCalled()
  })

  it('rejects non-owner events with 403', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    fetchMock.mockResolvedValueOnce(Response.json({ event: event({ pubkey: PUBKEY_B }) }))

    await expect(
      createManualCrossposts(testEnv(db, queueSend), {
        pubkey: PUBKEY_A,
        eventId: VIDEO_EVENT_ID,
        platforms: ['x'],
      }),
    ).rejects.toMatchObject({ status: 403, code: 'not_owner' })
  })

  it('rejects unsupported event kinds with not_eligible', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    fetchMock.mockResolvedValueOnce(Response.json({ event: event({ kind: 1 }) }))

    await expect(
      createManualCrossposts(testEnv(db, queueSend), {
        pubkey: PUBKEY_A,
        eventId: VIDEO_EVENT_ID,
        platforms: ['x'],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'not_eligible' })
  })

  it('rejects missing media URL or hash with not_eligible', async () => {
    await addConnectedPlatform(db, 'x', 'conn_x')
    fetchMock.mockResolvedValueOnce(Response.json({ event: event({ tags: [['imeta', 'url', 'https://media.divine.video/video.mp4']] }) }))

    await expect(
      createManualCrossposts(testEnv(db, queueSend), {
        pubkey: PUBKEY_A,
        eventId: VIDEO_EVENT_ID,
        platforms: ['x'],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'not_eligible' })
  })

  it('rejects when the fetched event id does not match the request', async () => {
    await addConnectedPlatform(db, 'youtube', 'conn_youtube')
    fetchMock.mockResolvedValueOnce(Response.json({ event: event({ id: YOUTUBE_EVENT_ID }) }))

    await expect(
      createManualCrossposts(testEnv(db, queueSend), {
        pubkey: PUBKEY_A,
        eventId: VIDEO_EVENT_ID,
        platforms: ['youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'not_eligible' })
  })
  it.each(SOURCE_METADATA_CASES)('preserves X, Instagram and YouTube enqueue compatibility for $name', async ({ tags, url, hash }) => {
    for (const platform of ['x', 'instagram', 'youtube'] as const) await addConnectedPlatform(db, platform, 'conn_' + platform)
    fetchMock.mockResolvedValueOnce(Response.json({ event: event({ tags }) }))
    const result = await createManualCrossposts({ ...testEnv(db, queueSend), ENABLE_INSTAGRAM: 'true', INSTAGRAM_CLIENT_ID: 'synthetic-client', INSTAGRAM_CLIENT_SECRET: 'synthetic-secret' }, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['x', 'instagram', 'youtube'], youtubeChannel: { connectionId: 'conn_youtube', channelId: 'youtube-external-account' } })
    expect(result.jobs).toHaveLength(3)
    for (const job of result.jobs) expect(job).toMatchObject({ sourceMediaUrl: url, sourceMediaHash: hash, status: 'queued' })
    expect(queueSend).toHaveBeenCalledTimes(3)
  })

})

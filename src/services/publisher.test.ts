// ABOUTME: Exercises publishing claims, provider outcomes, and retry handling.
// ABOUTME: Uses real adapters with upstream requests stubbed at the fetch boundary.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TIKTOK_CREATOR, tiktokOptions } from '../platforms/tiktok.test-helpers'
import { listAttempts, recordAttempt } from '../db/attempts'
import { getConnection, upsertConnection } from '../db/connections'
import { createOrGetJob, getJob, updateJobStatus, recoverStaleXClaims, claimJobForPublish } from '../db/jobs'
import { setPreference } from '../db/preferences'
import { applyMigrations, connection, job, PUBKEY_A } from '../db/test-helpers'
import type { Env, Platform } from '../types'
import { encryptToken } from '../utils/crypto'
import { processCrosspostJob, providerCheckpoint, PublisherRetryError } from './publisher'

const KEY = '0123456789abcdef0123456789abcdef'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function env(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    CACHE_KV: {} as KVNamespace,    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video/oauth',
    TOKEN_ENCRYPTION_KEY: KEY,
    ...overrides,
  }
}

function platformEnv(db: D1Database, platform: Platform): Env {
  const base = env(db)
  switch (platform) {
    case 'snapchat': return { ...base, ENABLE_SNAPCHAT: 'true', SNAPCHAT_PUBLIC_PROFILE_APPROVED: 'true', SNAPCHAT_CLIENT_ID: 'client', SNAPCHAT_CLIENT_SECRET: 'secret' }
    case 'instagram':
      return {
        ...base,
        ENABLE_INSTAGRAM: 'true',
        INSTAGRAM_CLIENT_ID: 'instagram-client',
        INSTAGRAM_CLIENT_SECRET: 'instagram-secret',
      }
    case 'tiktok':
      return {
        ...base,
        ENABLE_TIKTOK: 'true',
        TIKTOK_CLIENT_KEY: 'tiktok-client',
        TIKTOK_CLIENT_SECRET: 'tiktok-secret',
      }
    case 'x':
      return {
        ...base,
        ENABLE_X: 'true',
        TWITTER_CLIENT_ID: 'x-client',
        TWITTER_CLIENT_SECRET: 'x-secret',
      }
    case 'youtube':
      return {
        ...base,
        ENABLE_YOUTUBE: 'true',
        GOOGLE_CLIENT_ID: 'google-client',
        GOOGLE_CLIENT_SECRET: 'google-secret',
      }
  }
}

async function seedConnectedJob(db: D1Database, platform: Platform, overrides: Parameters<typeof job>[0] = {}) {
  const encryptedAccessToken = await encryptToken('access-token', KEY)
  await upsertConnection(
    db,
    connection({
      id: 'conn_1',
      platform,
      encryptedAccessToken,
      encryptedRefreshToken: null,
      tokenExpiresAt: null,
      externalAccountId: overrides.externalAccountId ?? 'external-account-1',
    }),
  )
  const created = await createOrGetJob(db, job({ id: 'job_1', platform, ...(platform === 'tiktok' ? { tiktokPostOptions: tiktokOptions() } : {}), ...overrides }))
  return created.job
}

function rejectDispatchingWrites(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver)
      return (query: string) => {
        const statement = target.prepare(query)
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== 'bind') return Reflect.get(statementTarget, statementProperty, statementReceiver)
            return (...bindings: unknown[]) => {
              const bound = statementTarget.bind(...bindings)
              if (
                query.includes("SET status = 'dispatching'") ||
                (query.includes('RETURNING *') && bindings[0] === 'dispatching')
              ) {
                return new Proxy(bound, {
                  get(boundTarget, boundProperty, boundReceiver) {
                    if (boundProperty === 'first') {
                      return async () => {
                        throw new Error('dispatch fence write failed')
                      }
                    }
                    return Reflect.get(boundTarget, boundProperty, boundReceiver)
                  },
                })
              }
              return bound
            }
          },
        })
      }
    },
  }) as D1Database
}

function replaceClaimWithDispatchingOwner(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver)
      return (query: string) => {
        const statement = target.prepare(query)
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== 'bind') return Reflect.get(statementTarget, statementProperty, statementReceiver)
            return (...bindings: unknown[]) => {
              const bound = statementTarget.bind(...bindings)
              if (!query.includes("status IN ('queued', 'failed')")) return bound
              return new Proxy(bound, {
                get(boundTarget, boundProperty, boundReceiver) {
                  if (boundProperty === 'first') {
                    return async () => {
                      await updateJobStatus(db, { id: 'job_1', status: 'dispatching', updatedAt: 3_000 })
                      return null
                    }
                  }
                  return Reflect.get(boundTarget, boundProperty, boundReceiver)
                },
              })
            }
          },
        })
      }
    },
  }) as D1Database
}

describe('publisher service', () => {
  let db: D1Database
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = await applyMigrations()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  it.each(['tiktok', 'youtube', 'snapchat'] as const)('keeps accepted %s posts processing through billing outages and ends unknown without republishing', async (platform) => {
    await seedConnectedJob(db, platform, { status: 'processing', externalPostId: '33333333-3333-4333-8333-333333333333', externalAccountId: '11111111-1111-4111-8111-111111111111' })
    if (platform === 'snapchat') {
      const current = (await getConnection(db, 'conn_1', PUBKEY_A))!
      await updateJobStatus(db, { id: 'job_1', status: 'processing', externalPostId: '33333333-3333-4333-8333-333333333333', updatedAt: 1000 })
      await upsertConnection(db, { ...current, externalAccountId: '11111111-1111-4111-8111-111111111111', metadataJson: JSON.stringify({ account: { profileConfirmed: true } }) })
      await recordAttempt(db, { id: 'snap_checkpoint', jobId: 'job_1', status: 'processing', errorCode: null, errorMessage: null, providerStatus: null, providerResponseJson: JSON.stringify({ stage: 'spotlight_submitted', spotlightId: '33333333-3333-4333-8333-333333333333', profileId: '11111111-1111-4111-8111-111111111111', destination: 'spotlight' }), createdAt: 1500 })
    }
    fetchMock.mockImplementation(async () => Response.json({ error: { message: 'synthetic-private-billing' } }, { status: 402 }))
    await expect(processCrosspostJob(platformEnv(db, platform), 'job_1', { now: 2000 })).rejects.toBeInstanceOf(PublisherRetryError)
    expect(await getJob(db, 'job_1')).toMatchObject({ status: 'processing', externalPostId: '33333333-3333-4333-8333-333333333333', retryCount: 1, nextRetryAt: 2060 })
    await updateJobStatus(db, { id: 'job_1', status: 'processing', retryCount: 5, nextRetryAt: 2100, updatedAt: 2000 })
    expect(await processCrosspostJob(platformEnv(db, platform), 'job_1', { now: 2100 })).toEqual({ status: 'failed' })
    expect(await getJob(db, 'job_1')).toMatchObject({ status: 'failed', externalPostId: '33333333-3333-4333-8333-333333333333', errorCode: 'ambiguous_post_result', nextRetryAt: null })
    expect((await getJob(db, 'job_1'))?.errorMessage).toContain('Check the provider')
    const count = fetchMock.mock.calls.length
    await processCrosspostJob(platformEnv(db, platform), 'job_1', { now: 2200 })
    expect(fetchMock).toHaveBeenCalledTimes(count)
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('init'))).toBe(true)
    expect(await getConnection(db, 'conn_1', PUBKEY_A)).toMatchObject({ status: 'connected' })
  })

  it('ends an accepted billing-blocked upload as unknown when its polling window expires', async () => {
    await seedConnectedJob(db, 'youtube', { status: 'processing', externalPostId: 'synthetic01', errorCode: 'provider_payment_required', expiresAt: 2000 })
    expect(await processCrosspostJob(platformEnv(db, 'youtube'), 'job_1', { now: 2000 })).toEqual({ status: 'failed' })
    expect(await getJob(db, 'job_1')).toMatchObject({ externalPostId: 'synthetic01', errorCode: 'ambiguous_post_result', nextRetryAt: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not overwrite a winning readback when a billing-blocked upload expires', async () => {
    await seedConnectedJob(db, 'youtube', { status: 'processing', externalPostId: 'synthetic01', errorCode: 'provider_payment_required', expiresAt: 2000 })
    let raced = false
    const concurrentDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (query: string) => {
          if (!raced && query.trim().startsWith('UPDATE jobs')) {
            raced = true
            // Queue a real concurrent winner before the expiry UPDATE runs.
            return new Proxy(target.prepare(query), {
              get(statement, key, statementReceiver) {
                if (key !== 'bind') return Reflect.get(statement, key, statementReceiver)
                return (...bindings: unknown[]) => {
                  const bound = statement.bind(...bindings)
                  return new Proxy(bound, {
                    get(result, method, resultReceiver) {
                      if (method !== 'first' && method !== 'run') return Reflect.get(result, method, resultReceiver)
                      return async () => {
                        await updateJobStatus(db, { id: 'job_1', status: 'posted', updatedAt: 1999, errorCode: null, externalPostUrl: 'https://www.youtube.com/watch?v=synthetic01' })
                        return method === 'first' ? result.first() : result.run()
                      }
                    },
                  })
                }
              },
            })
          }
          return target.prepare(query)
        }
      },
    }) as D1Database
    expect(await processCrosspostJob(platformEnv(concurrentDb, 'youtube'), 'job_1', { now: 2000 })).toEqual({ status: 'posted' })
    expect(await getJob(db, 'job_1')).toMatchObject({ status: 'posted', errorCode: null })
  })

  it.each([
    [403, 'quotaExceeded', 'provider_quota_exceeded', 'quota'],
    [400, 'uploadLimitExceeded', 'provider_upload_limit', 'upload limit'],
    [403, 'forbidden', 'needs_reauth', 'provider request failed'],
  ])('handles YouTube %s %s without confusing quota with authorization', async (status, reason, code, message) => {
    await seedConnectedJob(db, 'youtube')
    fetchMock.mockImplementation(async (url) => String(url).includes('cdn.divine.video') ? new Response('video') : Response.json({ error: { code: status, errors: [{ reason }], message: 'synthetic upstream detail' } }, { status: Number(status) }))
    await processCrosspostJob(platformEnv(db, 'youtube'), 'job_1', { now: 2000 })
    expect(await getJob(db, 'job_1')).toMatchObject({ errorCode: code, nextRetryAt: null })
    expect((await getJob(db, 'job_1'))?.errorMessage).toContain(message)
    expect(await getConnection(db, 'conn_1', PUBKEY_A)).toMatchObject({ status: code === 'needs_reauth' ? 'needs_reauth' : 'connected' })
    if (code === 'provider_quota_exceeded' || code === 'provider_upload_limit') {
      const failed = await getJob(db, 'job_1')
      const requestCount = fetchMock.mock.calls.length
      expect(await processCrosspostJob(platformEnv(db, 'youtube'), 'job_1', { now: 2100 })).toEqual({ status: 'failed' })
      expect(fetchMock).toHaveBeenCalledTimes(requestCount)
      expect(await getJob(db, 'job_1')).toEqual(failed)
      expect(await getConnection(db, 'conn_1', PUBKEY_A)).toMatchObject({ status: 'connected' })
    }
  })

  it('does not upload a known YouTube video again after terminal processing rejection', async () => {
    await seedConnectedJob(db, 'youtube', { status: 'processing', externalPostId: 'synthetic01', youtubePrivacyStatus: 'private' })
    const fetchMock = vi.fn(async () => Response.json({ items: [{ id: 'synthetic01', status: { uploadStatus: 'rejected', privacyStatus: 'private' }, processingDetails: { processingStatus: 'failed' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await processCrosspostJob(platformEnv(db, 'youtube'), 'job_1', { now: 2000 })).toEqual({ status: 'failed' })
    expect(await getJob(db, 'job_1')).toMatchObject({ externalPostId: 'synthetic01', errorCode: 'media_rejected', nextRetryAt: null })
    await processCrosspostJob(platformEnv(db, 'youtube'), 'job_1', { now: 2200 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('recovers stale YouTube dispatch as ambiguous without queueing another upload', async () => {
    await seedConnectedJob(db, 'youtube', { status: 'dispatching', updatedAt: 1000 })
    await recoverStaleXClaims(db, 2000, 300)
    expect(await getJob(db, 'job_1')).toMatchObject({ status: 'failed', errorCode: 'ambiguous_post_result', nextRetryAt: null })
  })

  it('persists accepted YouTube ID before polling and never uploads it twice', async () => {
    await seedConnectedJob(db, 'youtube', { youtubePrivacyStatus: 'unlisted', youtubeTitle: 'Source title' })
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).includes('cdn.divine.video')) return new Response('video')
      if (String(url).includes('uploadType=resumable')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ snippet: { title: 'Source title' }, status: { privacyStatus: 'unlisted' } })
        return new Response('{}', { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic' } })
      }
      if (String(url).includes('upload_id=synthetic')) {
        expect(await getJob(db, 'job_1')).toMatchObject({ status: 'dispatching' })
        return Response.json({ id: 'synthetic01', access_token: 'discard-me' })
      }
      expect(await getJob(db, 'job_1')).toMatchObject({ externalPostId: 'synthetic01' })
      return Response.json({ items: [{ id: 'synthetic01', status: { uploadStatus: 'processed', privacyStatus: 'unlisted' }, processingDetails: { processingStatus: 'succeeded' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const youtubeEnv = platformEnv(db, 'youtube')
    expect(await processCrosspostJob(youtubeEnv, 'job_1', { now: 2000, fenceNow: 2000 })).toMatchObject({ status: 'processing' })
    expect((await listAttempts(db, 'job_1'))[0].providerResponseJson).toBe('{"id":"synthetic01"}')
    expect(await processCrosspostJob(youtubeEnv, 'job_1', { now: 2060 })).toEqual({ status: 'posted' })
    expect(await getJob(db, 'job_1')).toMatchObject({ status: 'posted', externalPostUrl: 'https://www.youtube.com/watch?v=synthetic01' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('never retries an interrupted YouTube upload after dispatch', async () => {
    await seedConnectedJob(db, 'youtube')
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('cdn.divine.video')) return new Response('video')
      if (String(url).includes('uploadType=resumable')) return new Response('{}', { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic' } })
      throw new Error('connection interrupted after accepting upload')
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await processCrosspostJob(platformEnv(db, 'youtube'), 'job_1', { now: 2000, fenceNow: 2000 })).toEqual({ status: 'failed' })
    expect(await getJob(db, 'job_1')).toMatchObject({ errorCode: 'ambiguous_post_result', nextRetryAt: null })
    await processCrosspostJob(platformEnv(db, 'youtube'), 'job_1', { now: 2200 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(['queued', 'processing'] as const)('stops X billing failures from %s without retrying on redelivery', async (status) => {
    await seedConnectedJob(db, 'x', { status, externalPostId: status === 'processing' ? 'media-id' : null })
    if (status === 'queued') fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
    fetchMock.mockResolvedValueOnce(Response.json({ type: 'Payment Required', message: 'credits depleted private-billing-sentinel' }, { status: 402 }))

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2000 })).resolves.toEqual({ status: 'failed' })
    expect(await getJob(db, 'job_1')).toMatchObject({ status: 'failed', errorCode: 'provider_payment_required', nextRetryAt: null, retryCount: 0 })
    expect(await listAttempts(db, 'job_1')).toEqual([expect.objectContaining({ errorCode: 'provider_payment_required', providerStatus: 402, providerResponseJson: null })])
    expect(JSON.stringify(await getJob(db, 'job_1'))).not.toContain('private-billing-sentinel')
    const requestCount = fetchMock.mock.calls.length
    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2100 })).resolves.toEqual({ status: 'failed' })
    expect(fetchMock.mock.calls).toHaveLength(requestCount)
    expect(await getConnection(db, 'conn_1', PUBKEY_A)).toMatchObject({ status: 'connected' })
  })

  it('publishes the immutable Instagram destination after its saved default changes', async () => {
    await seedConnectedJob(db, 'instagram', { instagramDestination: 'story' })
    await setPreference(db, { pubkey: PUBKEY_A, platform: 'instagram', connectionId: 'conn_1', mode: 'manual', automaticEnabledAt: null, createdAt: 1000, updatedAt: 2000, instagramDestination: 'reel_feed' })
    fetchMock.mockResolvedValueOnce(Response.json({ id: 'story-container' }))
      .mockResolvedValueOnce(Response.json({ status_code: 'IN_PROGRESS' }))
    expect(await processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2000 })).toMatchObject({ status: 'processing' })
    const containerBody = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(containerBody.get('media_type')).toBe('STORIES')
    expect(containerBody.has('caption')).toBe(false)
    expect(containerBody.has('share_to_feed')).toBe(false)
    fetchMock.mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'published-story' }))
      .mockResolvedValueOnce(Response.json({ permalink: 'https://www.instagram.com/stories/example/1/' }))
    expect(await processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2100 })).toMatchObject({ status: 'posted' })
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/media'))).toHaveLength(1)
    expect(await getJob(db, 'job_1')).toMatchObject({ instagramDestination: 'story', externalPostId: 'published-story' })
  })

  it('does not retry an Instagram publish whose successful response has no media ID', async () => {
    await seedConnectedJob(db, 'instagram', { instagramDestination: 'story' })
    fetchMock.mockResolvedValueOnce(Response.json({ id: 'story-container' }))
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({}))
    expect(await processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2000 })).toMatchObject({ status: 'failed' })
    expect(await getJob(db, 'job_1')).toMatchObject({ errorCode: 'ambiguous_post_result', nextRetryAt: null })
    const requests = fetchMock.mock.calls.length
    await processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 3000 })
    expect(fetchMock).toHaveBeenCalledTimes(requests)
  })

  it('marks a successful publish as posted and records an attempt', async () => {
    await seedConnectedJob(db, 'instagram')
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: 'container-id' }))
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'ig-post-id' }))
      .mockResolvedValueOnce(Response.json({ permalink: 'https://instagram.example/reel' }))

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'posted',
      externalPostId: 'ig-post-id',
      externalPostUrl: 'https://instagram.example/reel',
      errorCode: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'posted', errorCode: null, providerResponseJson: null }),
    ])
  })

  it('records processing state and schedules a retry', async () => {
    await seedConnectedJob(db, 'tiktok')
    fetchMock
      .mockResolvedValueOnce(Response.json({ data: TIKTOK_CREATOR }))
      .mockResolvedValueOnce(
        Response.json({
          data: { publish_id: 'publish-id', nested_secret: 'tiktok-processing-sentinel' },
          error: { code: 'ok', token: 'tiktok-token-sentinel' },
        }),
      )

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'processing',
      retryDelaySeconds: 60,
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_060,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'processing', providerResponseJson: '{"publish_id":"publish-id"}' }),
    ])
  })

  it('allowlists provider checkpoints and returns null when no allowed field is present', () => {
    const raw = {
      id: 'id',
      creationId: 'creation-id',
      externalAccountId: 'account-id',
      publish_id: 'publish-id',
      mediaId: 'media-id',
      caption: 'caption',
      token: 'checkpoint-token-sentinel',
      nested: { raw: 'checkpoint-nested-sentinel' },
    }

    expect(providerCheckpoint('instagram', raw)).toEqual({
      id: 'id',
      creationId: 'creation-id',
      externalAccountId: 'account-id',
    })
    expect(providerCheckpoint('tiktok', raw)).toEqual({ publish_id: 'publish-id' })
    expect(providerCheckpoint('x', raw)).toEqual({ mediaId: 'media-id', caption: 'caption' })
    expect(providerCheckpoint('youtube', raw)).toEqual({ id: 'id' })
    expect(providerCheckpoint('x', { token: 'only-secret-sentinel' })).toBeNull()
    expect(providerCheckpoint('instagram', { id: '', token: 'empty-id-secret-sentinel' })).toBeNull()

    let inheritedGetterReads = 0
    const inherited = Object.create({
      get mediaId() {
        inheritedGetterReads += 1
        return 'inherited-media-id'
      },
      caption: 'inherited caption',
    }) as Record<string, unknown>
    expect(providerCheckpoint('x', inherited)).toBeNull()
    expect(inheritedGetterReads).toBe(0)
    expect(providerCheckpoint('x', { mediaId: '  trimmed-media-id  ', caption: '  verbatim caption  ' })).toEqual({
      mediaId: 'trimmed-media-id',
      caption: '  verbatim caption  ',
    })
  })

  it('raises the X dispatch fence before tweet fetch and stores only the full posted identifiers', async () => {
    await seedConnectedJob(db, 'x')
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id', init_secret: 'init-sentinel' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id', finalize_secret: 'finalize-sentinel' } }))
      .mockImplementationOnce(async () => {
        await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
          status: 'dispatching',
          updatedAt: 2_500,
        })
        return Response.json({ data: { id: 'full-tweet-id', token: 'tweet-token-sentinel' } })
      })

    await expect(
      processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000, fenceNow: 2_500 }),
    ).resolves.toEqual({ status: 'posted' })

    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'posted',
      externalPostId: 'full-tweet-id',
      externalPostUrl: 'https://x.com/i/web/status/full-tweet-id',
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'posted', providerResponseJson: null }),
    ])
  })

  it('stores only the X media checkpoint while processing', async () => {
    await seedConnectedJob(db, 'x')
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id', init_secret: 'init-sentinel' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            id: 'media-id',
            processing_info: { state: 'pending', token: 'finalize-token-sentinel', nested: { raw: 'raw-sentinel' } },
          },
        }),
      )

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'processing',
      retryDelaySeconds: 60,
    })

    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({
        status: 'processing',
        providerResponseJson: '{"mediaId":"media-id","caption":"six seconds of weird human internet"}',
      }),
    ])
  })

  it.each([
    ['provider error', 503],
    ['missing tweet id', 200],
    ['malformed tweet id', 200],
    ['transport error', null],
  ])('turns an X %s after the dispatch fence into a terminal ambiguous result and never retries', async (outcome, providerStatus) => {
    await seedConnectedJob(db, 'x')
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id' } }))
    if (outcome === 'provider error') {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          { error: { message: 'unknown tweet outcome', token: 'tweet-error-token-sentinel' } },
          { status: 503 },
        ),
      )
    } else if (outcome === 'missing tweet id') {
      fetchMock.mockResolvedValueOnce(
        Response.json({ data: { token: 'missing-tweet-id-token-sentinel', nested: { raw: 'tweet-raw-sentinel' } } }),
      )
    } else if (outcome === 'malformed tweet id') {
      fetchMock.mockResolvedValueOnce(
        Response.json({ data: { id: { raw: 'malformed-tweet-id-sentinel' }, token: 'tweet-token-sentinel' } }),
      )
    } else {
      fetchMock.mockRejectedValueOnce(new Error('transport-error-sentinel'))
    }

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'failed',
    })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'ambiguous_post_result',
      nextRetryAt: null,
      externalPostId: null,
      externalPostUrl: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'ambiguous_post_result',
        providerStatus,
        providerResponseJson: null,
      }),
    ])

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_060 })).resolves.toEqual({
      status: 'failed',
    })
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('never calls X when the dispatch fence update fails and keeps the failure pre-fence retryable', async () => {
    await seedConnectedJob(db, 'x')
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id' } }))

    const failingEnv = { ...platformEnv(db, 'x'), DB: rejectDispatchingWrites(db) }
    await expect(processCrosspostJob(failingEnv, 'job_1', { now: 2_000 })).rejects.toBeInstanceOf(PublisherRetryError)

    expect(fetchMock.mock.calls.some((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toBe(false)
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'unknown_platform_error',
      nextRetryAt: 2_060,
    })
  })

  it('prevents a stale uploading claim from fencing or mutating a newer owner', async () => {
    await seedConnectedJob(db, 'x')
    const staleSourceStarted = deferred<void>()
    const staleSource = deferred<Response>()
    let sourceRequests = 0
    let initRequests = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://cdn.divine.video/video.mp4') {
        sourceRequests += 1
        if (sourceRequests === 1) {
          staleSourceStarted.resolve()
          return staleSource.promise
        }
        return new Response(new Uint8Array([4, 5, 6]))
      }
      if (url.startsWith('https://api.x.com/2/media/upload/')) {
        if (url.endsWith('/initialize')) {
          initRequests += 1
          return Response.json({ data: { id: initRequests === 1 ? 'current-media-id' : 'stale-media-id' } })
        }
        if (url.endsWith('/append')) return new Response(null, { status: 204 })
        return Response.json({ data: { id: initRequests === 1 ? 'current-media-id' : 'stale-media-id' } })
      }
      if (url === 'https://api.x.com/2/tweets') {
        return Response.json({ data: { id: 'current-tweet-id' } })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const staleWorker = processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })
    await staleSourceStarted.promise
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({ status: 'uploading', updatedAt: 2_000 })

    await updateJobStatus(db, { id: 'job_1', status: 'queued', updatedAt: 3_000, nextRetryAt: null })
    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 3_001 })).resolves.toEqual({
      status: 'posted',
    })

    staleSource.resolve(new Response(new Uint8Array([1, 2, 3])))
    await expect(staleWorker).resolves.toEqual({ status: 'posted' })

    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'posted',
      externalPostId: 'current-tweet-id',
      externalPostUrl: 'https://x.com/i/web/status/current-tweet-id',
      errorCode: null,
      retryCount: 0,
      nextRetryAt: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'posted', errorCode: null, providerResponseJson: null }),
    ])
  })

  it('prevents a stale pre-fence failure from mutating a newer dispatching owner', async () => {
    await seedConnectedJob(db, 'x')
    const staleSourceStarted = deferred<void>()
    const staleSource = deferred<Response>()
    const currentTweetStarted = deferred<void>()
    const currentTweet = deferred<Response>()
    let sourceRequests = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://cdn.divine.video/video.mp4') {
        sourceRequests += 1
        if (sourceRequests === 1) {
          staleSourceStarted.resolve()
          return staleSource.promise
        }
        return new Response(new Uint8Array([4, 5, 6]))
      }
      if (url.startsWith('https://api.x.com/2/media/upload/')) {
        if (url.endsWith('/initialize')) return Response.json({ data: { id: 'current-media-id' } })
        if (url.endsWith('/append')) return new Response(null, { status: 204 })
        return Response.json({ data: { id: 'current-media-id' } })
      }
      if (url === 'https://api.x.com/2/tweets') {
        currentTweetStarted.resolve()
        return currentTweet.promise
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const staleWorker = processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000, fenceNow: 2_100 })
    await staleSourceStarted.promise
    await updateJobStatus(db, { id: 'job_1', status: 'queued', updatedAt: 3_000, nextRetryAt: null })

    const currentWorker = processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 3_001, fenceNow: 4_000 })
    await currentTweetStarted.promise
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'dispatching',
      updatedAt: 4_000,
      retryCount: 0,
      nextRetryAt: null,
    })

    staleSource.resolve(Response.json({ error: 'stale source failure sentinel' }, { status: 503 }))
    await expect(staleWorker).resolves.toEqual({ status: 'dispatching' })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'dispatching',
      updatedAt: 4_000,
      errorCode: null,
      retryCount: 0,
      nextRetryAt: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([])
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)

    currentTweet.resolve(Response.json({ data: { id: 'current-tweet-id' } }))
    await expect(currentWorker).resolves.toEqual({ status: 'posted' })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'posted',
      externalPostId: 'current-tweet-id',
      externalPostUrl: 'https://x.com/i/web/status/current-tweet-id',
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'posted', errorCode: null, providerResponseJson: null }),
    ])
  })

  it('leaves a stale dispatching X job unclaimed for recovery work', async () => {
    await seedConnectedJob(db, 'x', { status: 'dispatching' })

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'dispatching',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('raises the same X dispatch fence when a processing status poll succeeds', async () => {
    await seedConnectedJob(db, 'x', {
      status: 'processing',
      externalPostId: 'media-id',
      nextRetryAt: 2_000,
    })
    fetchMock
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id', processing_info: { state: 'succeeded' } } }))
      .mockImplementationOnce(async () => {
        await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({ status: 'dispatching' })
        return Response.json({ data: { id: 'poll-tweet-id' } })
      })

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.x.com/2/media/upload?command=STATUS&media_id=media-id')
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)
  })

  it.each([
    ['duration_check_failed', 'failed', 'media_rejected'],
    ['auth_removed', 'needs_reauth', 'needs_reauth'],
  ])('finishes a TikTok processing job on %s without scheduling another poll', async (reason, status, errorCode) => {
    await seedConnectedJob(db, 'tiktok', {
      status: 'processing', externalPostId: 'publish-id', nextRetryAt: 2_000,
    })
    fetchMock.mockResolvedValueOnce(Response.json({
      data: { status: 'FAILED', fail_reason: reason }, error: { code: 'ok' },
    }))
    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 }))
      .resolves.toEqual({ status })
    expect(await getJob(db, 'job_1')).toMatchObject({ status, errorCode, externalPostId: 'publish-id', nextRetryAt: null })
    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2060 })).resolves.toEqual({ status })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await getJob(db, 'job_1')).toMatchObject({ status, externalPostId: 'publish-id' })
  })

  it('sanitizes a legacy raw provider attempt before TikTok polling', async () => {
    await seedConnectedJob(db, 'tiktok', {
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_000,
    })
    await recordAttempt(db, {
      id: 'legacy_attempt',
      jobId: 'job_1',
      status: 'processing',
      errorCode: null,
      errorMessage: null,
      providerStatus: null,
      providerResponseJson:
        '{"publish_id":"publish-id","token":"legacy-attempt-token-sentinel","nested":{"raw":"legacy-raw-sentinel"}}',
      createdAt: 1_500,
    })
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { status: 'PUBLISH_COMPLETE', publish_id: 'publish-id' }, error: { code: 'ok' } }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ publish_id: 'publish-id' })
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain('legacy-attempt-token-sentinel')
  })

  it('builds the Instagram poll fallback from the job identifiers', async () => {
    await seedConnectedJob(db, 'instagram', {
      status: 'processing',
      externalPostId: 'container-id',
      nextRetryAt: 2_000,
    })
    fetchMock
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'ig-post-id' }))
      .mockResolvedValueOnce(Response.json({ permalink: 'https://instagram.example/reel' }))

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/container-id')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.instagram.com/v23.0/external-account-1/media_publish',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('merges a partial legacy Instagram checkpoint over the safe job fallback', async () => {
    await seedConnectedJob(db, 'instagram', {
      status: 'processing',
      externalPostId: 'container-id',
      nextRetryAt: 2_000,
    })
    await recordAttempt(db, {
      id: 'legacy_instagram_attempt',
      jobId: 'job_1',
      status: 'processing',
      errorCode: null,
      errorMessage: null,
      providerStatus: null,
      providerResponseJson:
        '{"creationId":"container-id","token":"legacy-instagram-token-sentinel","nested":{"raw":"legacy-instagram-raw-sentinel"}}',
      createdAt: 1_500,
    })
    fetchMock
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'ig-post-id' }))
      .mockResolvedValueOnce(Response.json({ permalink: 'https://instagram.example/reel' }))

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.instagram.com/v23.0/external-account-1/media_publish',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('legacy-instagram-token-sentinel')
  })

  it('claims queued jobs atomically so duplicate delivery does not publish twice', async () => {
    await seedConnectedJob(db, 'instagram')
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: 'container-id' }))
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'ig-post-id' }))
      .mockResolvedValueOnce(Response.json({ permalink: 'https://instagram.example/reel' }))

    const results = await Promise.all([
      processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 }),
      processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 }),
    ])

    expect(results).toContainEqual({ status: 'posted' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await expect(listAttempts(db, 'job_1')).resolves.toHaveLength(1)
  })

  it('returns the current owner status without mutation when its claim loses a race', async () => {
    await seedConnectedJob(db, 'instagram')

    const racingEnv = { ...platformEnv(db, 'instagram'), DB: replaceClaimWithDispatchingOwner(db) }
    await expect(processCrosspostJob(racingEnv, 'job_1', { now: 2_000 })).resolves.toEqual({ status: 'dispatching' })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'dispatching',
      updatedAt: 3_000,
      retryCount: 0,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('polls a processing job and marks it posted when the platform is complete', async () => {
    await seedConnectedJob(db, 'tiktok', {
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_000,
    })
    await listAttempts(db, 'job_1')
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { status: 'PUBLISH_COMPLETE', publish_id: 'publish-id' }, error: { code: 'ok' } }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ publish_id: 'publish-id' })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({ status: 'posted' })
  })

  it('ends exhausted accepted TikTok polling with an unresolved publication', async () => {
    await seedConnectedJob(db, 'tiktok', {
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_000,
      retryCount: 5,
    })
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { status: 'PROCESSING_UPLOAD', publish_id: 'publish-id' }, error: { code: 'ok' } }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'failed',
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      retryCount: 6,
      errorCode: 'ambiguous_post_result',
      nextRetryAt: null,
    })
    const { recentDiagnostics } = await import('./reliability')
    expect(await recentDiagnostics(db, 'job_1')).toEqual([
      expect.objectContaining({ stage: 'ambiguous_post_result', outcome: 'failed', operation: 'publish' }),
    ])
  })

  it('retains disabled-platform failures without asking the user to reconnect', async () => {
    await seedConnectedJob(db, 'tiktok')
    await expect(processCrosspostJob(env(db), 'job_1', { now: 2_000 })).resolves.toEqual({ status: 'failed' })
    const { recentDiagnostics } = await import('./reliability')
    expect(await recentDiagnostics(db, 'job_1')).toEqual([
      expect.objectContaining({ stage: 'platform_disabled', outcome: 'failed' }),
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps processing jobs in poll mode after transient poll failures', async () => {
    await seedConnectedJob(db, 'tiktok', {
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_000,
    })
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: 'slow down' } }, { status: 429 }))

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).rejects.toBeInstanceOf(
      PublisherRetryError,
    )
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'processing',
      retryCount: 1,
      errorCode: 'processing_timeout',
      nextRetryAt: 2_060,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'processing', errorCode: 'rate_limited' }),
    ])

    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { status: 'PUBLISH_COMPLETE', publish_id: 'publish-id' }, error: { code: 'ok' } }),
    )
    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_060 })).resolves.toEqual({
      status: 'posted',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://open.tiktokapis.com/v2/post/publish/status/fetch/')
  })

  it('records a terminal polling provider error attempt as failed', async () => {
    await seedConnectedJob(db, 'x', {
      status: 'processing',
      externalPostId: 'media-id',
      nextRetryAt: 2_000,
    })
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { id: 'media-id', processing_info: { state: 'failed' } } }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'failed',
    })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'media_rejected',
      nextRetryAt: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'media_rejected' }),
    ])
  })

  it('sanitizes refreshed token metadata before storing connection metadata', async () => {
    await upsertConnection(
      db,
      connection({
        id: 'conn_1',
        platform: 'tiktok',
        encryptedAccessToken: await encryptToken('old-access-token', KEY),
        encryptedRefreshToken: await encryptToken('old-refresh-token', KEY),
        tokenExpiresAt: 1_000,
        metadataJson: '{}',
      }),
    )
    await createOrGetJob(db, job({ id: 'job_1', platform: 'tiktok', tiktokPostOptions: tiktokOptions() }))
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
          scope: 'video.publish',
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: TIKTOK_CREATOR }))
      .mockResolvedValueOnce(Response.json({ data: { publish_id: 'publish-id' }, error: { code: 'ok' } }))

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toMatchObject({
      status: 'processing',
    })

    const updated = await getConnection(db, 'conn_1', PUBKEY_A)
    expect(updated?.metadataJson).not.toContain('new-access-token')
    expect(updated?.metadataJson).not.toContain('new-refresh-token')
    expect(updated?.lastRefreshAt).toBe(2000)
  })

  it('marks revoked tokens as needs_reauth on the job and connection', async () => {
    await seedConnectedJob(db, 'tiktok')
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 'access_token_invalid' } }))

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'needs_reauth',
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'needs_reauth',
      errorCode: 'needs_reauth',
    })
    await expect(getConnection(db, 'conn_1', PUBKEY_A)).resolves.toMatchObject({ status: 'needs_reauth' })
  })

  it('schedules retry for rate limited provider failures', async () => {
    await seedConnectedJob(db, 'instagram')
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: 'try later' } }, { status: 429 }))

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).rejects.toBeInstanceOf(
      PublisherRetryError,
    )

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'rate_limited',
      retryCount: 1,
      nextRetryAt: 2_060,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({
        errorCode: 'rate_limited',
        providerStatus: 429,
        providerResponseJson: null,
      }),
    ])
  })

  it('skips expired jobs before publishing', async () => {
    await seedConnectedJob(db, 'instagram', { expiresAt: 1_999 })

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'skipped',
    })

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({ status: 'skipped', errorCode: 'expired' })
  })

  it('marks terminal media rejection as failed without retrying', async () => {
    await seedConnectedJob(db, 'instagram')
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: 'media_rejected', message: 'media rejected' } }, { status: 400 }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'failed',
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'media_rejected',
      retryCount: 0,
      nextRetryAt: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ errorCode: 'media_rejected', providerResponseJson: null }),
    ])
  })
})

it('rejects a legacy queued TikTok job with no manual options before dispatch', async () => {
  const db = await applyMigrations()
  await seedConnectedJob(db, 'tiktok', { tiktokPostOptions: null })
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  try {
    expect(await processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2000 })).toEqual({ status: 'failed' })
    expect(await getJob(db, 'job_1')).toMatchObject({ status: 'failed', errorCode: 'not_eligible', externalPostId: null, nextRetryAt: null })
    expect(upstream).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

describe('TikTok refresh ownership through the publisher', () => {
  it.each(['refresh', 'reconnect', 'disconnect'] as const)('preserves a winning concurrent %s after a losing refresh response', async (winner) => {
    const db = await applyMigrations()
    await seedConnectedJob(db, 'tiktok')
    await db.prepare('UPDATE connections SET token_expires_at = 1000, encrypted_refresh_token = ?').bind(await encryptToken('old-refresh', KEY)).run()
    const winningAccess = await encryptToken('winning-access', KEY)
    const winningRefresh = await encryptToken('winning-refresh', KEY)
    const providerCalls: { url: string; token: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('oauth/token')) {
        if (winner === 'disconnect') await db.prepare("UPDATE connections SET status = 'disconnected'").run()
        else await db.prepare("UPDATE connections SET encrypted_access_token = ?, encrypted_refresh_token = ?, token_expires_at = 9999999999, updated_at = 2001, status = 'connected'").bind(winningAccess, winningRefresh).run()
        return winner === 'reconnect'
          ? Response.json({ error: { code: 'access_token_invalid' } }, { status: 401 })
          : Response.json({ access_token: 'losing-access', refresh_token: 'losing-refresh', expires_in: 3600 })
      }
      providerCalls.push({ url: String(url), token: new Headers(init?.headers).get('authorization') })
      if (String(url).includes('creator_info')) return Response.json({ data: TIKTOK_CREATOR, error: { code: 'ok' } })
      return Response.json({ data: { publish_id: 'synthetic-publish-id' }, error: { code: 'ok' } })
    }))
    try {
      expect(await processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2000 })).toMatchObject({ status: winner === 'disconnect' ? 'needs_reauth' : 'processing' })
      expect(await getConnection(db, 'conn_1', PUBKEY_A)).toMatchObject(winner === 'disconnect' ? { status: 'disconnected' } : { status: 'connected', encryptedAccessToken: winningAccess, encryptedRefreshToken: winningRefresh })
      if (winner === 'disconnect') expect(providerCalls).toEqual([])
      else expect(providerCalls.every(call => call.token === 'Bearer winning-access')).toBe(true)
    } finally { vi.unstubAllGlobals() }
  })
  it('identifies TikTok in an ambiguous dispatch and never retries the init', async () => {
    const db = await applyMigrations()
    await seedConnectedJob(db, 'tiktok')
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({ data: TIKTOK_CREATOR, error: { code: 'ok' } })).mockRejectedValueOnce(new Error('interrupted init'))
    vi.stubGlobal('fetch', upstream)
    try {
      expect(await processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2000 })).toEqual({ status: 'failed' })
      expect(await getJob(db, 'job_1')).toMatchObject({ errorCode: 'ambiguous_post_result', errorMessage: 'TikTok upload result is ambiguous after dispatch', nextRetryAt: null })
      await processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2060 })
      expect(upstream).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })
})


describe('TikTok accepted publication and request credential boundaries', () => {
  it.each(['unfinished', 'failed read'] as const)('never initializes again after %s exhausts accepted status polling', async (outcome) => {
    const db = await applyMigrations()
    await seedConnectedJob(db, 'tiktok', { expiresAt: 100000 })
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(String(url))
      if (String(url).includes('creator_info')) return Response.json({ data: TIKTOK_CREATOR, error: { code: 'ok' } })
      if (String(url).includes('video/init')) return Response.json({ data: { publish_id: requests.filter(url => url.includes('video/init')).length === 1 ? 'accepted-original' : 'accepted-duplicate' }, error: { code: 'ok' } })
      expect(JSON.parse(String(init?.body))).toEqual({ publish_id: 'accepted-original' })
      return outcome === 'unfinished'
        ? Response.json({ data: { status: 'PROCESSING_UPLOAD' }, error: { code: 'ok' } })
        : Response.json({ error: { code: 'internal_error' } }, { status: 503 })
    }))
    try {
      expect(await processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2000, fenceNow: 2000 })).toMatchObject({ status: 'processing' })
      await db.prepare('UPDATE jobs SET retry_count = 5, next_retry_at = 2060').run()
      expect(await processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2060 })).toEqual({ status: 'failed' })
      await processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2120 })
      expect(await getJob(db, 'job_1')).toMatchObject({ externalPostId: 'accepted-original', status: 'failed', errorCode: 'ambiguous_post_result', nextRetryAt: null })
      expect(requests.filter(url => url.includes('video/init'))).toHaveLength(1)
      expect(requests.filter(url => url.includes('status/fetch'))).toHaveLength(1)
    } finally { vi.unstubAllGlobals() }
  })

  it.each(['queued', 'failed'] as const)('refuses an initial-publish claim for an accepted TikTok job marked %s', async (status) => {
    const db = await applyMigrations()
    await seedConnectedJob(db, 'tiktok', { status, externalPostId: 'accepted-original', errorCode: 'processing_timeout' })
    expect(await claimJobForPublish(db, 'job_1', 2000)).toBeNull()
    expect(await getJob(db, 'job_1')).toMatchObject({ status, externalPostId: 'accepted-original' })
  })

  it.each(['creator', 'status'].flatMap(stage => [false, true].flatMap(refreshed => ['none', 'refresh', 'reconnect', 'disconnect'].map(winner => ({ stage, refreshed, winner })))))('guards late $stage auth denial with refreshed=$refreshed and winner=$winner', async ({ stage, refreshed, winner }) => {
    const db = await applyMigrations()
    await seedConnectedJob(db, 'tiktok', stage === 'status' ? { status: 'processing', externalPostId: 'accepted-original' } : {})
    if (refreshed) await db.prepare('UPDATE connections SET token_expires_at = 1000, encrypted_refresh_token = ?').bind(await encryptToken('refresh-token', KEY)).run()
    const winningAccess = await encryptToken('winning-access', KEY)
    const winningRefresh = await encryptToken('winning-refresh', KEY)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('oauth/token')) return Response.json({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh', expires_in: 3600 })
      expect(new Headers(init?.headers).get('authorization')).toBe(refreshed ? 'Bearer refreshed-access' : 'Bearer access-token')
      if (winner === 'disconnect') await db.prepare("UPDATE connections SET status = 'disconnected'").run()
      if (winner === 'refresh' || winner === 'reconnect') await db.prepare("UPDATE connections SET encrypted_access_token = ?, encrypted_refresh_token = ?, status = 'connected', token_expires_at = 9999999999").bind(winningAccess, winningRefresh).run()
      return Response.json({ error: { code: 'access_token_invalid' } }, { status: 401 })
    }))
    try {
      expect(await processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2000 })).toEqual({ status: 'needs_reauth' })
      expect(await getConnection(db, 'conn_1', PUBKEY_A)).toMatchObject({ status: winner === 'none' ? 'needs_reauth' : winner === 'disconnect' ? 'disconnected' : 'connected', ...(winner === 'refresh' || winner === 'reconnect' ? { encryptedAccessToken: winningAccess, encryptedRefreshToken: winningRefresh } : {}) })
      if (stage === 'status') expect(await getJob(db, 'job_1')).toMatchObject({ externalPostId: 'accepted-original' })
    } finally { vi.unstubAllGlobals() }
  })
})

// ABOUTME: Exercises Snapchat ownership, immutable choices and durable publication.
// ABOUTME: Uses real D1 and synthetic provider responses without live posts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations, connection, PUBKEY_A, PUBKEY_B, VIDEO_EVENT_ID, job } from '../db/test-helpers'
import { upsertConnection, getConnection } from '../db/connections'
import { createOrGetJob, getJob, recoverStaleXClaims, updateJobStatus } from '../db/jobs'
import { getPreferences, setPreference } from '../db/preferences'
import { createManualCrossposts, createAutomaticCrossposts } from './crossposts'
import { processCrosspostJob } from './publisher'
import { getAdapter, getProviderSummaries } from '../platforms/registry'
import { encryptToken } from '../utils/crypto'
import { SOURCE_METADATA_CASES } from '../funnelcake/source-metadata.test-helpers'
import type { Env } from '../types'
const profile = '11111111-1111-4111-8111-111111111111'
const media = '22222222-2222-4222-8222-222222222222'
const key = '0123456789abcdef0123456789abcdef'
let db: D1Database; let env: Env; let send: ReturnType<typeof vi.fn>
beforeEach(async () => {
  db = await applyMigrations(); send = vi.fn()
  env = { DB: db, CACHE_KV: {} as KVNamespace, CROSSPOST_QUEUE: { send } as unknown as Env['CROSSPOST_QUEUE'], KEYCAST_URL: 'https://login.divine.video', FUNNELCAKE_URL: 'https://api.divine.video', OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video', TOKEN_ENCRYPTION_KEY: key, ENABLE_SNAPCHAT: 'true', SNAPCHAT_CLIENT_ID: 'client', SNAPCHAT_CLIENT_SECRET: 'secret', SNAPCHAT_PUBLIC_PROFILE_APPROVED: 'true' }
  await upsertConnection(db, connection({ platform: 'snapchat', externalAccountId: profile, tokenExpiresAt: null, encryptedAccessToken: await encryptToken('access', key), metadataJson: JSON.stringify({ account: { profileConfirmed: true } }) }))
})
afterEach(() => vi.unstubAllGlobals())
function source(tags = SOURCE_METADATA_CASES[0].tags) { return { id: VIDEO_EVENT_ID, pubkey: PUBKEY_A, kind: 34236, created_at: 2000, content: 'Human caption', tags, sig: 'f'.repeat(128) } }
function pref(destination: 'story' | 'spotlight', mode: 'automatic' | 'manual' = 'manual') { return { pubkey: PUBKEY_A, platform: 'snapchat' as const, connectionId: 'conn_1', mode, snapchatDestination: destination, automaticEnabledAt: mode === 'automatic' ? 1000 : null, createdAt: 1000, updatedAt: 1000 } }
describe('Snapchat choices', () => {
  it('requires credentials, enablement and explicit Public Profile approval', () => {
    expect(getAdapter({ ...env, SNAPCHAT_PUBLIC_PROFILE_APPROVED: undefined }, 'snapchat')).toBeNull()
    expect(getAdapter({ ...env, ENABLE_SNAPCHAT: 'false' }, 'snapchat')).toBeNull()
    expect(getAdapter(env, 'snapchat')?.platform).toBe('snapchat')
    expect(getProviderSummaries({ ...env, SNAPCHAT_PUBLIC_PROFILE_APPROVED: undefined }).find(p => p.platform === 'snapchat')).toMatchObject({ enabled: false, readinessReason: 'public_profile_access_pending' })
  })
  it('freezes manual destination and duplicate keeps original choices', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(source())))
    await setPreference(db, pref('spotlight'))
    const first = await createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['snapchat'], snapchatProfile: { connectionId: 'conn_1', profileId: profile }, snapchatDestination: 'story' })
    await setPreference(db, pref('spotlight'))
    const second = await createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['snapchat'], snapchatProfile: { connectionId: 'conn_1', profileId: profile }, snapchatDestination: 'spotlight' })
    expect(first.jobs[0]).toMatchObject({ snapchatDestination: 'story', sourceMedia: { durationSeconds: 6, width: 1080, height: 1920 } })
    expect(second.jobs[0].id).toBe(first.jobs[0].id); expect(second.jobs[0].snapchatDestination).toBe('story'); expect(send).toHaveBeenCalledTimes(1)
    expect((await getPreferences(db, PUBKEY_A))[0].snapchatDestination).toBe('spotlight')
  })
  it.each(SOURCE_METADATA_CASES.filter(c => c.tags.some(t => t.some(v => v.includes('dim')))))('accepts authoritative $name metadata', async item => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(source(item.tags))))
    const result = await createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['snapchat'], snapchatProfile: { connectionId: 'conn_1', profileId: profile } })
    expect(result.jobs[0]).toMatchObject({ sourceMediaUrl: item.url, sourceMedia: { durationSeconds: 6, width: 1080, height: 1920 }, snapchatDestination: 'spotlight' })
  })
  it('does not borrow dimensions from a different source descriptor', async () => {
    const tags = [['imeta', 'url https://media.divine.video/a.mp4', 'x a', 'duration 6'], ['imeta', 'url https://media.divine.video/b.mp4', 'x b', 'duration 6', 'dim 1080x1920']]
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(source(tags))))
    await expect(createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['snapchat'], snapchatProfile: { connectionId: 'conn_1', profileId: profile } })).rejects.toMatchObject({ code: 'not_eligible' })
  })
  it('requires confirmed profile and source ownership', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(source())))
    await expect(createManualCrossposts(env, { pubkey: PUBKEY_B, eventId: VIDEO_EVENT_ID, platforms: ['snapchat'], snapchatProfile: { connectionId: 'conn_1', profileId: profile } })).rejects.toBeInstanceOf(Error)
    await db.prepare("UPDATE connections SET metadata_json = '{}' WHERE id = 'conn_1'").run()
    await expect(createManualCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID, platforms: ['snapchat'], snapchatProfile: { connectionId: 'conn_1', profileId: profile } })).rejects.toMatchObject({ code: 'not_eligible' })
  })
  it('automatic is explicit and uses saved destination', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(source())))
    expect((await createAutomaticCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID })).jobs).toEqual([])
    await setPreference(db, pref('story', 'automatic'))
    expect((await createAutomaticCrossposts(env, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID })).jobs[0].snapchatDestination).toBe('story')
  })
})
describe('Snapchat durable publisher', () => {
  it('resumes finalized media after a transient poll failure without uploading again and never reports SUBMITTED as posted', async () => {
    let creates = 0; let posts = 0; let failPoll = true
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url)
      if (u.includes('cdn.divine.video')) return new Response('video', { headers: { 'content-type': 'video/mp4' } })
      if (u.endsWith('/media')) { creates++; return Response.json({ request_status: 'SUCCESS', media_id: media, add_path: `/us/v1/public_profiles/${profile}/media/${media}/multipart-upload`, finalize_path: `/us/v1/public_profiles/${profile}/media/${media}/multipart-upload` }) }
      if (u.endsWith('/spotlights')) { posts++; return Response.json({ request_status: 'SUCCESS', spotlight_id: 'synthetic_spotlight' }) }
      if (u.endsWith('/synthetic_spotlight')) { if (failPoll) { failPoll = false; throw Error('network') }; return Response.json({ request_status: 'SUCCESS', spotlights: [{ sub_request_status: 'SUCCESS', spotlight: { id: 'synthetic_spotlight', profile_id: profile, status: 'LIVE' } }] }) }
      return Response.json({ request_status: 'SUCCESS' })
    }))
    await createOrGetJob(db, job({ platform: 'snapchat', externalAccountId: profile, snapchatDestination: 'spotlight', sourceMedia: { durationSeconds: 6, width: 540, height: 960 } }))
    expect((await processCrosspostJob(env, 'job_1', { now: 2000 })).status).toBe('processing')
    expect((await processCrosspostJob(env, 'job_1', { now: 2100 })).status).toBe('processing')
    await expect(processCrosspostJob(env, 'job_1', { now: 2500 })).rejects.toMatchObject({ retryDelaySeconds: 300 })
    expect((await processCrosspostJob(env, 'job_1', { now: 4000 })).status).toBe('posted')
    expect(creates).toBe(1); expect(posts).toBe(1)
  })
  it('recovers abandoned dispatch without retry or a second publication', async () => {
    await createOrGetJob(db, job({ platform: 'snapchat', status: 'dispatching', externalAccountId: profile }))
    await recoverStaleXClaims(db, 2000, 60)
    expect(await getJob(db, 'job_1')).toMatchObject({ status: 'failed', errorCode: 'ambiguous_post_result', nextRetryAt: null })
  })
})

describe('Snapchat interruption safety', () => {
  it('stores the post checkpoint before clearing the dispatch fence', async () => {
    await createOrGetJob(db, job({ platform: 'snapchat', externalAccountId: profile, status: 'processing' }))
    const { recordAttempt } = await import('../db/attempts')
    const checkpoint = { stage: 'media_ready', profileId: profile, mediaId: media, sourceLink: 'https://divine.video/video/' + VIDEO_EVENT_ID, destination: 'spotlight', caption: 'Human', mediaCreatedAt: String(Date.now()) }
    await recordAttempt(db, { id: 'attempt_ready', jobId: 'job_1', status: 'processing', errorCode: null, errorMessage: null, providerStatus: null, providerResponseJson: JSON.stringify(checkpoint), createdAt: 1500 })
    const observed: string[] = []
    const dbProxy = new Proxy(db, { get(target, property) {
      if (property === 'prepare') return (sql: string) => { if (sql.includes('INSERT INTO job_attempts')) observed.push('checkpoint'); if (sql.startsWith('UPDATE jobs')) observed.push('state'); return target.prepare(sql) }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
    vi.stubGlobal('fetch', vi.fn(async () => { observed.length = 0; return Response.json({ request_status: 'SUCCESS', spotlight_id: 'synthetic_spotlight' }) }))
    await processCrosspostJob({ ...env, DB: dbProxy }, 'job_1', { now: 2000, fenceNow: 2000 })
    expect(observed[0]).toBe('checkpoint')
  })
  it('resumes known media from a recovered failed upload claim and fences ambiguous dispatch permanently', async () => {
    await createOrGetJob(db, job({ platform: 'snapchat', externalAccountId: profile, status: 'failed', nextRetryAt: 1500 }))
    const { recordAttempt } = await import('../db/attempts')
    await recordAttempt(db, { id: 'attempt_ready', jobId: 'job_1', status: 'processing', errorCode: null, errorMessage: null, providerStatus: null, providerResponseJson: JSON.stringify({ stage: 'media_ready', profileId: profile, mediaId: media, sourceLink: 'https://divine.video/video/' + VIDEO_EVENT_ID, destination: 'story', caption: 'Human', mediaCreatedAt: String(Date.now()) }), createdAt: 1500 })
    let posts = 0
    vi.stubGlobal('fetch', vi.fn(async url => { expect(String(url)).toContain('/stories'); posts++; throw new Error('response lost') }))
    expect((await processCrosspostJob(env, 'job_1', { now: 2000, fenceNow: 2000 })).status).toBe('failed')
    expect(await getJob(db, 'job_1')).toMatchObject({ errorCode: 'ambiguous_post_result', nextRetryAt: null })
    await processCrosspostJob(env, 'job_1', { now: 3000 }); expect(posts).toBe(1)
  })
  it('does not use an old job after public-profile reselection', async () => {
    await createOrGetJob(db, job({ platform: 'snapchat', externalAccountId: media }))
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream)
    expect((await processCrosspostJob(env, 'job_1', { now: 2000 })).status).toBe('needs_reauth')
    expect((await getConnection(db, 'conn_1', PUBKEY_A))!.status).toBe('connected'); expect(upstream).not.toHaveBeenCalled()
  })
})

it('treats a definite publishing permission denial as reconnection, without automatic replay', async () => {
  await createOrGetJob(db, job({ platform: 'snapchat', externalAccountId: profile, status: 'processing' }))
  const { recordAttempt } = await import('../db/attempts')
  await recordAttempt(db, { id: 'ready', jobId: 'job_1', status: 'processing', errorCode: null, errorMessage: null, providerStatus: null, providerResponseJson: JSON.stringify({ stage: 'media_ready', profileId: profile, mediaId: media, destination: 'story', sourceLink: 'https://divine.video/video/' + VIDEO_EVENT_ID, mediaCreatedAt: String(Date.now()) }), createdAt: 1500 })
  const upstream = vi.fn(async () => Response.json({ request_status: 'ERROR', error_code: 'AUTHORIZATION_PERMISSION_DENIED' }, { status: 403 })); vi.stubGlobal('fetch', upstream)
  expect((await processCrosspostJob(env, 'job_1', { now: 2000, fenceNow: 2000 })).status).toBe('needs_reauth')
  expect((await getConnection(db, 'conn_1', PUBKEY_A))!.status).toBe('needs_reauth')
  await processCrosspostJob(env, 'job_1', { now: 3000 }); expect(upstream).toHaveBeenCalledOnce()
})

it('records automatic Snapchat ineligibility without blocking another opted-in provider', async () => {
  await setPreference(db, pref('spotlight', 'automatic'))
  await upsertConnection(db, connection({ id: 'conn_x', platform: 'x', externalAccountId: 'synthetic_x' }))
  await setPreference(db, { pubkey: PUBKEY_A, platform: 'x', connectionId: 'conn_x', mode: 'automatic', automaticEnabledAt: 1000, createdAt: 1000, updatedAt: 1000 })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(source(SOURCE_METADATA_CASES[2].tags))))
  const result = await createAutomaticCrossposts({ ...env, ENABLE_X: 'true', TWITTER_CLIENT_ID: 'client', TWITTER_CLIENT_SECRET: 'secret' }, { pubkey: PUBKEY_A, eventId: VIDEO_EVENT_ID })
  expect(result.jobs.find(j => j.platform === 'snapchat')).toMatchObject({ status: 'failed', errorCode: 'not_eligible', nextRetryAt: null })
  expect(result.jobs.find(j => j.platform === 'x')).toMatchObject({ status: 'queued' }); expect(send).toHaveBeenCalledOnce()
})

it('prevents publication when an already-started profile selection wins during publisher token refresh', async () => {
  const { confirmSnapchatProfile } = await import('./snapchat-profiles')
  const { recordAttempt } = await import('../db/attempts')
  const now = Math.floor(Date.now() / 1000)
  await db.prepare("UPDATE connections SET token_expires_at = ?, encrypted_refresh_token = ? WHERE id = 'conn_1'")
    .bind(now + 3600, await encryptToken('refresh', key)).run()
  const before = (await getConnection(db, 'conn_1', PUBKEY_A))!
  await createOrGetJob(db, job({ platform: 'snapchat', externalAccountId: profile, status: 'processing', expiresAt: now + 86400 }))
  await recordAttempt(db, { id: 'ready-race', jobId: 'job_1', status: 'processing', errorCode: null, errorMessage: null, providerStatus: null,
    providerResponseJson: JSON.stringify({ stage: 'media_ready', profileId: profile, mediaId: media, destination: 'story', sourceLink: 'https://divine.video/video/' + VIDEO_EVENT_ID, mediaCreatedAt: String(Date.now()) }), createdAt: now - 1 })
  let announceDiscovery!: () => void
  const discoveryStarted = new Promise<void>(resolve => { announceDiscovery = resolve })
  let releaseDiscovery!: () => void
  const discoveryRelease = new Promise<void>(resolve => { releaseDiscovery = resolve })
  let selection!: Promise<unknown>
  let publications = 0
  vi.stubGlobal('fetch', vi.fn(async url => {
    const endpoint = String(url)
    if (endpoint.endsWith('/my_profile')) {
      announceDiscovery(); await discoveryRelease
      return Response.json({ request_status: 'SUCCESS', public_profile: { id: profile, organization_id: media, snap_user_name: 'first' } })
    }
    if (endpoint.includes('/organizations/')) return Response.json({ request_status: 'SUCCESS', public_profiles: [{ sub_request_status: 'SUCCESS', public_profile: { id: media, snap_user_name: 'second' } }] })
    if (endpoint.endsWith('/access_token')) {
      releaseDiscovery(); await selection
      return Response.json({ access_token: 'losing-refresh', refresh_token: 'losing-refresh-token', expires_in: 3600 })
    }
    if (endpoint.endsWith('/stories')) { publications++; return Response.json({ request_status: 'SUCCESS' }) }
    throw Error('Unexpected endpoint ' + endpoint)
  }))
  selection = confirmSnapchatProfile(env, PUBKEY_A, 'conn_1', { profileId: media, confirmed: true })
  await discoveryStarted
  // Selection has already obtained its token and waits on provider discovery;
  // the publisher now encounters a token requiring refresh.
  await db.prepare("UPDATE connections SET token_expires_at = 1 WHERE id = 'conn_1'").run()
  const result = await processCrosspostJob(env, 'job_1', { now, fenceNow: now })
  expect(result.status).toBe('needs_reauth')
  expect(publications).toBe(0)
  const winner = (await getConnection(db, 'conn_1', PUBKEY_A))!
  expect(winner).toMatchObject({ status: 'connected', externalAccountId: media, encryptedAccessToken: before.encryptedAccessToken })
})

it.each(['profile', 'confirmation', 'revision', 'token'] as const)(
  'atomically rejects a %s change after token acquisition and before publication', async change => {
    const { recordAttempt } = await import('../db/attempts')
    await createOrGetJob(db, job({ platform: 'snapchat', externalAccountId: profile, status: 'processing' }))
    await recordAttempt(db, { id: 'ready-fence', jobId: 'job_1', status: 'processing', errorCode: null, errorMessage: null, providerStatus: null,
      providerResponseJson: JSON.stringify({ stage: 'media_ready', profileId: profile, mediaId: media, destination: 'story', sourceLink: 'https://divine.video/video/' + VIDEO_EVENT_ID, mediaCreatedAt: String(Date.now()) }), createdAt: 1500 })
    let changed = false
    const dbProxy = new Proxy(db, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql)
        if (!sql.startsWith('SELECT * FROM job_attempts')) return statement
        return new Proxy(statement, { get(statementTarget, method) {
          if (method === 'bind') return (...values: unknown[]) => {
            const bound = statementTarget.bind(...values)
            return new Proxy(bound, { get(boundTarget, boundMethod) {
              if (boundMethod === 'all') return async () => {
                if (!changed) {
                  changed = true
                  if (change === 'profile') await db.prepare("UPDATE connections SET external_account_id = ? WHERE id = 'conn_1'").bind(media).run()
                  if (change === 'token') await db.prepare("UPDATE connections SET encrypted_access_token = ? WHERE id = 'conn_1'").bind(await encryptToken('reconnected', key)).run()
                  if (change === 'confirmation' || change === 'revision') await db.prepare("UPDATE connections SET metadata_json = ? WHERE id = 'conn_1'")
                    .bind(JSON.stringify({ account: { profileConfirmed: change !== 'confirmation', selectionRevision: 'winner' } })).run()
                }
                return boundTarget.all()
              }
              const value = Reflect.get(boundTarget, boundMethod)
              return typeof value === 'function' ? value.bind(boundTarget) : value
            } })
          }
          const value = Reflect.get(statementTarget, method)
          return typeof value === 'function' ? value.bind(statementTarget) : value
        } })
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const upstream = vi.fn(async () => Response.json({ request_status: 'SUCCESS' }))
    vi.stubGlobal('fetch', upstream)
    expect((await processCrosspostJob({ ...env, DB: dbProxy }, 'job_1', { now: 2000, fenceNow: 2000 })).status).toBe('needs_reauth')
    expect(changed).toBe(true)
    expect(upstream).not.toHaveBeenCalled()
    expect((await getConnection(db, 'conn_1', PUBKEY_A))!.status).toBe('connected')
  },
)

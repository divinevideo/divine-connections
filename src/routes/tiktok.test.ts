// ABOUTME: Exercises TikTok consent, ownership and source validation through real routes.
// ABOUTME: Keeps database, encryption and publisher real while stubbing provider HTTP.
import { env as workerEnv } from 'cloudflare:test'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import { SOURCE_METADATA_CASES } from '../funnelcake/source-metadata.test-helpers'
import { applyMigrations, connection, PUBKEY_A, PUBKEY_B, VIDEO_EVENT_ID } from '../db/test-helpers'
import { upsertConnection, getConnection } from '../db/connections'
import { getJob } from '../db/jobs'
import { setPreference, listAutomaticPreferences } from '../db/preferences'
import { encryptToken } from '../utils/crypto'
import { recentDiagnostics } from '../services/reliability'
import { processCrosspostJob } from '../services/publisher'
import type { Env } from '../types'

const creator = { creator_username: 'synthetic.creator', creator_nickname: 'Synthetic Creator', privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 60 }
const options = (caption = 'edited without attribution') => ({ privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, brandOrganic: false, brandContent: false, commercialContent: false, confirmedCaption: caption, musicUsageConfirmed: true, brandedContentConfirmed: false, creatorInfo: creator, connectionId: 'conn_tiktok' })
describe('TikTok manual confirmation', () => {
  let env: Env
  let source: Record<string, unknown>
  let currentCreator: typeof creator
  let fetchMock: ReturnType<typeof vi.fn>
  let queueSend: ReturnType<typeof vi.fn>
  let upstreamRequests: { url: string; body: any; authorization: string | null }[]
  const request = (path: string, body?: unknown, host = 'crossposter.divine.video') => worker.fetch(new Request('https://' + host + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer synthetic-keycast', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, {} as ExecutionContext)
  const submit = (postOptions: unknown = options()) => request('/videos/' + VIDEO_EVENT_ID + '/crossposts', { platforms: ['tiktok'], tiktokPostOptions: postOptions })
  beforeEach(async () => {
    const db = await applyMigrations()
    queueSend = vi.fn()
    env = { ...workerEnv, DB: db, CROSSPOST_QUEUE: { send: queueSend }, KEYCAST_URL: 'https://login.divine.video', FUNNELCAKE_URL: 'https://api.divine.video', OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video', TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef', ENABLE_TIKTOK: 'true', TIKTOK_CLIENT_KEY: 'synthetic-client', TIKTOK_CLIENT_SECRET: 'synthetic-secret' } as unknown as Env
    await upsertConnection(db, connection({ id: 'conn_tiktok', encryptedAccessToken: await encryptToken('synthetic-access', env.TOKEN_ENCRYPTION_KEY), encryptedRefreshToken: await encryptToken('synthetic-refresh', env.TOKEN_ENCRYPTION_KEY), tokenExpiresAt: 9999999999 }))
    currentCreator = { ...creator }
    source = { id: VIDEO_EVENT_ID, pubkey: PUBKEY_A, kind: 34236, created_at: 2000, content: 'Original Divine text', tags: [['imeta', 'url https://media.divine.video/synthetic.mp4', 'x synthetic-hash', 'duration 6']], sig: 'f'.repeat(128) }
    upstreamRequests = []
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://login.divine.video/api/nostr') return Response.json({ result: PUBKEY_A })
      if (url === 'https://api.divine.video/api/videos/' + VIDEO_EVENT_ID) return Response.json({ event: source })
      upstreamRequests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, authorization: new Headers(init?.headers).get('authorization') })
      if (String(url).includes('creator_info')) return Response.json({ data: currentCreator, error: { code: 'ok' } })
      if (String(url).includes('video/init')) return Response.json({ data: { publish_id: 'synthetic-publish' }, error: { code: 'ok' } })
      if (String(url).includes('status/fetch')) return Response.json({ data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } })
      return Response.json({}, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())
  it('fetches only the caller connection, returns safe fresh info, and isolates verifier hosts', async () => {
    for (const host of ['verify.divine.video', 'verifier.divine.video']) expect((await request('/connections/tiktok/creator-info', undefined, host)).status).toBe(404)
    const res = await request('/connections/tiktok/creator-info')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ creatorInfo: creator, connectionId: 'conn_tiktok' })
    currentCreator = { ...creator, comment_disabled: true }
    expect(await (await request('/connections/tiktok/creator-info')).json()).toMatchObject({ creatorInfo: { comment_disabled: true } })
    await env.DB.prepare('UPDATE connections SET pubkey = ?').bind(PUBKEY_B).run()
    expect((await request('/connections/tiktok/creator-info')).status).toBe(400)
  })
  it('previews validated source text without creating jobs or sending media', async () => {
    const res = await request('/videos/' + VIDEO_EVENT_ID + '/tiktok-preview')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ caption: 'Original Divine text', durationSeconds: 6, mediaUrl: 'https://media.divine.video/synthetic.mp4' })
    expect(queueSend).not.toHaveBeenCalled()
    expect(upstreamRequests).toEqual([])
    source.pubkey = PUBKEY_B
    expect((await request('/videos/' + VIDEO_EVENT_ID + '/tiktok-preview')).status).toBe(403)
  })
  it.each([undefined, {}, { ...options(), privacyLevel: '' }, { ...options(), allowDuet: true }, { ...options(), musicUsageConfirmed: false }, { ...options(), commercialContent: true }, { ...options(), brandContent: true }, { ...options(), commercialContent: true, brandContent: true, brandedContentConfirmed: true, privacyLevel: 'SELF_ONLY' }, { ...options(), confirmedCaption: 'x'.repeat(2201) }, { ...options(), connectionId: 'someone-else' }])('rejects invalid or missing confirmation %j', async (value) => {
    const res = await request('/videos/' + VIDEO_EVENT_ID + '/crossposts', { platforms: ['tiktok'], ...(value === undefined ? {} : { tiktokPostOptions: value }) })
    expect(res.status).toBe(400)
    expect(queueSend).not.toHaveBeenCalled()
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM jobs').first<{count:number}>())?.count).toBe(0)
  })
  it('requires fresh confirmation if provider restrictions change', async () => {
    currentCreator = { ...creator, max_video_post_duration_sec: 30 }
    const res = await submit()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'tiktok_confirmation_changed' } })
    expect(queueSend).not.toHaveBeenCalled()
  })
  it.each([[], [['duration', 'NaN']], [['duration', '-1']], [['duration', '61']], [['duration', 'Infinity']]].map(tags => ({ tags })))('fails duration eligibility from source metadata $tags despite client duration', async ({ tags }) => {
    source.tags = [['url', 'https://media.divine.video/synthetic.mp4'], ['x', 'synthetic-hash'], ...tags]
    const res = await submit({ ...options(), durationSeconds: 1 })
    expect(res.status).toBe(400)
    expect(queueSend).not.toHaveBeenCalled()
  })
  it.each(['edited without attribution', '', '  keep spaces 🎉  '])('snapshots and publishes exact confirmed text %j; duplicate preserves original choices', async (caption) => {
    const res = await submit(options(caption))
    expect(res.status).toBe(200)
    const { jobs } = await res.json() as any
    expect(jobs[0]).toMatchObject({ caption, tiktokPostOptions: { confirmedCaption: caption, privacyLevel: 'PUBLIC_TO_EVERYONE', durationSeconds: 6 } })
    const duplicate = await submit({ ...options('mutated'), privacyLevel: 'SELF_ONLY', allowComment: false })
    expect(await duplicate.json()).toMatchObject({ jobs: [{ id: jobs[0].id, caption, tiktokPostOptions: { privacyLevel: 'PUBLIC_TO_EVERYONE' } }] })
    expect(queueSend).toHaveBeenCalledTimes(1)
    await processCrosspostJob(env, jobs[0].id)
    expect(upstreamRequests.find(r => r.url.includes('video/init'))?.body).toEqual({ post_info: { title: caption, privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, disable_duet: true, disable_stitch: true, brand_organic_toggle: false, brand_content_toggle: false }, source_info: { source: 'PULL_FROM_URL', video_url: 'https://media.divine.video/synthetic.mp4' } })
    expect((await getJob(env.DB, jobs[0].id))?.status).toBe('processing')
  })
  it('rejects automatic preferences and excludes saved legacy automatic preferences', async () => {
    const response = await worker.fetch(new Request('https://crossposter.divine.video/preferences/tiktok', { method: 'PUT', headers: { authorization: 'Bearer synthetic-keycast', 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'automatic' }) }), env, {} as ExecutionContext)
    expect(response.status).toBe(400)
    await setPreference(env.DB, { pubkey: PUBKEY_A, platform: 'tiktok', connectionId: 'conn_tiktok', mode: 'automatic', automaticEnabledAt: 1000, createdAt: 1000, updatedAt: 1000 })
    expect(await listAutomaticPreferences(env.DB, 10, 0)).toEqual([])
    expect(await (await request('/videos/' + VIDEO_EVENT_ID + '/auto-crosspost', {})).json()).toEqual({ jobs: [] })
  })
  it('refreshes expired tokens before fetching creator info and does not expose tokens', async () => {
    await env.DB.prepare('UPDATE connections SET token_expires_at = 1').run()
    fetchMock.mockImplementationOnce(async () => Response.json({ result: PUBKEY_A }))
    fetchMock.mockImplementationOnce(async () => Response.json({ access_token: 'fresh-synthetic-access', refresh_token: 'fresh-synthetic-refresh', expires_in: 3600, scope: 'video.publish' }))
    const res = await request('/connections/tiktok/creator-info')
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('synthetic-access')
    expect(upstreamRequests[0]?.authorization).toBe('Bearer fresh-synthetic-access')
    expect((await getConnection(env.DB, 'conn_tiktok', PUBKEY_A))?.lastRefreshAt).not.toBeNull()
    expect(await recentDiagnostics(env.DB, 'conn_tiktok')).toEqual([expect.objectContaining({ operation: 'refresh', stage: 'token_refresh', outcome: 'succeeded' })])
  })
  it('marks refresh rejection needs_reauth without sending stale token to creator API', async () => {
    await env.DB.prepare('UPDATE connections SET token_expires_at = 1').run()
    fetchMock.mockImplementationOnce(async () => Response.json({ result: PUBKEY_A }))
    fetchMock.mockImplementationOnce(async () => Response.json({ error: { code: 'access_token_invalid' } }, { status: 401 }))
    const res = await request('/connections/tiktok/creator-info')
    expect(res.status).toBe(401)
    expect((await getConnection(env.DB, 'conn_tiktok', PUBKEY_A))?.status).toBe('needs_reauth')
    expect(await recentDiagnostics(env.DB, 'conn_tiktok')).toEqual([expect.objectContaining({ operation: 'refresh', stage: 'token_refresh', outcome: 'failed' })])
    expect(upstreamRequests).toEqual([])
  })
  it('requires confirmation again after a different TikTok account is connected', async () => {
    expect((await request('/connections/tiktok/creator-info')).status).toBe(200)
    await env.DB.prepare("UPDATE connections SET status = 'disconnected'").run()
    await upsertConnection(env.DB, connection({ id: 'conn_replacement', externalAccountId: 'synthetic-new-account', encryptedAccessToken: await encryptToken('replacement-access', env.TOKEN_ENCRYPTION_KEY), tokenExpiresAt: 9999999999 }))
    expect((await submit()).status).toBe(400)
    expect(queueSend).not.toHaveBeenCalled()
    expect(upstreamRequests.some(item => item.url.includes('video/init'))).toBe(false)
  })
  it('does not resurrect a disconnected connection when refresh finishes late', async () => {
    await env.DB.prepare('UPDATE connections SET token_expires_at = 1').run()
    fetchMock.mockImplementationOnce(async () => Response.json({ result: PUBKEY_A }))
    fetchMock.mockImplementationOnce(async () => {
      await env.DB.prepare("UPDATE connections SET status = 'disconnected'").run()
      return Response.json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 })
    })
    expect((await request('/connections/tiktok/creator-info')).status).toBe(401)
    expect((await getConnection(env.DB, 'conn_tiktok', PUBKEY_A))?.status).toBe('disconnected')
    expect(upstreamRequests).toEqual([])
  })
  it('returns provider HTTP-200 denial as unavailable and never initializes media', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ result: PUBKEY_A }))
    fetchMock.mockImplementationOnce(async () => Response.json({ error: { code: 'spam_risk_user_banned_from_posting' } }))
    expect((await request('/connections/tiktok/creator-info')).status).toBe(503)
    expect(queueSend).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'missing selected duration', tags: [['imeta', 'url https://media.divine.video/long.mp4', 'x long-hash'], ['imeta', 'url https://media.divine.video/short.mp4', 'x short-hash', 'duration 6']] },
    { name: 'selected duration over limit', tags: [['imeta', 'url https://media.divine.video/long.mp4', 'x long-hash', 'duration 120'], ['imeta', 'url https://media.divine.video/short.mp4', 'x short-hash', 'duration 6']] },
    { name: 'ambiguous duration for selected URL', tags: [['imeta', 'url https://media.divine.video/long.mp4', 'x long-hash', 'duration 6'], ['imeta', 'url https://media.divine.video/long.mp4', 'x long-hash', 'duration 120']] },
    { name: 'conflicting durations inside selected descriptor', tags: [['imeta', 'url https://media.divine.video/long.mp4', 'x long-hash', 'duration 6', 'duration 120']] },
    { name: 'ambiguous legacy media URL', tags: [['url', 'https://media.divine.video/long.mp4'], ['media', 'https://media.divine.video/short.mp4'], ['x', 'legacy-hash'], ['duration', '6']] },
    { name: 'another rendition hash cannot fill selected hash', tags: [['imeta', 'url https://media.divine.video/long.mp4', 'duration 6'], ['imeta', 'url https://media.divine.video/short.mp4', 'x short-hash', 'duration 6']] },
    { name: 'top-level duration cannot qualify distinct descriptors', tags: [['imeta', 'url https://media.divine.video/long.mp4', 'x long-hash'], ['imeta', 'url https://media.divine.video/short.mp4', 'x short-hash'], ['duration', '6']] },
    { name: 'conflicting event and selected descriptor duration', tags: [['imeta', 'url https://media.divine.video/long.mp4', 'x long-hash', 'duration 6'], ['duration', '120']] },
    { name: 'legacy event duration with a distinct unresolved descriptor', tags: [['imeta', 'url https://example.com/other.mp4', 'x other-hash'], ['url', 'https://media.divine.video/legacy.mp4'], ['x', 'legacy-hash'], ['duration', '6']] },
    { name: 'conflicting event duration values', tags: [['imeta', 'url https://media.divine.video/long.mp4', 'x long-hash'], ['duration', '6'], ['duration', '120']] },
  ])('rejects $name without borrowing another rendition metadata', async ({ tags }) => {
    source.tags = tags
    expect((await submit()).status).toBe(400)
    expect(queueSend).not.toHaveBeenCalled()
  })
  it('takes selected URL, hash and duration together when an earlier rendition is not usable', async () => {
    source.tags = [['imeta', 'url https://example.com/short.mp4', 'x wrong-hash', 'duration 1'], ['imeta', 'url https://media.divine.video/selected.mp4', 'x selected-hash', 'duration 12']]
    const response = await submit()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ jobs: [{ sourceMediaUrl: 'https://media.divine.video/selected.mp4', sourceMediaHash: 'selected-hash', tiktokPostOptions: { durationSeconds: 12 } }] })
  })
  it('supports unambiguous legacy top-level media metadata without an imeta source', async () => {
    source.tags = [['url', 'https://media.divine.video/legacy.mp4'], ['x', 'legacy-hash'], ['duration', '6']]
    const response = await submit()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ jobs: [{ sourceMediaUrl: 'https://media.divine.video/legacy.mp4', sourceMediaHash: 'legacy-hash', tiktokPostOptions: { durationSeconds: 6 } }] })
  })
  it.each(['creator_info', 'confirmation_creator_info'])('records safe durable %s provider denial with an unexpired token', async (stage) => {
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => String(url).includes('creator_info')
      ? Response.json({ data: { creator_nickname: 'creator-sensitive-sentinel' }, error: { code: 'rate_limit_exceeded', message: 'caption-sensitive-sentinel token-sensitive-sentinel' }, access_token: 'token-sensitive-sentinel' }, { status: 429 })
      : fallback(url, init))
    const response = stage === 'creator_info' ? await request('/connections/tiktok/creator-info') : await submit()
    expect(response.status).toBe(429)
    const rows = await recentDiagnostics(env.DB, 'conn_tiktok')
    expect(rows).toEqual([expect.objectContaining({ operation: 'publish', stage, outcome: 'failed', provider_status: 429, diagnostic: { endpoint: '/v2/post/publish/creator_info/query/', type: 'rate_limited' } })])
    expect(JSON.stringify(rows)).not.toMatch(/creator-sensitive-sentinel|caption-sensitive-sentinel|token-sensitive-sentinel/)
    expect(queueSend).not.toHaveBeenCalled()
  })
  it('does not record invalid choices or changed confirmation as provider outages', async () => {
    expect((await submit({ ...options(), allowDuet: true })).status).toBe(400)
    currentCreator = { ...creator, max_video_post_duration_sec: 30 }
    expect((await submit()).status).toBe(409)
    expect(await recentDiagnostics(env.DB, 'conn_tiktok')).toEqual([])
  })

  it.each(SOURCE_METADATA_CASES)('previews and manually queues $name', async ({ tags, url, hash }) => {
    source.tags = tags
    const preview = await request('/videos/' + VIDEO_EVENT_ID + '/tiktok-preview')
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ mediaUrl: url, durationSeconds: 6 })
    const response = await submit()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ jobs: [{ sourceMediaUrl: url, sourceMediaHash: hash, tiktokPostOptions: { durationSeconds: 6 } }] })
    expect(queueSend).toHaveBeenCalledOnce()
  })

})

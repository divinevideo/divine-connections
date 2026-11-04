// ABOUTME: Tests Snapchat's documented Public Profile publishing contract.
// ABOUTME: Synthetic upstream responses exercise encryption, ownership and safe checkpoints.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapchatAdapter, fetchSnapchatProfiles, SNAPCHAT_MAX_BYTES } from './snapchat'
const adapter = createSnapchatAdapter({ clientId: 'client', clientSecret: 'secret' })
const profile = '11111111-1111-4111-8111-111111111111'
const media = '22222222-2222-4222-8222-222222222222'
const base = 'https://businessapi.snapchat.com'
const path = `/us/v1/public_profiles/${profile}/media/${media}/multipart-upload`
const link = 'https://divine.video/video/' + 'a'.repeat(64)
const input = { accessToken: 'access', externalAccountId: profile, videoUrl: 'https://media.divine.video/clip.mp4', mediaHash: 'b'.repeat(64), caption: 'Human caption', snapchatDestination: 'spotlight' as const, sourceMedia: { durationSeconds: 6, width: 540, height: 960 }, canonicalSourceUrl: link }
const ok = (body = {}) => Response.json({ request_status: 'SUCCESS', ...body })
afterEach(() => vi.unstubAllGlobals())

describe('Snapchat Public Profile connection', () => {
  it('uses profile scope and canonical OAuth code and refresh endpoints', async () => {
    const auth = new URL(adapter.buildAuthorizationUrl({ state: 'state', redirectUri: 'https://example.test/callback' }))
    expect(auth.origin + auth.pathname).toBe('https://accounts.snapchat.com/login/oauth2/authorize')
    expect(auth.searchParams.get('scope')).toBe('snapchat-profile-api')
    expect(auth.searchParams.get('state')).toBe('state')
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://accounts.snapchat.com/login/oauth2/access_token')
      const data = new URLSearchParams(String(init?.body))
      expect(data.get('client_secret')).toBe('secret')
      expect(['authorization_code', 'refresh_token']).toContain(data.get('grant_type'))
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
    }))
    expect(await adapter.exchangeCallback({ code: 'code', redirectUri: 'https://example.test/callback' })).toMatchObject({ accessToken: 'new-access', scopes: ['snapchat-profile-api'] })
    expect(await adapter.refreshToken({ refreshToken: 'refresh' })).toMatchObject({ accessToken: 'new-access' })
  })
  it.each([{}, { access_token: '' }, { access_token: 'access', expires_in: -1 }])('rejects missing or malformed tokens %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    await expect(adapter.exchangeCallback({ code: 'code', redirectUri: 'https://example.test/callback' })).rejects.toMatchObject({ code: 'unknown_platform_error' })
  })
  it('discovers only token-owned profiles and authorized organization profiles, never picks the first silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/my_profile') ? ok({ public_profile: { id: profile, snap_user_name: 'creator', organization_id: media } }) : ok({ public_profiles: [{ sub_request_status: 'SUCCESS', public_profile: { id: media, snap_user_name: 'second' } }] })))
    expect((await fetchSnapchatProfiles('access')).map(p => p.id)).toEqual([profile, media])
    expect(await adapter.fetchAccount({ accessToken: 'access' })).toMatchObject({ id: profile, name: 'creator', metadata: { profileConfirmed: false } })
  })
  it.each([{ request_status: 'ERROR', error_code: 'AUTHORIZATION_PERMISSION_DENIED' }, { request_status: 'SUCCESS', public_profiles: [{ sub_request_status: 'ERROR' }] }])('rejects nested or top-level errors in 200 responses', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    await expect(fetchSnapchatProfiles('access')).rejects.toBeInstanceOf(Error)
  })
})

describe('Snapchat encrypted media and publication', () => {
  it('encrypts bytes with random AES-256-CBC key/IV, uploads ADD then FINALIZE and stops at durable media_ready', async () => {
    const plain = new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0])
    let key: CryptoKey; let iv: Uint8Array; let encrypted: ArrayBuffer
    const actions: string[] = []
    const beforeExternalPost = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url) === input.videoUrl) return new Response(plain, { headers: { 'content-type': 'video/mp4' } })
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access')
      expect(init?.redirect).toBe('error')
      if (String(url).endsWith('/media')) {
        const data = JSON.parse(String(init?.body))
        expect(data.type).toBe('VIDEO')
        const rawKey = Uint8Array.from(atob(data.key), c => c.charCodeAt(0))
        iv = Uint8Array.from(atob(data.iv), c => c.charCodeAt(0))
        expect(rawKey).toHaveLength(32); expect(iv).toHaveLength(16)
        key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['decrypt'])
        return ok({ media_id: media, add_path: path, finalize_path: path })
      }
      expect(String(url)).toBe(base + path)
      const data = init?.body as FormData
      actions.push(String(data.get('action')))
      if (data.get('action') === 'ADD') { expect(data.get('part_number')).toBe('1'); encrypted = await (data.get('file') as unknown as File).arrayBuffer() }
      return ok()
    }))
    const result = await adapter.publishVideo({ ...input, beforeExternalPost })
    expect(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv! }, key!, encrypted!))).toEqual(plain)
    expect(actions).toEqual(['ADD', 'FINALIZE'])
    expect(beforeExternalPost).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'processing', providerResponse: { stage: 'media_ready', mediaId: media, profileId: profile, destination: 'spotlight' } })
    expect(result.externalPostId).toBeUndefined()
    expect(JSON.stringify(result)).not.toMatch(/"key"|"iv"|access|multipart-upload/)
  })
  it.each(['https://evil.example/upload', '//evil.example/upload', '/us/v1/public_profiles/wrong/media/' + media + '/multipart-upload', '/us/v1/public_profiles/' + profile + '/media/' + media + '/multipart-upload?token=x'])('rejects untrusted upload path %s before token transfer', async add_path => {
    const fetcher = vi.fn(async url => String(url) === input.videoUrl ? new Response('video', { headers: { 'content-type': 'video/mp4' } }) : ok({ media_id: media, add_path, finalize_path: path }))
    vi.stubGlobal('fetch', fetcher)
    await expect(adapter.publishVideo(input)).rejects.toMatchObject({ code: 'unknown_platform_error' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([{ durationSeconds: 5, width: 540, height: 960 }, { durationSeconds: 6, width: 960, height: 540 }, { durationSeconds: 61, width: 540, height: 960 }, null])('rejects ineligible Spotlight metadata %j before upload', async sourceMedia => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(adapter.publishVideo({ ...input, sourceMedia })).rejects.toMatchObject({ code: 'media_rejected' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('bounds source bytes before encryption', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('video', { headers: { 'content-type': 'video/mp4', 'content-length': String(SNAPCHAT_MAX_BYTES + 1) } })))
    await expect(adapter.publishVideo(input)).rejects.toMatchObject({ code: 'media_rejected' })
  })
  it.each(['story', 'spotlight'])('fences %s dispatch and applies text only to supported fields', async destination => {
    let fenced = false
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(fenced).toBe(true)
      expect(String(url)).toBe(`${base}/v1/public_profiles/${profile}/${destination === 'story' ? 'stories' : 'spotlights'}`)
      const body = JSON.parse(String(init?.body)); expect(body).toMatchObject({ media_id: media, link })
      if (destination === 'spotlight') expect(body).toMatchObject({ description: 'Human caption', locale: 'en_US' })
      else expect(body.description).toBeUndefined()
      return ok(destination === 'spotlight' ? { spotlight_id: 'synthetic_spotlight' } : {})
    }))
    const result = await adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { stage: 'media_ready', mediaId: media, profileId: profile, destination, caption: 'Human caption', sourceLink: link, mediaCreatedAt: String(Date.now()) }, beforeExternalPost: async () => { fenced = true } })
    expect(result.status).toBe('processing')
    expect(result.providerResponse.stage).toBe(destination === 'story' ? 'story_submitted' : 'spotlight_submitted')
    if (destination === 'story') expect(result.externalPostId).toBeUndefined()
  })
  it.each(['SUBMITTED', 'LIVE', 'REJECTED'])('reads Spotlight %s accurately', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ spotlights: [{ sub_request_status: 'SUCCESS', spotlight: { id: 'synthetic_spotlight', profile_id: profile, status } }] })))
    const result = adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { stage: 'spotlight_submitted', profileId: profile, spotlightId: 'synthetic_spotlight', destination: 'spotlight' } })
    if (status === 'REJECTED') await expect(result).rejects.toMatchObject({ code: 'media_rejected' })
    else expect((await result).status).toBe(status === 'LIVE' ? 'posted' : 'processing')
  })
  it.each([false, true])('only confirms a fresh Story snap with matching canonical link (match=%s)', async matches => {
    const sent = Date.now()
    vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/snaps') ? ok({ snaps: [{ sub_request_status: 'SUCCESS', snap: { id: 'synthetic_snap', story_id: media, link: matches ? link : 'https://example.test/unrelated', created_at: new Date(sent + 1000).toISOString() } }] }) : ok({ stories: [{ sub_request_status: 'SUCCESS', story: { id: media, profile_id: profile, type: 'PUBLIC_STORY' } }] })))
    const result = await adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { stage: 'story_submitted', profileId: profile, destination: 'story', sourceLink: link, dispatchedAt: String(sent) } })
    expect(result.status).toBe(matches ? 'posted' : 'processing')
    expect(result.externalPostUrl).toBeUndefined()
  })
})

describe('Snapchat malformed success and readback safeguards', () => {
  it.each([
    { request_status: 'SUCCESS', error_code: 'AUTHORIZATION_PERMISSION_DENIED', public_profile: { id: profile } },
    { request_status: 'SUCCESS', spotlights: [{ spotlight: { id: 'synthetic_spotlight', profile_id: profile, status: 'LIVE' } }] },
  ])('rejects contradictory or incomplete success envelopes %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    const action = body.public_profile ? adapter.fetchAccount({ accessToken: 'access' }) : adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { stage: 'spotlight_submitted', profileId: profile, spotlightId: 'synthetic_spotlight' } })
    await expect(action).rejects.toBeInstanceOf(Error)
  })
  it('does not report an older unrelated Story with the same link as the current post', async () => {
    const sent = Date.now()
    vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/snaps') ? ok({ snaps: [{ sub_request_status: 'SUCCESS', snap: { id: 'old_snap', story_id: media, link, created_at: new Date(sent - 1).toISOString() } }] }) : ok({ stories: [{ sub_request_status: 'SUCCESS', story: { id: media, profile_id: profile, type: 'PUBLIC_STORY' } }] })))
    expect((await adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { stage: 'story_submitted', profileId: profile, sourceLink: link, dispatchedAt: String(sent) } })).status).toBe('processing')
  })
  it('requires an exact Spotlight identifier and profile match before LIVE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ spotlights: [{ sub_request_status: 'SUCCESS', spotlight: { id: 'different_id', profile_id: media, status: 'LIVE' } }] })))
    await expect(adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { stage: 'spotlight_submitted', profileId: profile, spotlightId: 'synthetic_spotlight' } })).rejects.toBeInstanceOf(Error)
  })
  it.each([undefined, '', 'bad/id', 'https://evil.example/post'])('rejects missing or unsafe accepted post ID %s', async spotlight_id => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ spotlight_id })))
    await expect(adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { stage: 'media_ready', profileId: profile, mediaId: media, destination: 'spotlight', sourceLink: link, mediaCreatedAt: String(Date.now()) } })).rejects.toBeInstanceOf(Error)
  })
  it('chunks encrypted media consecutively within the documented maximum and finalizes only after every ADD', async () => {
    const plain = new Uint8Array(9 * 1024 * 1024)
    const chunks: Uint8Array[] = []; const actions: string[] = []; let rawKey: Uint8Array; let iv: Uint8Array
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url) === input.videoUrl) return new Response(plain, { headers: { 'content-type': 'video/mp4' } })
      if (String(url).endsWith('/media')) {
        const data = JSON.parse(String(init?.body)); rawKey = Uint8Array.from(atob(data.key), c => c.charCodeAt(0)); iv = Uint8Array.from(atob(data.iv), c => c.charCodeAt(0))
        return ok({ media_id: media, add_path: path, finalize_path: path })
      }
      const form = init?.body as FormData; actions.push(String(form.get('action')))
      if (form.get('action') === 'ADD') { expect(form.get('part_number')).toBe(String(chunks.length + 1)); const bytes = new Uint8Array(await (form.get('file') as unknown as File).arrayBuffer()); expect(bytes.byteLength).toBeLessThanOrEqual(32 * 1024 * 1024); chunks.push(bytes) }
      return ok()
    }))
    await adapter.publishVideo(input)
    expect(actions).toEqual(['ADD', 'ADD', 'FINALIZE'])
    const encrypted = new Uint8Array(chunks.reduce((size, bytes) => size + bytes.length, 0)); let offset = 0
    for (const bytes of chunks) { encrypted.set(bytes, offset); offset += bytes.length }
    const key = await crypto.subtle.importKey('raw', rawKey!, 'AES-CBC', false, ['decrypt'])
    expect((await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv! }, key, encrypted)).byteLength).toBe(plain.byteLength)
  })
  it('stops before finalization when an ADD response fails, without outward publication', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async url => { urls.push(String(url)); return String(url) === input.videoUrl ? new Response('video', { headers: { 'content-type': 'video/mp4' } }) : String(url).endsWith('/media') ? ok({ media_id: media, add_path: path, finalize_path: path }) : Response.json({ request_status: 'ERROR', error_code: 'INVALID_MEDIA' }) }))
    await expect(adapter.publishVideo(input)).rejects.toMatchObject({ code: 'media_rejected' }); expect(urls).toHaveLength(3)
  })
})

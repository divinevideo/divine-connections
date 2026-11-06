// ABOUTME: Implements Snapchat Public Profile OAuth and encrypted media uploads.
// ABOUTME: Separates durable media checkpoints from fenced publication and verified readback.
import { asRecord, fetchVideoBytes, PlatformAdapterError, readProviderResponse, type PlatformAdapter, type PlatformAccount, type PublishResult, type TokenSet } from './adapter'
import type { SnapchatDestination, SourceMedia } from '../types'
const API = 'https://businessapi.snapchat.com'
const TOKEN = 'https://accounts.snapchat.com/login/oauth2/access_token'
const SCOPE = 'snapchat-profile-api'
// Worker memory budget: plaintext, encryption and multipart buffers coexist.
export const SNAPCHAT_MAX_BYTES = 16 * 1024 * 1024
const CHUNK_BYTES = 8 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const ID = /^[A-Za-z0-9_-]{1,256}$/
const fail = (message: string, code: 'unknown_platform_error' | 'media_rejected' | 'needs_reauth' = 'unknown_platform_error'): never => { throw new PlatformAdapterError('snapchat', code, message) }
function identifier(value: unknown, uuid = false): string { if (typeof value !== 'string' || !(uuid ? UUID : ID).test(value)) fail('Snapchat returned an invalid identifier'); return value as string }
function sourceLink(value: unknown): string { if (typeof value !== 'string' || !/^https:\/\/divine\.video\/video\/[a-f0-9]{64}$/.test(value)) fail('Missing canonical Divine source link'); return value as string }
function safeEndpoint(path: string): string { return path.replace(/[a-f0-9-]{36}/gi, ':id').replace(/(spotlights|stories)\/[^/?]+/g, '$1/:id') }
async function request(url: string, accessToken: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, redirect: 'error', headers: { Authorization: `Bearer ${accessToken}`, ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...init.headers } })
  const body = asRecord(await readProviderResponse(response))
  const nested = ['public_profiles', 'spotlights', 'stories', 'snaps'].flatMap(key => Array.isArray(body[key]) ? body[key] as unknown[] : []).map(asRecord).find(value => value.sub_request_status !== 'SUCCESS' || value.error_code)
  if (!response.ok || body.request_status !== 'SUCCESS' || body.error_code || nested) {
    const reason = String(body.error_code ?? nested?.sub_request_error_reason ?? '')
    const code = response.status === 402 ? 'provider_payment_required' : response.status === 401 || response.status === 403 || /AUTHORIZATION|TOKEN|PERMISSION/.test(reason) ? 'needs_reauth' : response.status === 429 || /RATE|THROTTL/.test(reason) ? 'rate_limited' : /MEDIA|VIDEO/.test(reason) ? 'media_rejected' : 'unknown_platform_error'
    // Do not persist provider strings: they can echo token, key, URL or caption.
    throw new PlatformAdapterError('snapchat', code, code === 'needs_reauth' ? 'Reconnect Snapchat and confirm public-profile publishing permission' : 'Snapchat request failed', response.status, { error: { type: code } }, safeEndpoint(new URL(url).pathname))
  }
  return body
}
function profile(value: unknown): PlatformAccount {
  const data = asRecord(value)
  const id = identifier(data.id, true)
  return { id, name: typeof data.snap_user_name === 'string' && data.snap_user_name.trim() ? data.snap_user_name : id, metadata: { displayName: typeof data.display_name === 'string' ? data.display_name : id, organizationId: typeof data.organization_id === 'string' && UUID.test(data.organization_id) ? data.organization_id : null, profileConfirmed: false } }
}
export async function fetchSnapchatProfiles(accessToken: string): Promise<PlatformAccount[]> {
  const own = profile((await request(API + '/v1/public_profiles/my_profile', accessToken)).public_profile)
  const profiles = [own]
  if (own.metadata.organizationId) {
    let cursor = ''
    for (let page = 0; page < 5; page++) {
      let body: Record<string, unknown>
      try { body = await request(`${API}/v1/organizations/${own.metadata.organizationId}/public_profiles?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, accessToken) }
      catch (error) { if (error instanceof PlatformAdapterError && error.providerStatus === 403) break; throw error }
      if (!Array.isArray(body.public_profiles)) fail('Snapchat returned no authorized profiles')
      for (const entry of body.public_profiles as unknown[]) { const item = profile(asRecord(entry).public_profile); if (!profiles.some(p => p.id === item.id)) profiles.push(item) }
      cursor = typeof asRecord(body.paging).next_page_id === 'string' ? asRecord(body.paging).next_page_id as string : ''
      if (!cursor) break
      if (page === 4) fail('Too many Snapchat profiles; contact support to narrow organization access')
    }
  }
  return profiles
}
export function validateSnapchatMedia(destination: SnapchatDestination, media: SourceMedia | null | undefined): void {
  const min = destination === 'story' ? 5 : 6
  if (!media || !Number.isFinite(media.durationSeconds) || media.durationSeconds < min || media.durationSeconds > 60 || !Number.isInteger(media.width) || !Number.isInteger(media.height) || media.width < 540 || media.height < 960 || media.width >= media.height) {
    fail(`Snapchat ${destination === 'story' ? 'public Story' : 'Spotlight'} requires measured ${min}–60 second portrait MP4 video, at least 540×960 pixels`, 'media_rejected')
  }
}
function uploadUrl(value: unknown, profileId: string, mediaId: string): string {
  if (typeof value !== 'string' || !new RegExp(`^/(?:[a-z]{2}/)?v1/public_profiles/${profileId}/media/${mediaId}/multipart-upload$`).test(value)) fail('Snapchat returned an unsafe upload URL')
  return API + value
}
function pending(checkpoint: Record<string, unknown>, id?: string): PublishResult { return { status: 'processing', ...(id ? { externalPostId: id } : {}), providerResponse: checkpoint } }
export function createSnapchatAdapter(options: { clientId: string; clientSecret: string }): PlatformAdapter {
  async function token(params: Record<string, string>): Promise<TokenSet> {
    const response = await fetch(TOKEN, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, ...params }) })
    const body = asRecord(await readProviderResponse(response))
    if (!response.ok || body.error) throw new PlatformAdapterError('snapchat', response.status === 402 ? 'provider_payment_required' : response.status === 401 || body.error === 'invalid_grant' ? 'needs_reauth' : 'unknown_platform_error', 'Snapchat authorization failed', response.status, undefined, '/login/oauth2/access_token')
    if (typeof body.access_token !== 'string' || !body.access_token.trim() || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || (params.grant_type === 'authorization_code' && (typeof body.refresh_token !== 'string' || !body.refresh_token.trim()))) fail('Snapchat returned incomplete credentials')
    return { accessToken: body.access_token as string, refreshToken: typeof body.refresh_token === 'string' && body.refresh_token.trim() ? body.refresh_token : undefined, expiresAt: Math.floor(Date.now()/1000) + (body.expires_in as number), scopes: [SCOPE], metadata: {} }
  }
  return {
    platform: 'snapchat',
    buildAuthorizationUrl({ state, redirectUri }) { const url = new URL('https://accounts.snapchat.com/login/oauth2/authorize'); url.search = new URLSearchParams({ client_id: options.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, state }).toString(); return url.toString() },
    exchangeCallback: ({ code, redirectUri }) => token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    refreshToken: ({ refreshToken }) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async fetchAccount({ accessToken }) { return profile((await request(API + '/v1/public_profiles/my_profile', accessToken)).public_profile) },
    async publishVideo(input) {
      const destination = input.snapchatDestination ?? 'spotlight'
      if (destination !== 'spotlight' && destination !== 'story') fail('Choose Spotlight or public Story', 'media_rejected')
      validateSnapchatMedia(destination, input.sourceMedia)
      const profileId = identifier(input.externalAccountId, true)
      const link = sourceLink(input.canonicalSourceUrl)
      if (destination === 'spotlight' && [...input.caption].length > 160) fail('Spotlight description exceeds 160 characters', 'media_rejected')
      const { bytes, contentType } = await fetchVideoBytes('snapchat', input.videoUrl, SNAPCHAT_MAX_BYTES)
      if (contentType.split(';')[0].trim() !== 'video/mp4') fail('Snapchat requires an MP4 source video', 'media_rejected')
      const rawKey = crypto.getRandomValues(new Uint8Array(32)); const iv = crypto.getRandomValues(new Uint8Array(16))
      const key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt'])
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, bytes)
      const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value))
      const body = await request(`${API}/v1/public_profiles/${profileId}/media`, input.accessToken, { method: 'POST', body: JSON.stringify({ type: 'VIDEO', name: 'Divine video', key: encode(rawKey), iv: encode(iv) }) })
      const mediaId = identifier(body.media_id, true)
      const add = uploadUrl(body.add_path, profileId, mediaId); const finalize = uploadUrl(body.finalize_path, profileId, mediaId)
      for (let offset = 0, part = 1; offset < encrypted.byteLength; offset += CHUNK_BYTES, part++) {
        const data = new FormData(); data.set('action', 'ADD'); data.set('part_number', String(part)); data.set('file', new Blob([encrypted.slice(offset, offset + CHUNK_BYTES)]), 'video.enc.mp4')
        await request(add, input.accessToken, { method: 'POST', body: data })
      }
      const data = new FormData(); data.set('action', 'FINALIZE'); await request(finalize, input.accessToken, { method: 'POST', body: data })
      return pending({ stage: 'media_ready', profileId, mediaId, destination, caption: input.caption, sourceLink: link, mediaCreatedAt: String(Date.now()) })
    },
    async pollPublishStatus(input) {
      const cp = input.providerResponse
      const profileId = identifier(cp.profileId, true)
      if (cp.stage === 'media_ready') {
        const mediaId = identifier(cp.mediaId, true); const link = sourceLink(cp.sourceLink)
        if (cp.destination !== 'story' && cp.destination !== 'spotlight') fail('Invalid Snapchat destination checkpoint')
        if (!Number.isFinite(Number(cp.mediaCreatedAt)) || Date.now() - Number(cp.mediaCreatedAt) >= 23 * 3600_000) fail('Snapchat media expired before publication; contact support', 'media_rejected')
        const caption = typeof cp.caption === 'string' ? cp.caption : ''
        if (cp.destination === 'spotlight' && [...caption].length > 160) fail('Spotlight description exceeds 160 characters', 'media_rejected')
        const dispatchedAt = String(Date.now())
        await input.beforeExternalPost?.()
        const body = await request(`${API}/v1/public_profiles/${profileId}/${cp.destination === 'story' ? 'stories' : 'spotlights'}`, input.accessToken, { method: 'POST', body: JSON.stringify({ media_id: mediaId, link, ...(cp.destination === 'spotlight' ? { description: caption, locale: 'en_US' } : {}) }) })
        if (cp.destination === 'story') return pending({ ...cp, stage: 'story_submitted', dispatchedAt })
        const spotlightId = identifier(body.spotlight_id)
        return pending({ ...cp, stage: 'spotlight_submitted', spotlightId, dispatchedAt }, spotlightId)
      }
      if (cp.stage === 'spotlight_submitted') {
        const id = identifier(cp.spotlightId)
        const body = await request(`${API}/v1/public_profiles/${profileId}/spotlights/${id}`, input.accessToken)
        const item = (Array.isArray(body.spotlights) ? body.spotlights : []).map(v => asRecord(asRecord(v).spotlight)).find(v => v.id === id && v.profile_id === profileId)
        if (!item) fail('Snapchat returned no matching Spotlight')
        if (item!.status === 'REJECTED') fail('Snapchat rejected this Spotlight', 'media_rejected')
        if (item!.status === 'LIVE') return { status: 'posted', externalPostId: id, providerResponse: cp }
        if (item!.status !== 'SUBMITTED') fail('Snapchat returned an unknown Spotlight status')
        return pending(cp, id)
      }
      if (cp.stage === 'story_submitted') {
        const link = sourceLink(cp.sourceLink); const since = Number(cp.dispatchedAt)
        if (!Number.isFinite(since) || since <= 0) fail('Invalid Story dispatch checkpoint')
        const stories = await request(`${API}/v1/public_profiles/${profileId}/stories?limit=10`, input.accessToken)
        for (const row of (Array.isArray(stories.stories) ? stories.stories : []).slice(0, 10)) {
          const story = asRecord(asRecord(row).story)
          if (story.profile_id !== profileId || story.type !== 'PUBLIC_STORY') continue
          const storyId = identifier(story.id, true)
          const snaps = await request(`${API}/v1/public_profiles/${profileId}/stories/${storyId}/snaps?limit=100`, input.accessToken)
          const matches = (Array.isArray(snaps.snaps) ? snaps.snaps : []).map(v => asRecord(asRecord(v).snap)).filter(v => v.story_id === storyId && v.link === link && typeof v.created_at === 'string' && Date.parse(v.created_at) >= since && Date.parse(v.created_at) <= Date.now() + 60_000)
          // A long video can produce several matching Snaps; this ID represents one Snap, not the whole video.
          if (matches.length > 0) return { status: 'posted', externalPostId: identifier(matches[0].id), providerResponse: cp }
        }
        return pending(cp)
      }
      return fail('Missing Snapchat upload checkpoint; manual reconciliation required')
    },
  }
}

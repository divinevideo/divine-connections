// ABOUTME: Connects creator accounts and publishes videos through the youtube API.
// ABOUTME: Validates provider responses before persisting credentials or publish results.
import { PlatformAdapterError, asRecord, expectProviderOk, fetchVideoBytes } from './adapter'
import type { PlatformAdapter, PublishResult, TokenSet } from './adapter'
import type { YouTubePrivacyStatus } from '../config'

type YouTubeConfig = {
  clientId: string
  clientSecret: string
  defaultPrivacyStatus?: YouTubePrivacyStatus
}

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
]

function tokenSetFromResponse(response: Record<string, unknown>): TokenSet {
  if (typeof response.access_token !== 'string' || !response.access_token.trim()) {
    throw new PlatformAdapterError('youtube', 'unknown_platform_error', 'youtube token response missing access token')
  }
  const expiresIn = typeof response.expires_in === 'number' ? response.expires_in : undefined
  return {
    accessToken: response.access_token,
    refreshToken: typeof response.refresh_token === 'string' ? response.refresh_token : undefined,
    expiresAt: expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
    scopes: typeof response.scope === 'string' ? response.scope.split(' ') : SCOPES,
    metadata: response,
  }
}

// Count code points while retaining whole graphemes, including joined emoji.
export function youtubeTitle(source: string): string {
  const normalized = source.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  let title = ''
  let length = 0
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized)) {
    const size = Array.from(segment).length
    if (length + size > 100) break
    title += segment
    length += size
  }
  return title.trim() || 'Divine video'
}

function videoId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null
}

function uploadSession(value: string | null): string {
  try {
    const url = new URL(value ?? '')
    if (url.protocol === 'https:' && url.hostname === 'www.googleapis.com' && !url.port && !url.username && !url.password &&
        url.pathname === '/upload/youtube/v3/videos' && !url.hash) return url.toString()
  } catch { /* Invalid sessions are rejected before forwarding credentials. */ }
  throw new PlatformAdapterError('youtube', 'unknown_platform_error', 'invalid YouTube upload session')
}

function videoResult(id: string, status: 'processing' | 'posted'): PublishResult {
  return { status, externalPostId: id, externalPostUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, providerResponse: { id } }
}

export function createYouTubeAdapter(config: YouTubeConfig): PlatformAdapter {
  const defaultPrivacyStatus = config.defaultPrivacyStatus ?? 'private'

  return {
    platform: 'youtube',
    buildAuthorizationUrl({ state, redirectUri, codeChallenge }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
      url.searchParams.set('scope', SCOPES.join(' '))
      if (codeChallenge) {
        url.searchParams.set('code_challenge', codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
      }
      return url.toString()
    },
    async exchangeCallback({ code, redirectUri, codeVerifier }) {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      })
      if (codeVerifier) body.set('code_verifier', codeVerifier)
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })
      return tokenSetFromResponse(asRecord(await expectProviderOk('youtube', response)))
    },
    async refreshToken({ refreshToken }) {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      })
      return tokenSetFromResponse(asRecord(await expectProviderOk('youtube', response)))
    },
    async fetchAccount({ accessToken }) {
      const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      const body = asRecord(await expectProviderOk('youtube', response))
      const items = Array.isArray(body.items) ? body.items : []
      const channel = asRecord(items[0])
      const snippet = asRecord(channel.snippet)
      return { id: String(channel.id ?? ''), name: String(snippet.title ?? 'YouTube channel'), metadata: body }
    },
    async publishVideo({ accessToken, videoUrl, caption, youtubePrivacyStatus, youtubeTitle: title, beforeExternalPost }): Promise<PublishResult> {
      if (new TextEncoder().encode(caption).byteLength > 5000 || /[<>]/.test(caption)) {
        throw new PlatformAdapterError('youtube', 'media_rejected', 'YouTube description must be at most 5000 UTF-8 bytes and cannot contain < or >')
      }
      const video = await fetchVideoBytes('youtube', videoUrl)
      const metadataResponse = await fetch(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            'x-upload-content-type': video.contentType,
            'x-upload-content-length': String(video.bytes.byteLength),
          },
          body: JSON.stringify({
            snippet: { title: youtubeTitle(title ?? ''), description: caption },
            status: { privacyStatus: youtubePrivacyStatus ?? defaultPrivacyStatus, selfDeclaredMadeForKids: false },
          }),
        },
      )
      await expectProviderOk('youtube', metadataResponse)
      const uploadUrl = uploadSession(metadataResponse.headers.get('location'))

      await beforeExternalPost?.()
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': video.contentType,
          'content-length': String(video.bytes.byteLength),
        },
        body: video.bytes,
      })
      const body = asRecord(await expectProviderOk('youtube', uploadResponse))
      const id = videoId(body.id)
      if (!id) throw new PlatformAdapterError('youtube', 'ambiguous_post_result', 'YouTube accepted upload without a usable video ID')
      // No more HTTP after upload acceptance: the publisher stores this ID first.
      return videoResult(id, 'processing')
    },
    async pollPublishStatus({ accessToken, providerResponse, youtubePrivacyStatus }): Promise<PublishResult> {
      const id = videoId(providerResponse.id)
      if (!id) throw new PlatformAdapterError('youtube', 'ambiguous_post_result', 'YouTube upload ID is missing; manual reconciliation required')
      const url = new URL('https://www.googleapis.com/youtube/v3/videos')
      url.searchParams.set('part', 'status,processingDetails')
      url.searchParams.set('id', id)
      const response = await fetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } })
      const body = asRecord(await expectProviderOk('youtube', response))
      const items = Array.isArray(body.items) ? body.items : []
      const resource = items.map(asRecord).find((item) => item.id === id)
      if (!resource) throw new PlatformAdapterError('youtube', 'processing_timeout', 'YouTube video is not available for status verification')
      const status = asRecord(resource.status)
      const processing = asRecord(resource.processingDetails)
      if (['failed', 'rejected', 'deleted'].includes(String(status.uploadStatus)) || ['failed', 'terminated'].includes(String(processing.processingStatus))) {
        throw new PlatformAdapterError('youtube', 'media_rejected', 'YouTube rejected the video or could not complete processing')
      }
      if (processing.processingStatus !== 'succeeded' || status.uploadStatus !== 'processed') return videoResult(id, 'processing')
      const expectedPrivacy = youtubePrivacyStatus ?? defaultPrivacyStatus
      if (!['private', 'unlisted', 'public'].includes(String(status.privacyStatus))) return videoResult(id, 'processing')
      if (status.privacyStatus !== expectedPrivacy) {
        throw new PlatformAdapterError('youtube', 'platform_review_required', 'YouTube visibility differs from the selected audience; check the video in YouTube Studio')
      }
      return videoResult(id, 'posted')
    },
  }
}

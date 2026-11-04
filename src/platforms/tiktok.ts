// ABOUTME: Connects creator accounts and publishes videos through the tiktok API.
// ABOUTME: Validates provider responses before persisting credentials or publish results.
import { PlatformAdapterError, asRecord, expectProviderOk } from './adapter'
import type { PlatformAdapter, PublishResult, TokenSet } from './adapter'
import type { TikTokCreatorInfo, TikTokPostOptions } from '../types'

type TikTokConfig = {
  clientKey: string
  clientSecret: string
}

const API_BASE = 'https://open.tiktokapis.com/v2'

function tokenSetFromResponse(response: Record<string, unknown>): TokenSet {
  if (['invalid_grant', 'invalid_refresh_token', 'invalid_token'].includes(String(response.error ?? ''))) {
    throw new PlatformAdapterError('tiktok', 'needs_reauth', 'Reconnect your TikTok account')
  }
  if (typeof response.access_token !== 'string' || !response.access_token.trim()) {
    throw new PlatformAdapterError('tiktok', 'unknown_platform_error', 'tiktok token response missing access token')
  }
  const expiresIn = typeof response.expires_in === 'number' ? response.expires_in : undefined
  return {
    accessToken: response.access_token,
    refreshToken: typeof response.refresh_token === 'string' ? response.refresh_token : undefined,
    expiresAt: expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
    scopes: typeof response.scope === 'string' ? response.scope.split(',').map((scope) => scope.trim()) : [],
    metadata: response,
  }
}

export async function fetchTikTokCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
  const response = await fetch(`${API_BASE}/post/publish/creator_info/query/`, {
    method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  })
  const body = asRecord(await expectProviderOk('tiktok', response))
  const info = asRecord(body.data)
  if (info.direct_post_available === false || info.direct_post_enabled === false || info.can_post === false) {
    throw new PlatformAdapterError('tiktok', 'platform_review_required', 'TikTok posting is unavailable; try again later')
  }
  const privacy = info.privacy_level_options
  if (!Array.isArray(privacy) || !privacy.length || !privacy.every(value => typeof value === 'string' && ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].includes(value)) ||
    typeof info.creator_username !== 'string' || !info.creator_username || typeof info.creator_nickname !== 'string' ||
    !['comment_disabled', 'duet_disabled', 'stitch_disabled'].every(key => typeof info[key] === 'boolean') ||
    typeof info.max_video_post_duration_sec !== 'number' || !Number.isFinite(info.max_video_post_duration_sec) || info.max_video_post_duration_sec <= 0) {
    throw new PlatformAdapterError('tiktok', 'platform_review_required', 'TikTok creator settings are unavailable; try again later')
  }
  return {
    creator_username: info.creator_username, creator_nickname: info.creator_nickname,
    privacy_level_options: privacy, comment_disabled: info.comment_disabled as boolean,
    duet_disabled: info.duet_disabled as boolean, stitch_disabled: info.stitch_disabled as boolean,
    max_video_post_duration_sec: info.max_video_post_duration_sec,
  }
}

/** Compare only the displayed, validated fields; a changed account/settings needs new consent. */
export function sameTikTokCreatorInfo(value: unknown, current: TikTokCreatorInfo): boolean {
  const previous = asRecord(value)
  return Object.entries(current).every(([key, value]) => JSON.stringify(previous[key]) === JSON.stringify(value))
}

export function validateTikTokPostOptions(value: unknown, current: TikTokCreatorInfo, duration: number | null, connectionId?: string): TikTokPostOptions {
  const option = asRecord(value)
  const invalid = (message: string): never => { throw new PlatformAdapterError('tiktok', 'not_eligible', message) }
  if (typeof option.connectionId !== 'string' || (connectionId && option.connectionId !== connectionId)) invalid('Confirm the connected TikTok account')
  if (!sameTikTokCreatorInfo(option.creatorInfo, current)) invalid('TikTok settings changed; preview and confirm again')
  if (typeof option.privacyLevel !== 'string' || !current.privacy_level_options.includes(option.privacyLevel)) invalid('Choose an available TikTok privacy level')
  for (const key of ['allowComment', 'allowDuet', 'allowStitch', 'commercialContent', 'brandOrganic', 'brandContent', 'brandedContentConfirmed']) {
    if (typeof option[key] !== 'boolean') invalid('Confirm all TikTok interaction and disclosure choices')
  }
  if ((option.allowComment && current.comment_disabled) || (option.allowDuet && current.duet_disabled) || (option.allowStitch && current.stitch_disabled)) invalid('TikTok does not allow the selected interaction')
  if (option.musicUsageConfirmed !== true) invalid('Agree to TikTok music usage before posting')
  if (option.commercialContent !== Boolean(option.brandOrganic || option.brandContent)) invalid('Indicate whether this content promotes your brand, another brand, or both')
  if (option.brandContent && (!option.brandedContentConfirmed || !['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS'].includes(String(option.privacyLevel)))) invalid('Branded content needs public/friends visibility and policy consent')
  if (typeof option.confirmedCaption !== 'string' || option.confirmedCaption.length > 2200) invalid('TikTok captions must be at most 2200 UTF-16 characters')
  if (duration === null || !Number.isFinite(duration) || duration <= 0 || duration > current.max_video_post_duration_sec) invalid('Video duration is missing or exceeds the current TikTok limit')
  return {
    connectionId: option.connectionId as string, creatorInfo: current, privacyLevel: option.privacyLevel as string,
    allowComment: option.allowComment as boolean, allowDuet: option.allowDuet as boolean, allowStitch: option.allowStitch as boolean,
    commercialContent: option.commercialContent as boolean, brandOrganic: option.brandOrganic as boolean, brandContent: option.brandContent as boolean,
    confirmedCaption: option.confirmedCaption as string, musicUsageConfirmed: true, brandedContentConfirmed: option.brandedContentConfirmed as boolean,
    durationSeconds: duration as number,
  }
}

function tiktokData(response: Record<string, unknown>): Record<string, unknown> {
  return asRecord(response.data)
}

function tiktokPublishId(response: Record<string, unknown>): string {
  const data = tiktokData(response)
  const id = data.publish_id ?? response.publish_id
  return typeof id === 'string' ? id : ''
}

function tiktokStatus(response: Record<string, unknown>): string {
  const data = tiktokData(response)
  return String(data.status ?? response.status ?? '')
}

function publishIdFromProviderResponse(providerResponse: Record<string, unknown>): string {
  return String(providerResponse.publish_id ?? tiktokData(providerResponse).publish_id ?? providerResponse.externalPostId ?? '')
}

export function createTikTokAdapter(config: TikTokConfig): PlatformAdapter {
  return {
    platform: 'tiktok',
    buildAuthorizationUrl({ state, redirectUri, codeChallenge }) {
      const url = new URL('https://www.tiktok.com/v2/auth/authorize/')
      url.searchParams.set('client_key', config.clientKey)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      url.searchParams.set('response_type', 'code')
      // user.info.profile gates the `username` field fetchAccount requests; without it
      // TikTok fails the whole user/info call with scope_not_authorized.
      url.searchParams.set('scope', 'user.info.basic,user.info.profile,video.publish')
      if (codeChallenge) {
        url.searchParams.set('code_challenge', codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
      }
      return url.toString()
    },
    async exchangeCallback({ code, redirectUri, codeVerifier }) {
      const body = new URLSearchParams({
        client_key: config.clientKey,
        client_secret: config.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      })
      if (codeVerifier) body.set('code_verifier', codeVerifier)
      const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', body })
      return tokenSetFromResponse(asRecord(await expectProviderOk('tiktok', response)))
    },
    async refreshToken({ refreshToken }) {
      const body = new URLSearchParams({
        client_key: config.clientKey,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })
      const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', body })
      return tokenSetFromResponse(asRecord(await expectProviderOk('tiktok', response)))
    },
    async fetchAccount({ accessToken }) {
      const response = await fetch(`${API_BASE}/user/info/?fields=open_id,username,display_name,avatar_url`, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      const body = asRecord(await expectProviderOk('tiktok', response))
      const user = asRecord(asRecord(body.data).user)
      return {
        id: String(user.open_id ?? ''),
        name: String(user.username ?? user.display_name ?? 'TikTok account'),
        metadata: body,
      }
    },
    async publishVideo({ accessToken, videoUrl, tiktokPostOptions, beforeExternalPost }): Promise<PublishResult> {
      if (!tiktokPostOptions) throw new PlatformAdapterError('tiktok', 'not_eligible', 'TikTok requires manual confirmation')
      const creatorInfo = await fetchTikTokCreatorInfo(accessToken)
      const options = validateTikTokPostOptions(tiktokPostOptions, creatorInfo, tiktokPostOptions.durationSeconds)
      await beforeExternalPost?.()
      const response = await fetch(`${API_BASE}/post/publish/video/init/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          post_info: {
            title: options.confirmedCaption,
            privacy_level: options.privacyLevel,
            disable_duet: !options.allowDuet,
            disable_comment: !options.allowComment,
            disable_stitch: !options.allowStitch,
            brand_content_toggle: options.brandContent,
            brand_organic_toggle: options.brandOrganic,
          },
          source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
        }),
      })
      const body = asRecord(await expectProviderOk('tiktok', response))
      const publishId = tiktokPublishId(body)
      if (!publishId.trim()) throw new PlatformAdapterError('tiktok', 'unknown_platform_error', 'TikTok did not return a publish ID')
      return {
        status: 'processing',
        externalPostId: publishId,
        providerResponse: { creatorInfo, ...body, publish_id: publishId },
      }
    },
    async pollPublishStatus({ accessToken, providerResponse }) {
      const publishId = publishIdFromProviderResponse(providerResponse)
      if (!publishId.trim()) throw new PlatformAdapterError('tiktok', 'unknown_platform_error', 'TikTok publish ID is missing')
      const response = await fetch(`${API_BASE}/post/publish/status/fetch/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ publish_id: publishId }),
      })
      const body = asRecord(await expectProviderOk('tiktok', response))
      const providerStatus = tiktokStatus(body)
      if (providerStatus === 'FAILED') {
        const code = tiktokData(body).fail_reason === 'auth_removed' ? 'needs_reauth' : 'media_rejected'
        throw new PlatformAdapterError('tiktok', code, 'TikTok publishing failed')
      }
      const status = providerStatus === 'PUBLISH_COMPLETE' ? 'posted' : 'processing'
      return { status, externalPostId: publishId, providerResponse: { ...body, publish_id: publishId } }
    },
  }
}

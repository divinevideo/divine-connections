// ABOUTME: Creates and reads creator-owned crosspost jobs.
// ABOUTME: Preserves existing opt-in and provider isolation guarantees.
import { validateSnapchatMedia } from '../platforms/snapchat'
import { asRecord } from '../platforms/adapter'
import { confirmTikTokOptions } from './tiktok-posting'
import { parseYouTubePrivacyStatus } from '../config'
import { youtubeTitle } from '../platforms/youtube'
import type { DivineVideoEvent } from '../funnelcake/client'
import { fetchVideoEvent, type DivineVideoLookup } from '../funnelcake/client'
import { buildCrosspostCaption } from './attribution'
import { listAttempts } from '../db/attempts'
import { getActiveConnectionForPlatform, getConnection } from '../db/connections'
import { createOrGetJob, getJob, listJobsForVideo } from '../db/jobs'
import { getPreferences } from '../db/preferences'
import { getAdapter } from '../platforms/registry'
import type { SourceMedia, SnapchatDestination, ConnectionRecord, Env, InstagramDestination, JobAttemptRecord, JobRecord, Platform, PreferenceRecord, TikTokPostOptions, YouTubePrivacyStatus } from '../types'
import { generateRandomId } from '../utils/crypto'
import { HttpError } from '../utils/http'
import { isValidEventId, parsePlatform, parseSnapchatDestination, parseInstagramDestination, parseYouTubePrivacyOption } from '../utils/validation'

export type CrosspostJobsResult = {
  jobs: JobRecord[]
}

export type PublicJobAttempt = Omit<JobAttemptRecord, 'providerResponseJson'>

export type JobWithAttemptsResult = {
  job: JobRecord
  attempts: PublicJobAttempt[]
}

type SourceSnapshot = {
  sourceMedia: SourceMedia | null
  durationSeconds: number | null
  title: string | null
  mediaUrl: string
  mediaHash: string
  caption: string
  createdAt: number
  /** Best-effort creator handle from funnelcake, used for crosspost credit. */
  authorName: string | null
}

const VIDEO_KIND = 34236
const JOB_EXPIRATION_SECONDS = 48 * 60 * 60
const ALLOWED_MEDIA_HOSTS = new Set([
  'media.divine.video',
  'cdn.divine.video',
  'blossom.divine.video',
  'media.dvines.org',
  'cdn.dvines.org',
  'blossom.dvines.org',
])

function ensureEventId(value: string): string {
  if (!isValidEventId(value)) {
    throw new HttpError(400, 'invalid_event_id', 'invalid event id')
  }
  return value.toLowerCase()
}

function tagValue(tags: string[][], name: string): string | null {
  const tag = tags.find((candidate) => candidate[0] === name && typeof candidate[1] === 'string')
  return tag?.[1] ?? null
}

function descriptorValues(tag: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 1; index < tag.length; index += 1) {
    const entry = tag[index]
    if (entry === name && index + 1 < tag.length) {
      values.push(tag[index + 1].trim())
      index += 1
    } else if (entry.startsWith(name + ' ')) {
      values.push(entry.slice(name.length + 1).trim())
    }
  }
  return [...new Set(values)]
}

function uniqueValue(values: string[]): string | null {
  const distinct = [...new Set(values)]
  return distinct.length === 1 && distinct[0] ? distinct[0] : null
}

function durationSeconds(value: string | null): number | null {
  if (value === null || !value.trim()) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

function isUsableMediaUrl(value: string | null): value is string {
  if (!value) {
    return false
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ALLOWED_MEDIA_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

type MediaDescriptor = { dimensions: string | null; url: string | null; hash: string | null; duration: number | null }

function selectedMedia(event: DivineVideoEvent): MediaDescriptor {
  const descriptors = event.tags.filter(tag => tag[0] === 'imeta').map(tag => ({
    urls: descriptorValues(tag, 'url'), hash: uniqueValue(descriptorValues(tag, 'x')),
    durations: descriptorValues(tag, 'duration'), dimensions: uniqueValue(descriptorValues(tag, 'dim')),
  })).filter(descriptor => descriptor.urls.length > 0)
  const topUrls = event.tags.filter(tag => ['url', 'media', 'r'].includes(tag[0])).map(tag => tag[1]).filter(isUsableMediaUrl)
  const topDurations = event.tags.filter(tag => tag[0] === 'duration').map(tag => tag[1])
  const topDuration = durationSeconds(uniqueValue(topDurations))
  const selected = descriptors.find(descriptor => descriptor.urls.some(isUsableMediaUrl))
  if (selected) {
    // Mobile puts MP4/fallback/HLS aliases for one clip in one descriptor.
    // Keep writer order and the descriptor's own hash rather than rejecting aliases.
    const url = selected.urls.find(isUsableMediaUrl) ?? null
    const localDuration = durationSeconds(uniqueValue(selected.durations))
    const sameSourceGroup = descriptors.every(descriptor => descriptor.hash === selected.hash &&
      descriptor.urls.length === selected.urls.length && descriptor.urls.every(value => selected.urls.includes(value)))
    const eventDurationApplies = sameSourceGroup && topUrls.every(value => selected.urls.includes(value))
    let duration = selected.durations.length ? localDuration : eventDurationApplies ? topDuration : null

    // Event-level measured duration is authoritative for one source group only.
    // It cannot override conflicting local metadata or qualify another rendition.
    if (topDurations.length && (topDuration === null || (localDuration !== null && topDuration !== localDuration))) duration = null
    const overlapping = descriptors.filter(descriptor => descriptor.urls.some(value => selected.urls.includes(value)))
    if (overlapping.some(descriptor => descriptor.hash !== selected.hash ||
      (descriptor.durations.length > 0 && (durationSeconds(uniqueValue(descriptor.durations)) === null ||
        (duration !== null && durationSeconds(uniqueValue(descriptor.durations)) !== duration))))) duration = null
    const dimensions = overlapping.some(descriptor => descriptor.dimensions !== selected.dimensions) ? null : selected.dimensions
    return { url, hash: selected.hash, duration, dimensions }
  }

  // Legacy events without a usable imeta source keep top-level URL/hash support.
  // A top-level duration is authoritative only for one unambiguous media URL.
  const url = topUrls[0] ?? null
  const hash = uniqueValue(event.tags.filter(tag => ['x', 'sha256', 'hash'].includes(tag[0])).map(tag => tag[1]))
  const sameSourceGroup = descriptors.every(descriptor => descriptor.hash === hash &&
    (descriptor.durations.length === 0 || durationSeconds(uniqueValue(descriptor.durations)) === topDuration))
  return { url, hash, dimensions: new Set(topUrls).size === 1 && descriptors.length === 0 ? uniqueValue(event.tags.filter(tag => tag[0] === 'dim').map(tag => tag[1])) : null, duration: new Set(topUrls).size === 1 && sameSourceGroup ? topDuration : null }
}

function isArchiveLabeled(event: DivineVideoEvent): boolean {
  return event.tags.some((tag) => {
    const [name, value] = tag
    return (
      (name === 'L' && value === 'archive.divine.video') ||
      (name === 'l' && value === 'vine-archive') ||
      (name === 't' && value === 'vine-archive')
    )
  })
}

function isRepost(event: DivineVideoEvent): boolean {
  return event.kind === 16 || event.tags.some((tag) => tag[0] === 'k' && tag[1] === String(VIDEO_KIND) && tag[2] === 'repost')
}

function validateEvent(lookup: DivineVideoLookup | null, pubkey: string, eventId: string): SourceSnapshot {
  if (!lookup) {
    throw new HttpError(404, 'not_found', 'video event not found')
  }
  const event = lookup.event
  if (event.pubkey.toLowerCase() !== pubkey) {
    throw new HttpError(403, 'not_owner', 'video does not belong to authenticated user')
  }
  if (event.id.toLowerCase() !== eventId || event.kind !== VIDEO_KIND || isArchiveLabeled(event) || isRepost(event)) {
    throw new HttpError(400, 'not_eligible', 'video is not eligible for crossposting')
  }

  const media = selectedMedia(event)
  const { url, hash } = media
  if (!url || !hash) {
    throw new HttpError(400, 'not_eligible', 'video is missing media url or hash')
  }

  return {
    sourceMedia: media.duration !== null && media.dimensions && /^\d+x\d+$/.test(media.dimensions) ? { durationSeconds: media.duration, width: Number(media.dimensions.split('x')[0]), height: Number(media.dimensions.split('x')[1]) } : null,
    durationSeconds: media.duration,
    title: tagValue(event.tags, 'title')?.trim() || null,
    mediaUrl: url,
    mediaHash: hash,
    caption: event.content.trim() || tagValue(event.tags, 'summary')?.trim() || tagValue(event.tags, 'title')?.trim() || '',
    createdAt: event.created_at,
    authorName: lookup.authorName,
  }
}

export async function getTikTokSourcePreview(env: Env, pubkey: string, eventIdValue: string) {
  const eventId = ensureEventId(eventIdValue)
  const source = validateEvent(await fetchVideoEvent(env, eventId), pubkey, eventId)
  if (source.durationSeconds === null) throw new HttpError(400, 'not_eligible', 'Video has no valid duration metadata; TikTok posting is unavailable')
  return { caption: source.caption, mediaUrl: source.mediaUrl, durationSeconds: source.durationSeconds }
}

function uniquePlatforms(platforms: string[]): Platform[] {
  return [...new Set(platforms.map(parsePlatform))]
}

async function enqueueNewJobs(env: Env, createdJobs: JobRecord[]): Promise<void> {
  for (const job of createdJobs) {
    await env.CROSSPOST_QUEUE.send({ jobId: job.id })
  }
}

async function createJobsForConnections(
  env: Env,
  input: {
    pubkey: string
    eventId: string
    snapshot: SourceSnapshot
    automatic?: boolean
    connections: ConnectionRecord[]
    snapchatDestination?: SnapchatDestination | null
    instagramDestination?: InstagramDestination | null
    tiktokPostOptions?: TikTokPostOptions
    youtubePrivacyStatus?: YouTubePrivacyStatus | null
  },
): Promise<CrosspostJobsResult> {
  const now = Math.floor(Date.now() / 1_000)
  const jobs: JobRecord[] = []
  const createdJobs: JobRecord[] = []

  for (const connection of input.connections) {
    let eligibilityError: string | null = null
    if (connection.platform === 'snapchat') {
      if (asRecord(asRecord(JSON.parse(connection.metadataJson || '{}')).account).profileConfirmed !== true) throw new HttpError(400, 'not_eligible', 'Confirm your Snapchat public profile before posting')
      try { validateSnapchatMedia(input.snapchatDestination ?? 'spotlight', input.snapshot.sourceMedia) } catch (error) {
        eligibilityError = error instanceof Error ? error.message : 'Snapchat video is not eligible'
        if (!input.automatic) throw new HttpError(400, 'not_eligible', eligibilityError)
      }
    }
    const result = await createOrGetJob(env.DB, {
      ...(connection.platform === 'snapchat' ? { snapchatDestination: input.snapchatDestination ?? 'spotlight', sourceMedia: input.snapshot.sourceMedia } : {}),
      ...(connection.platform === 'tiktok' ? { tiktokPostOptions: input.tiktokPostOptions } : {}),
      ...(connection.platform === 'youtube' ? {
        youtubePrivacyStatus: input.youtubePrivacyStatus ?? parseYouTubePrivacyStatus(env.YOUTUBE_DEFAULT_PRIVACY_STATUS),
        youtubeTitle: youtubeTitle(input.snapshot.title || input.snapshot.caption),
      } : {}),
      instagramDestination: connection.platform === 'instagram' ? input.instagramDestination : undefined,
      id: `job_${generateRandomId()}`,
      pubkey: input.pubkey,
      videoEventId: input.eventId,
      platform: connection.platform,
      connectionId: connection.id,
      externalAccountId: connection.externalAccountId,
      sourceMediaUrl: input.snapshot.mediaUrl,
      sourceMediaHash: input.snapshot.mediaHash,
      // TikTok text was explicitly edited/confirmed; preserve it exactly.
      // Snapchat carries the source link as a post attachment, so Spotlight
      // gets only the first 160 characters of text. Other providers retain
      // their existing enqueue-time attribution.
      caption: connection.platform === 'snapchat' ? [...input.snapshot.caption].slice(0, 160).join('') : connection.platform === 'tiktok' && input.tiktokPostOptions ? input.tiktokPostOptions.confirmedCaption : buildCrosspostCaption({
        caption: input.snapshot.caption,
        eventId: input.eventId,
        authorName: input.snapshot.authorName,
        platform: connection.platform,
        template: env.CROSSPOST_ATTRIBUTION_TEMPLATE,
      }),
      status: eligibilityError ? 'failed' : 'queued',
      errorCode: eligibilityError ? 'not_eligible' : null,
      errorMessage: eligibilityError,
      expiresAt: now + JOB_EXPIRATION_SECONDS,
      createdAt: now,
      updatedAt: now,
    })
    jobs.push(result.job)
    if (result.created && !eligibilityError) {
      createdJobs.push(result.job)
    }
  }

  await enqueueNewJobs(env, createdJobs)
  return { jobs }
}

async function requireManualConnection(env: Env, pubkey: string, platform: Platform): Promise<ConnectionRecord> {
  if (!getAdapter(env, platform)) {
    throw new HttpError(400, 'not_connected', 'platform is not enabled')
  }
  const connection = await getActiveConnectionForPlatform(env.DB, pubkey, platform)
  if (!connection) {
    throw new HttpError(400, 'not_connected', 'platform is not connected')
  }
  return connection
}

export async function createManualCrossposts(
  env: Env,
  input: { pubkey: string; eventId: string; platforms: string[]; snapchatProfile?: unknown; snapchatDestination?: unknown; instagramDestination?: unknown; youtubePrivacyStatus?: unknown; tiktokPostOptions?: unknown },
): Promise<CrosspostJobsResult> {
  const eventId = ensureEventId(input.eventId)
  if (!Array.isArray(input.platforms) || input.platforms.length === 0) {
    throw new HttpError(400, 'invalid_platform', 'at least one platform is required')
  }

  const platforms = uniquePlatforms(input.platforms)
  const snapOverride = parseSnapchatDestination(input.snapchatDestination, platforms.includes('snapchat'))
  const override = parseInstagramDestination(input.instagramDestination, platforms.includes('instagram'))
  const youtubeOverride = parseYouTubePrivacyOption(input.youtubePrivacyStatus, platforms.includes('youtube'))
  const connections = await Promise.all(platforms.map((platform) => requireManualConnection(env, input.pubkey, platform)))
  const snapchatConnection = connections.find(connection => connection.platform === 'snapchat')
  if (snapchatConnection) {
    const confirmed = asRecord(input.snapchatProfile)
    if (confirmed.connectionId !== snapchatConnection.id || confirmed.profileId !== snapchatConnection.externalAccountId) {
      throw new HttpError(409, 'snapchat_profile_changed', 'Your Snapchat public profile changed. Reload and confirm the selected profile before posting.')
    }
  } else if (input.snapchatProfile !== undefined) {
    throw new HttpError(400, 'not_eligible', 'Snapchat profile confirmation requires a Snapchat destination')
  }
  const snapshot = validateEvent(await fetchVideoEvent(env, eventId), input.pubkey, eventId)
  if (input.tiktokPostOptions !== undefined && !platforms.includes('tiktok')) throw new HttpError(400, 'not_eligible', 'TikTok options require a TikTok destination')
  const tiktokConnection = connections.find(connection => connection.platform === 'tiktok')
  const tiktokPostOptions = tiktokConnection ? await confirmTikTokOptions(env, tiktokConnection, input.tiktokPostOptions, snapshot.durationSeconds) : undefined
  const preferences = await getPreferences(env.DB, input.pubkey)
  const saved = preferences.find((preference) => preference.platform === 'instagram')
  return createJobsForConnections(env, { pubkey: input.pubkey, eventId, snapshot, connections, snapchatDestination: snapOverride ?? preferences.find(p => p.platform === 'snapchat')?.snapchatDestination, tiktokPostOptions, instagramDestination: override ?? saved?.instagramDestination, youtubePrivacyStatus: youtubeOverride ?? preferences.find((preference) => preference.platform === 'youtube')?.youtubePrivacyStatus })
}

function isAutomaticPreference(preference: PreferenceRecord): boolean {
  return preference.platform !== 'tiktok' && preference.mode === 'automatic' && preference.connectionId !== null
}

export async function createAutomaticCrossposts(
  env: Env,
  input: { pubkey: string; eventId: string },
): Promise<CrosspostJobsResult> {
  const eventId = ensureEventId(input.eventId)
  const snapshot = validateEvent(await fetchVideoEvent(env, eventId), input.pubkey, eventId)
  const preferences = (await getPreferences(env.DB, input.pubkey)).filter(isAutomaticPreference)
  const connections: ConnectionRecord[] = []

  for (const preference of preferences) {
    if (!getAdapter(env, preference.platform)) {
      continue
    }
    if (preference.automaticEnabledAt !== null && snapshot.createdAt < preference.automaticEnabledAt) {
      continue
    }
    const connection = await getConnection(env.DB, preference.connectionId as string, input.pubkey)
    if (connection?.status === 'connected' && (connection.platform !== 'snapchat' || asRecord(asRecord(JSON.parse(connection.metadataJson || '{}')).account).profileConfirmed === true)) {
      connections.push(connection)
    }
  }

  return createJobsForConnections(env, { pubkey: input.pubkey, eventId, snapshot, connections, automatic: true, snapchatDestination: preferences.find(p => p.platform === 'snapchat')?.snapchatDestination, instagramDestination: preferences.find((preference) => preference.platform === 'instagram')?.instagramDestination, youtubePrivacyStatus: preferences.find((preference) => preference.platform === 'youtube')?.youtubePrivacyStatus })
}

export async function listVideoCrossposts(
  env: Env,
  input: { pubkey: string; eventId: string },
): Promise<CrosspostJobsResult> {
  return { jobs: await listJobsForVideo(env.DB, input.pubkey, ensureEventId(input.eventId)) }
}

export async function getCrosspostJob(
  env: Env,
  input: { pubkey: string; jobId: string },
): Promise<JobWithAttemptsResult> {
  const job = await getJob(env.DB, input.jobId, input.pubkey)
  if (!job) {
    throw new HttpError(404, 'not_found', 'job not found')
  }
  const attempts = (await listAttempts(env.DB, job.id)).map(
    ({ id, jobId, status, errorCode, errorMessage, providerStatus, createdAt }): PublicJobAttempt => ({
      id,
      jobId,
      status,
      errorCode,
      errorMessage,
      providerStatus,
      createdAt,
    }),
  )
  return { job, attempts }
}

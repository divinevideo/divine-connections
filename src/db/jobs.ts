// ABOUTME: Stores crosspost jobs and controls their publishing lifecycle.
// ABOUTME: Preserves existing opt-in and provider isolation guarantees.
import { allPrepared, changes, firstPrepared, runPrepared } from './client'
import type { ConnectionRecord, SnapchatDestination, CreateJobInput, ErrorCode, InstagramDestination, JobRecord, JobStatus, Platform, UpdateJobStatusInput, YouTubePrivacyStatus } from '../types'

export const MAX_RETRY_COUNT = 5

type JobRow = {
  snapchat_destination?: SnapchatDestination | null
  snapchat_source_json?: string | null
  tiktok_options_json?: string | null
  youtube_privacy_status?: YouTubePrivacyStatus | null
  youtube_title?: string | null
  instagram_destination?: InstagramDestination | null
  id: string
  pubkey: string
  video_event_id: string
  platform: Platform
  connection_id: string
  external_account_id: string
  source_media_url: string
  source_media_hash: string
  caption: string
  status: JobStatus
  error_code: ErrorCode | null
  error_message: string | null
  external_post_id: string | null
  external_post_url: string | null
  retry_count: number
  next_retry_at: number | null
  expires_at: number
  created_at: number
  updated_at: number
}

function mapJob(row: JobRow): JobRecord {
  return {
    ...(row.platform === 'snapchat' ? { snapchatDestination: row.snapchat_destination ?? null, sourceMedia: row.snapchat_source_json ? JSON.parse(row.snapchat_source_json) : null } : {}),
    instagramDestination: row.instagram_destination ?? null,
    ...(row.platform === 'tiktok' ? { tiktokPostOptions: row.tiktok_options_json ? JSON.parse(row.tiktok_options_json) : null } : {}),
    ...(row.platform === 'youtube' ? { youtubePrivacyStatus: row.youtube_privacy_status ?? null, youtubeTitle: row.youtube_title ?? null } : {}),
    id: row.id,
    pubkey: row.pubkey,
    videoEventId: row.video_event_id,
    platform: row.platform,
    connectionId: row.connection_id,
    externalAccountId: row.external_account_id,
    sourceMediaUrl: row.source_media_url,
    sourceMediaHash: row.source_media_hash,
    caption: row.caption,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    externalPostId: row.external_post_id,
    externalPostUrl: row.external_post_url,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function findByIdempotencyKey(db: D1Database, input: CreateJobInput): Promise<JobRecord | null> {
  const row = await firstPrepared<JobRow>(
    db,
    `SELECT *, (SELECT destination FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_destination, (SELECT source_media_json FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_source_json, (SELECT options_json FROM tiktok_job_options WHERE job_id = jobs.id) AS tiktok_options_json, (SELECT destination FROM instagram_job_options WHERE job_id = jobs.id) AS instagram_destination, (SELECT privacy_status FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_privacy_status, (SELECT title FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_title FROM jobs
    WHERE pubkey = ? AND video_event_id = ? AND platform = ? AND external_account_id = ?`,
    input.pubkey,
    input.videoEventId,
    input.platform,
    input.externalAccountId,
  )
  return row ? mapJob(row) : null
}

export async function createOrGetJob(
  db: D1Database,
  input: CreateJobInput,
): Promise<{ job: JobRecord; created: boolean }> {
  const existing = await findByIdempotencyKey(db, input)
  if (existing) {
    return { job: existing, created: false }
  }

  const statement = db.prepare(
    `INSERT OR IGNORE INTO jobs (
      id, pubkey, video_event_id, platform, connection_id, external_account_id,
      source_media_url, source_media_hash, caption, status, error_code, error_message,
      external_post_id, external_post_url, retry_count, next_retry_at, expires_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.id,
    input.pubkey,
    input.videoEventId,
    input.platform,
    input.connectionId,
    input.externalAccountId,
    input.sourceMediaUrl,
    input.sourceMediaHash,
    input.caption,
    input.status,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    input.externalPostId ?? null,
    input.externalPostUrl ?? null,
    input.retryCount ?? 0,
    input.nextRetryAt ?? null,
    input.expiresAt,
    input.createdAt,
    input.updatedAt,
  )

  const statements = [statement]
  if (input.platform === 'instagram' && input.instagramDestination != null) {
    statements.push(db.prepare(`INSERT INTO instagram_job_options (job_id, destination)
      SELECT ?, ? WHERE changes() = 1`)
      .bind(input.id, input.instagramDestination))
  }
  if (input.platform === 'youtube' && input.youtubePrivacyStatus != null) {
    statements.push(db.prepare(`INSERT INTO youtube_job_options (job_id, privacy_status, title)
      SELECT ?, ?, ? WHERE changes() = 1`)
      .bind(input.id, input.youtubePrivacyStatus, input.youtubeTitle ?? null))
  }
  if (input.platform === 'tiktok' && input.tiktokPostOptions != null) {
    statements.push(db.prepare(`INSERT INTO tiktok_job_options (job_id, options_json)
      SELECT ?, ? WHERE changes() = 1`).bind(input.id, JSON.stringify(input.tiktokPostOptions)))
  }
  if (input.platform === 'snapchat' && input.snapchatDestination != null) {
    statements.push(db.prepare(`INSERT INTO snapchat_job_options (job_id, destination, source_media_json) SELECT ?, ?, ? WHERE changes() = 1`).bind(input.id, input.snapchatDestination, JSON.stringify(input.sourceMedia ?? null)))
  }
  const [result] = await db.batch(statements)

  const job = changes(result) > 0 ? await getJob(db, input.id) : await findByIdempotencyKey(db, input)
  if (!job) {
    throw new Error('failed to create or find job')
  }
  return { job, created: changes(result) > 0 }
}

export async function listJobsForVideo(
  db: D1Database,
  pubkey: string,
  videoEventId: string,
): Promise<JobRecord[]> {
  const rows = await allPrepared<JobRow>(
    db,
    `SELECT *, (SELECT destination FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_destination, (SELECT source_media_json FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_source_json, (SELECT options_json FROM tiktok_job_options WHERE job_id = jobs.id) AS tiktok_options_json, (SELECT destination FROM instagram_job_options WHERE job_id = jobs.id) AS instagram_destination, (SELECT privacy_status FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_privacy_status, (SELECT title FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_title FROM jobs
    WHERE pubkey = ? AND video_event_id = ?
    ORDER BY created_at ASC, id ASC`,
    pubkey,
    videoEventId,
  )
  return rows.map(mapJob)
}

export async function getJob(db: D1Database, id: string, pubkey?: string): Promise<JobRecord | null> {
  const row = pubkey
    ? await firstPrepared<JobRow>(db, 'SELECT *, (SELECT destination FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_destination, (SELECT source_media_json FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_source_json, (SELECT options_json FROM tiktok_job_options WHERE job_id = jobs.id) AS tiktok_options_json, (SELECT destination FROM instagram_job_options WHERE job_id = jobs.id) AS instagram_destination, (SELECT privacy_status FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_privacy_status, (SELECT title FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_title FROM jobs WHERE id = ? AND pubkey = ?', id, pubkey)
    : await firstPrepared<JobRow>(db, 'SELECT *, (SELECT destination FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_destination, (SELECT source_media_json FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_source_json, (SELECT options_json FROM tiktok_job_options WHERE job_id = jobs.id) AS tiktok_options_json, (SELECT destination FROM instagram_job_options WHERE job_id = jobs.id) AS instagram_destination, (SELECT privacy_status FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_privacy_status, (SELECT title FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_title FROM jobs WHERE id = ?', id)
  return row ? mapJob(row) : null
}

export async function updateJobStatus(db: D1Database, input: UpdateJobStatusInput): Promise<void> {
  const { assignments, bindings } = jobStatusUpdate(input)
  bindings.push(input.id)
  await runPrepared(db, `UPDATE jobs SET ${assignments.join(', ')} WHERE id = ?`, ...bindings)
}

function jobStatusUpdate(input: UpdateJobStatusInput): { assignments: string[]; bindings: unknown[] } {
  const assignments = ['status = ?', 'updated_at = ?']
  const bindings: unknown[] = [input.status, input.updatedAt]

  const nullableFields = [
    ['errorCode', 'error_code'],
    ['errorMessage', 'error_message'],
    ['externalPostId', 'external_post_id'],
    ['externalPostUrl', 'external_post_url'],
    ['nextRetryAt', 'next_retry_at'],
  ] as const

  for (const [inputKey, column] of nullableFields) {
    if (Object.prototype.hasOwnProperty.call(input, inputKey)) {
      assignments.push(`${column} = ?`)
      bindings.push(input[inputKey])
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'retryCount')) {
    assignments.push('retry_count = ?')
    bindings.push(input.retryCount)
  }

  return { assignments, bindings }
}

export async function updateClaimedJobStatus(
  db: D1Database,
  input: UpdateJobStatusInput,
  expected: { status: JobStatus; updatedAt: number },
): Promise<JobRecord | null> {
  const { assignments, bindings } = jobStatusUpdate(input)
  const row = await firstPrepared<JobRow>(
    db,
    `UPDATE jobs
    SET ${assignments.join(', ')}
    WHERE id = ? AND status = ? AND updated_at = ?
    RETURNING *, (SELECT destination FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_destination, (SELECT source_media_json FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_source_json, (SELECT options_json FROM tiktok_job_options WHERE job_id = jobs.id) AS tiktok_options_json, (SELECT destination FROM instagram_job_options WHERE job_id = jobs.id) AS instagram_destination, (SELECT privacy_status FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_privacy_status, (SELECT title FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_title`,
    ...bindings,
    input.id,
    expected.status,
    expected.updatedAt,
  )
  return row ? mapJob(row) : null
}

export async function claimJobForPublish(db: D1Database, id: string, now: number): Promise<JobRecord | null> {
  const row = await firstPrepared<JobRow>(
    db,
    `UPDATE jobs
    SET status = 'uploading', updated_at = ?, error_code = NULL, error_message = NULL
    WHERE id = ?
      AND status IN ('queued', 'failed')
      AND expires_at > ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    RETURNING *, (SELECT destination FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_destination, (SELECT source_media_json FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_source_json, (SELECT options_json FROM tiktok_job_options WHERE job_id = jobs.id) AS tiktok_options_json, (SELECT destination FROM instagram_job_options WHERE job_id = jobs.id) AS instagram_destination, (SELECT privacy_status FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_privacy_status, (SELECT title FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_title`,
    now,
    id,
    now,
    now,
  )
  return row ? mapJob(row) : null
}

export async function claimJobForStatusPoll(db: D1Database, id: string, now: number): Promise<JobRecord | null> {
  const row = await firstPrepared<JobRow>(
    db,
    `UPDATE jobs
    SET status = 'uploading', updated_at = ?, error_code = NULL, error_message = NULL
    WHERE id = ?
      AND status = 'processing'
      AND expires_at > ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    RETURNING *, (SELECT destination FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_destination, (SELECT source_media_json FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_source_json, (SELECT options_json FROM tiktok_job_options WHERE job_id = jobs.id) AS tiktok_options_json, (SELECT destination FROM instagram_job_options WHERE job_id = jobs.id) AS instagram_destination, (SELECT privacy_status FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_privacy_status, (SELECT title FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_title`,
    now,
    id,
    now,
    now,
  )
  return row ? mapJob(row) : null
}

export async function transitionClaimToDispatching(
  db: D1Database,
  id: string,
  claimUpdatedAt: number,
  now: number,
  snapchatConnection?: ConnectionRecord,
): Promise<boolean> {
  if (snapchatConnection) {
    // Consent, credentials and job ownership must still match in the same
    // statement that records dispatch. A separate read leaves a reselection gap.
    const result = await runPrepared(db, `UPDATE jobs
      SET status = 'dispatching', updated_at = ?, error_code = NULL,
          error_message = NULL, next_retry_at = NULL
      WHERE id = ? AND status = 'uploading' AND updated_at = ?
        AND platform = 'snapchat' AND connection_id = ? AND pubkey = ? AND external_account_id = ?
        AND EXISTS (SELECT 1 FROM connections
          WHERE id = jobs.connection_id AND pubkey = jobs.pubkey AND platform = 'snapchat'
            AND external_account_id = jobs.external_account_id AND status = 'connected'
            AND metadata_json = ? AND encrypted_access_token = ?
            AND json_extract(metadata_json, '$.account.profileConfirmed') = 1)`,
      now, id, claimUpdatedAt, snapchatConnection.id, snapchatConnection.pubkey,
      snapchatConnection.externalAccountId, snapchatConnection.metadataJson,
      snapchatConnection.encryptedAccessToken)
    return changes(result) === 1
  }
  const job = await updateClaimedJobStatus(
    db,
    {
      id,
      status: 'dispatching',
      updatedAt: now,
      errorCode: null,
      errorMessage: null,
      nextRetryAt: null,
    },
    { status: 'uploading', updatedAt: claimUpdatedAt },
  )
  return job !== null
}

export async function listRunnableJobs(db: D1Database, now: number, limit: number): Promise<JobRecord[]> {
  const rows = await allPrepared<JobRow>(
    db,
    `SELECT *, (SELECT destination FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_destination, (SELECT source_media_json FROM snapchat_job_options WHERE job_id = jobs.id) AS snapchat_source_json, (SELECT options_json FROM tiktok_job_options WHERE job_id = jobs.id) AS tiktok_options_json, (SELECT destination FROM instagram_job_options WHERE job_id = jobs.id) AS instagram_destination, (SELECT privacy_status FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_privacy_status, (SELECT title FROM youtube_job_options WHERE job_id = jobs.id) AS youtube_title FROM jobs
    WHERE (
        (status IN ('queued', 'processing') AND (next_retry_at IS NULL OR next_retry_at <= ?))
        OR (
          status = 'failed'
          AND next_retry_at IS NOT NULL
          AND next_retry_at <= ?
        )
      )
      AND expires_at > ?
    ORDER BY COALESCE(next_retry_at, created_at) ASC, created_at ASC
    LIMIT ?`,
    now,
    now,
    now,
    limit,
  )
  return rows.map(mapJob)
}

export async function recoverStalePollClaims(
  db: D1Database,
  now: number,
  leaseSeconds: number,
): Promise<{ pollRecovered: number; uploadRecovered: number }> {
  const staleBefore = now - leaseSeconds
  const poll = await runPrepared(
    db,
    `UPDATE jobs
    SET status = CASE WHEN expires_at <= ? THEN 'skipped' ELSE 'processing' END,
        error_code = CASE WHEN expires_at <= ? THEN 'expired' ELSE NULL END,
        error_message = CASE
          WHEN expires_at <= ? THEN 'crosspost job expired during stale claim recovery'
          ELSE NULL
        END,
        next_retry_at = CASE WHEN expires_at <= ? THEN NULL ELSE ? END,
        updated_at = ?
    WHERE platform != 'x' AND status = 'uploading' AND updated_at <= ? AND external_post_id IS NOT NULL`,
    now,
    now,
    now,
    now,
    now,
    now,
    staleBefore,
  )
  const upload = await runPrepared(
    db,
    `UPDATE jobs
    SET status = CASE WHEN expires_at <= ? THEN 'skipped' ELSE 'failed' END,
        error_code = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'unknown_platform_error' END,
        error_message = CASE
          WHEN expires_at <= ? THEN 'crosspost job expired during stale claim recovery'
          ELSE 'stale publish claim recovered before completion'
        END,
        retry_count = CASE WHEN expires_at <= ? THEN retry_count ELSE retry_count + 1 END,
        next_retry_at = CASE
          WHEN expires_at <= ? OR retry_count + 1 > ? THEN NULL
          ELSE ?
        END,
        updated_at = ?
    WHERE platform != 'x' AND status = 'uploading' AND updated_at <= ? AND external_post_id IS NULL`,
    now,
    now,
    now,
    now,
    now,
    MAX_RETRY_COUNT,
    now,
    now,
    staleBefore,
  )
  return { pollRecovered: changes(poll), uploadRecovered: changes(upload) }
}

export async function recoverStaleXClaims(
  db: D1Database,
  now: number,
  leaseSeconds: number,
): Promise<{ uploadingRecovered: number; dispatchingFailed: number }> {
  const staleBefore = now - leaseSeconds
  const uploading = await runPrepared(
    db,
    `UPDATE jobs
    SET status = CASE WHEN expires_at <= ? THEN 'skipped' ELSE 'failed' END,
        error_code = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'unknown_platform_error' END,
        error_message = CASE
          WHEN expires_at <= ? THEN 'crosspost job expired during stale claim recovery'
          ELSE 'stale X upload claim recovered before dispatch'
        END,
        retry_count = CASE WHEN expires_at <= ? THEN retry_count ELSE retry_count + 1 END,
        next_retry_at = CASE
          WHEN expires_at <= ? OR retry_count + 1 > ? THEN NULL
          ELSE ?
        END,
        updated_at = ?
    WHERE platform = 'x' AND status = 'uploading' AND updated_at <= ?`,
    now,
    now,
    now,
    now,
    now,
    MAX_RETRY_COUNT,
    now,
    now,
    staleBefore,
  )
  const dispatching = await runPrepared(
    db,
    `UPDATE jobs
    SET status = 'failed',
        error_code = 'ambiguous_post_result',
        error_message = CASE WHEN platform = 'x' THEN 'stale X dispatch requires manual reconciliation'
          WHEN platform = 'youtube' THEN 'stale YouTube dispatch requires manual reconciliation' WHEN platform = 'snapchat' THEN 'stale Snapchat dispatch requires manual reconciliation' ELSE 'stale TikTok dispatch requires manual reconciliation' END,
        next_retry_at = NULL,
        updated_at = ?
    WHERE platform IN ('x', 'youtube', 'tiktok', 'snapchat') AND status = 'dispatching' AND updated_at <= ?`,
    now,
    staleBefore,
  )
  return { uploadingRecovered: changes(uploading), dispatchingFailed: changes(dispatching) }
}

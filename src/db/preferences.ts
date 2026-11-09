// ABOUTME: Manages authenticated crossposting preferences.
// ABOUTME: Preserves existing opt-in and provider isolation guarantees.
import { allPrepared, firstPrepared } from './client'
import type { SnapchatDestination, InstagramDestination, Platform, PreferenceMode, PreferenceRecord, YouTubePrivacyStatus } from '../types'

type PreferenceRow = {
  snapchat_destination?: SnapchatDestination | null
  youtube_privacy_status?: YouTubePrivacyStatus | null
  instagram_destination?: InstagramDestination | null
  pubkey: string
  platform: Platform
  connection_id: string | null
  mode: PreferenceMode
  automatic_enabled_at: number | null
  created_at: number
  updated_at: number
}

function mapPreference(row: PreferenceRow): PreferenceRecord {
  return {
    ...(row.platform === 'snapchat' ? { snapchatDestination: row.snapchat_destination ?? 'spotlight' } : {}),
    ...(row.platform === 'instagram' ? { instagramDestination: row.instagram_destination ?? null } : {}),
    ...(row.platform === 'youtube' ? { youtubePrivacyStatus: row.youtube_privacy_status ?? null } : {}),
    pubkey: row.pubkey,
    platform: row.platform,
    connectionId: row.connection_id,
    mode: row.mode,
    automaticEnabledAt: row.automatic_enabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function getPreferences(db: D1Database, pubkey: string): Promise<PreferenceRecord[]> {
  const rows = await allPrepared<PreferenceRow>(
    db,
    'SELECT *, (SELECT destination FROM snapchat_preferences WHERE pubkey = preferences.pubkey) AS snapchat_destination, (SELECT destination FROM instagram_preferences WHERE pubkey = preferences.pubkey) AS instagram_destination, (SELECT privacy_status FROM youtube_preferences WHERE pubkey = preferences.pubkey) AS youtube_privacy_status FROM preferences WHERE pubkey = ? ORDER BY platform ASC',
    pubkey,
  )
  return rows.map(mapPreference)
}

export async function setPreference(db: D1Database, input: PreferenceRecord): Promise<PreferenceRecord> {
  const automaticEnabledAt = input.mode === 'automatic' ? input.automaticEnabledAt ?? input.updatedAt : null

  const statement = db.prepare(
    `INSERT INTO preferences (
      pubkey, platform, connection_id, mode, automatic_enabled_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pubkey, platform) DO UPDATE SET
      connection_id = excluded.connection_id,
      mode = excluded.mode,
      automatic_enabled_at = excluded.automatic_enabled_at,
      updated_at = excluded.updated_at`).bind(
    input.pubkey,
    input.platform,
    input.connectionId,
    input.mode,
    automaticEnabledAt,
    input.createdAt,
    input.updatedAt,
  )

  const statements = [statement]
  if (input.platform === 'instagram' && input.instagramDestination != null) {
    statements.push(db.prepare(`INSERT INTO instagram_preferences (pubkey, destination, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(pubkey) DO UPDATE SET destination = excluded.destination, updated_at = excluded.updated_at`)
      .bind(input.pubkey, input.instagramDestination, input.updatedAt))
  }
  if (input.platform === 'youtube' && input.youtubePrivacyStatus != null) {
    statements.push(db.prepare(`INSERT INTO youtube_preferences (pubkey, privacy_status, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(pubkey) DO UPDATE SET privacy_status = excluded.privacy_status, updated_at = excluded.updated_at`)
      .bind(input.pubkey, input.youtubePrivacyStatus, input.updatedAt))
  }
  if (input.platform === 'snapchat' && input.snapchatDestination != null) {
    statements.push(db.prepare(`INSERT INTO snapchat_preferences (pubkey, destination, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(pubkey) DO UPDATE SET destination = excluded.destination, updated_at = excluded.updated_at`).bind(input.pubkey, input.snapchatDestination, input.updatedAt))
  }
  await db.batch(statements)

  const row = await firstPrepared<PreferenceRow>(
    db,
    'SELECT *, (SELECT destination FROM snapchat_preferences WHERE pubkey = preferences.pubkey) AS snapchat_destination, (SELECT destination FROM instagram_preferences WHERE pubkey = preferences.pubkey) AS instagram_destination, (SELECT privacy_status FROM youtube_preferences WHERE pubkey = preferences.pubkey) AS youtube_privacy_status FROM preferences WHERE pubkey = ? AND platform = ?',
    input.pubkey,
    input.platform,
  )
  if (!row) {
    throw new Error('failed to set preference')
  }
  return mapPreference(row)
}

export function disablePreferenceForConnectionStatement(
  db: D1Database,
  input: { pubkey: string; platform: Platform; connectionId: string; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE preferences
       SET connection_id = NULL, mode = 'disabled', automatic_enabled_at = NULL, updated_at = ?
       WHERE pubkey = ? AND platform = ? AND connection_id = ?`,
    )
    .bind(input.now, input.pubkey, input.platform, input.connectionId)
}

export async function listAutomaticPreferences(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<PreferenceRecord[]> {
  const rows = await allPrepared<PreferenceRow>(
    db,
    `SELECT *, (SELECT destination FROM snapchat_preferences WHERE pubkey = preferences.pubkey) AS snapchat_destination, (SELECT destination FROM instagram_preferences WHERE pubkey = preferences.pubkey) AS instagram_destination, (SELECT privacy_status FROM youtube_preferences WHERE pubkey = preferences.pubkey) AS youtube_privacy_status FROM preferences
    WHERE mode = 'automatic' AND platform != 'tiktok'
    ORDER BY updated_at ASC, pubkey ASC, platform ASC
    LIMIT ? OFFSET ?`,
    limit,
    offset,
  )
  return rows.map(mapPreference)
}

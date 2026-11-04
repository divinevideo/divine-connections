// ABOUTME: Lists and confirms authorized Snapchat public profiles for their Divine owner.
// ABOUTME: Uses refreshed encrypted credentials and atomic selection without silent profile changes.
import { getConnection } from '../db/connections'
import { fetchSnapchatProfiles } from '../platforms/snapchat'
import { asRecord, PlatformAdapterError } from '../platforms/adapter'
import { getAdapter } from '../platforms/registry'
import { usableConnectionToken } from './connection-token'
import { recordDiagnosticSafely } from './reliability'
import { HttpError } from '../utils/http'
import type { Env } from '../types'

async function discover(env: Env, pubkey: string, connectionId: string) {
  if (!getAdapter(env, 'snapchat')) throw new HttpError(400, 'not_connected', 'Snapchat Public Profile publishing is unavailable; app access must be approved')
  const initial = await getConnection(env.DB, connectionId, pubkey)
  if (!initial || initial.platform !== 'snapchat' || initial.status !== 'connected') throw new HttpError(404, 'not_connected', 'Snapchat connection not found')
  try {
    const token = await usableConnectionToken(env, initial)
    const current = await getConnection(env.DB, connectionId, pubkey)
    if (!current || current.status !== 'connected' || current.externalAccountId !== initial.externalAccountId) throw new HttpError(409, 'connection_changed', 'Snapchat connection changed; try again')
    return { connection: current, profiles: await fetchSnapchatProfiles(token) }
  } catch (error) {
    await recordDiagnosticSafely(env, { reference: connectionId, platform: 'snapchat', operation: 'connect', stage: 'profile_selection', outcome: 'failed', now: Math.floor(Date.now()/1000), error })
    if (error instanceof PlatformAdapterError) throw new HttpError(error.code === 'needs_reauth' ? 401 : error.code === 'rate_limited' ? 429 : 503, error.code, error.message)
    throw error
  }
}
export async function listSnapchatProfiles(env: Env, pubkey: string, connectionId: string) {
  const { connection, profiles } = await discover(env, pubkey, connectionId)
  return { connectionId, selectedProfileId: asRecord(asRecord(JSON.parse(connection.metadataJson || '{}')).account).profileConfirmed === true ? connection.externalAccountId : null,
    profiles: profiles.map(profile => ({ id: profile.id, name: profile.name, displayName: profile.metadata.displayName })) }
}
export async function confirmSnapchatProfile(env: Env, pubkey: string, connectionId: string, body: unknown) {
  const input = asRecord(body)
  if (input.confirmed !== true || typeof input.profileId !== 'string') throw new HttpError(400, 'not_eligible', 'Choose and explicitly confirm your Snapchat public profile')
  const { connection, profiles } = await discover(env, pubkey, connectionId)
  const selected = profiles.find(profile => profile.id === input.profileId)
  if (!selected) throw new HttpError(400, 'not_eligible', 'Choose a currently authorized Snapchat public profile')
  const now = Math.floor(Date.now()/1000)
  const metadata = JSON.stringify({ ...asRecord(JSON.parse(connection.metadataJson || '{}')), account: { ...selected.metadata, profileConfirmed: true } })
  const existing = await env.DB.prepare("SELECT id FROM connections WHERE pubkey = ? AND platform = 'snapchat' AND external_account_id = ?").bind(pubkey, selected.id).first<{ id: string }>()
  const selectedConnectionId = existing?.id ?? connectionId
  const reuseExisting = selectedConnectionId !== connectionId
  const statements: D1PreparedStatement[] = []
  if (reuseExisting) {
    // Reconnecting the own-profile OAuth identity can lead back to an already
    // stored organization profile. Transfer only this owner's refreshed grant,
    // retaining the selected profile's connection ID and immutable job references.
    statements.push(env.DB.prepare(`UPDATE connections SET status = 'disconnected', updated_at = ?
      WHERE id = ? AND pubkey = ? AND platform = 'snapchat' AND status = 'connected' AND external_account_id = ? AND encrypted_access_token = ? AND metadata_json = ?
      AND EXISTS (SELECT 1 FROM connections WHERE id = ? AND pubkey = ? AND external_account_id = ?)`)
      .bind(now, connectionId, pubkey, connection.externalAccountId, connection.encryptedAccessToken, connection.metadataJson, selectedConnectionId, pubkey, selected.id))
    statements.push(env.DB.prepare(`UPDATE connections SET external_account_name = ?, metadata_json = ?, updated_at = ?, encrypted_access_token = ?, encrypted_refresh_token = ?, token_expires_at = ?, granted_scopes = ?, status = 'connected'
      WHERE id = ? AND pubkey = ? AND platform = 'snapchat' AND external_account_id = ? AND changes() = 1`)
      .bind(selected.name, metadata, now, connection.encryptedAccessToken, connection.encryptedRefreshToken, connection.tokenExpiresAt, connection.grantedScopes, selectedConnectionId, pubkey, selected.id))
  } else {
    statements.push(env.DB.prepare(`UPDATE connections SET external_account_id = ?, external_account_name = ?, metadata_json = ?, updated_at = ?
      WHERE id = ? AND pubkey = ? AND platform = 'snapchat' AND status = 'connected' AND external_account_id = ? AND encrypted_access_token = ? AND metadata_json = ?`)
      .bind(selected.id, selected.name, metadata, now, connectionId, pubkey, connection.externalAccountId, connection.encryptedAccessToken, connection.metadataJson))
  }
  // Changing the selected profile pauses automatic posting. D1 executes this
  // batch transactionally, and each state change is guarded by the preceding CAS.
  statements.push(
    env.DB.prepare(`INSERT INTO preferences (pubkey, platform, connection_id, mode, automatic_enabled_at, created_at, updated_at)
      SELECT ?, 'snapchat', ?, 'manual', NULL, ?, ? WHERE changes() = 1
      ON CONFLICT(pubkey, platform) DO UPDATE SET connection_id = excluded.connection_id, mode = 'manual', automatic_enabled_at = NULL, updated_at = excluded.updated_at`).bind(pubkey, selectedConnectionId, now, now),
    env.DB.prepare(`UPDATE verifications SET revoked_at = ? WHERE connection_id IN (?, ?) AND pubkey = ? AND changes() = 1`).bind(now, connectionId, selectedConnectionId, pubkey),
    env.DB.prepare(`INSERT INTO verifications (pubkey, platform, identity, identity_key, method, proof_url, connection_id, verified_at, revoked_at)
      SELECT ?, 'snapchat', ?, ?, 'oauth', NULL, ?, ?, NULL WHERE EXISTS (SELECT 1 FROM connections WHERE id = ? AND pubkey = ? AND status = 'connected' AND metadata_json = ? AND external_account_id = ?)
      ON CONFLICT(pubkey, platform, identity_key) DO UPDATE SET connection_id = excluded.connection_id, verified_at = excluded.verified_at, revoked_at = NULL`)
      .bind(pubkey, selected.id, selected.id.toLowerCase(), selectedConnectionId, now, selectedConnectionId, pubkey, metadata, selected.id),
  )
  const results = await env.DB.batch(statements)
  if (results[0].meta.changes !== 1 || (reuseExisting && results[1].meta.changes !== 1)) throw new HttpError(409, 'connection_changed', 'Snapchat connection changed; reload and confirm again')
  // The OAuth projection uses the stable authorized profile ID, never its display label.
  await recordDiagnosticSafely(env, { reference: connectionId, platform: 'snapchat', operation: 'connect', stage: 'profile_confirmed', outcome: 'succeeded', now })
  return { connectionId: selectedConnectionId, profileId: selected.id, name: selected.name, confirmed: true }
}

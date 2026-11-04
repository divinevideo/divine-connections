// ABOUTME: Obtains a usable token without a publish job or exposing secrets to callers.
// ABOUTME: Persists refreshes only while the same owner, selection and credentials still match.
import { recordDiagnosticSafely } from './reliability'
import { getConnection } from '../db/connections'
import { getAdapter } from '../platforms/registry'
import { PlatformAdapterError } from '../platforms/adapter'
import type { ConnectionRecord, Env, Platform } from '../types'
import { decryptToken, encryptToken } from '../utils/crypto'

/** The helper already guarded connection state; callers may update the job only. */
export class ConnectionTokenReauthError extends PlatformAdapterError {
  constructor(platform: Platform, message: string, providerStatus?: number) {
    super(platform, 'needs_reauth', message, providerStatus)
  }
}

/** Snapchat metadata contains the selected profile confirmation revision. */
export function sameConnectionSelection(expected: ConnectionRecord, current: ConnectionRecord): boolean {
  return current.id === expected.id &&
    current.pubkey === expected.pubkey &&
    current.platform === expected.platform &&
    current.externalAccountId === expected.externalAccountId &&
    (expected.platform !== 'snapchat' || current.metadataJson === expected.metadataJson)
}

export type ConnectionCredentials = { accessToken: string; connection: ConnectionRecord }

async function winningConnectionToken(env: Env, previous: ConnectionRecord, now: number): Promise<ConnectionCredentials | null> {
  const winner = await getConnection(env.DB, previous.id, previous.pubkey)
  if (!winner || winner.status !== 'connected' || !sameConnectionSelection(previous, winner)) return null
  if (winner.encryptedAccessToken === previous.encryptedAccessToken) return null
  if (winner.tokenExpiresAt !== null && winner.tokenExpiresAt <= now + 60) return null
  return { accessToken: await decryptToken(winner.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY), connection: winner }
}

/** A denial of old credentials must not invalidate a reconnect or profile selection. */
export async function markConnectionCredentialsRejected(env: Env, current: ConnectionRecord, now: number): Promise<void> {
  await env.DB.prepare(`UPDATE connections SET status = 'needs_reauth', updated_at = ?
    WHERE id = ? AND pubkey = ? AND platform = ? AND external_account_id = ?
      AND status = 'connected' AND encrypted_access_token = ? AND encrypted_refresh_token IS ?
      AND (? != 'snapchat' OR metadata_json = ?)`)
    .bind(now, current.id, current.pubkey, current.platform, current.externalAccountId,
      current.encryptedAccessToken, current.encryptedRefreshToken, current.platform, current.metadataJson).run()
}

export async function usableConnectionToken(env: Env, connection: ConnectionRecord, now = Math.floor(Date.now() / 1000)): Promise<string> {
  return (await usableConnectionCredentials(env, connection, now)).accessToken
}

/** Return the exact persisted revision used, including a successful or winning refresh. */
export async function usableConnectionCredentials(env: Env, connection: ConnectionRecord, now = Math.floor(Date.now() / 1000)): Promise<ConnectionCredentials> {
  const current = await getConnection(env.DB, connection.id, connection.pubkey)
  if (!current || current.status !== 'connected' || !sameConnectionSelection(connection, current)) {
    throw new ConnectionTokenReauthError(connection.platform, 'Reconnect the platform account')
  }
  if (current.tokenExpiresAt === null || current.tokenExpiresAt > now + 60) {
    return { accessToken: await decryptToken(current.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY), connection: current }
  }
  if (!current.encryptedRefreshToken) {
    await markConnectionCredentialsRejected(env, current, now)
    const winner = await winningConnectionToken(env, current, now)
    if (winner) return winner
    throw new ConnectionTokenReauthError(current.platform, 'Reconnect the platform account')
  }

  const adapter = getAdapter(env, current.platform)
  if (!adapter) throw new PlatformAdapterError(current.platform, 'not_connected', 'Platform is not enabled')
  try {
    const tokens = await adapter.refreshToken({
      refreshToken: await decryptToken(current.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY),
    })
    const encryptedAccess = await encryptToken(tokens.accessToken, env.TOKEN_ENCRYPTION_KEY)
    const encryptedRefresh = tokens.refreshToken
      ? await encryptToken(tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY)
      : current.encryptedRefreshToken
    const result = await env.DB.prepare(`UPDATE connections
      SET encrypted_access_token = ?, encrypted_refresh_token = ?, token_expires_at = ?, last_refresh_at = ?, updated_at = ?
      WHERE id = ? AND pubkey = ? AND platform = ? AND external_account_id = ?
        AND status = 'connected' AND encrypted_access_token = ? AND encrypted_refresh_token = ?
        AND (? != 'snapchat' OR metadata_json = ?)`)
      .bind(encryptedAccess, encryptedRefresh, tokens.expiresAt ?? null, now, now,
        current.id, current.pubkey, current.platform, current.externalAccountId,
        current.encryptedAccessToken, current.encryptedRefreshToken, current.platform, current.metadataJson).run()
    if (result.meta.changes !== 1) {
      const winner = await winningConnectionToken(env, current, now)
      if (winner) return winner
      throw new ConnectionTokenReauthError(current.platform, 'Account changed during refresh; try again')
    }
    await recordDiagnosticSafely(env, { reference: current.id, platform: current.platform, operation: 'refresh', stage: 'token_refresh', outcome: 'succeeded', now })
    return {
      accessToken: tokens.accessToken,
      connection: { ...current, encryptedAccessToken: encryptedAccess, encryptedRefreshToken: encryptedRefresh,
        tokenExpiresAt: tokens.expiresAt ?? null, lastRefreshAt: now, updatedAt: now },
    }
  } catch (error) {
    await recordDiagnosticSafely(env, { reference: current.id, platform: current.platform, operation: 'refresh', stage: 'token_refresh', outcome: 'failed', now, error })
    if (error instanceof PlatformAdapterError && error.code === 'needs_reauth') {
      // A losing successful refresh has no rejected credentials to invalidate.
      if (!(error instanceof ConnectionTokenReauthError)) {
        await markConnectionCredentialsRejected(env, current, now)
      }
      const winner = await winningConnectionToken(env, current, now)
      if (winner) return winner
      throw new ConnectionTokenReauthError(current.platform, error.message, error.providerStatus)
    }
    throw error
  }
}

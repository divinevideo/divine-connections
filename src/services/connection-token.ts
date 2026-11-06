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

// Match the publisher reconciler's five-minute stale-claim lease. The first
// rejection CAS sets updatedAt once; pending reads never extend this deadline.
const REFRESH_RECONCILIATION_SECONDS = 5 * 60

export class ConnectionTokenRefreshPendingError extends ConnectionTokenReauthError {
  constructor(platform: Platform, public readonly retryAt: number, providerStatus?: number) {
    super(platform, 'Waiting for a concurrent token refresh', providerStatus)
  }
}

function pendingRefreshReconciliation(previous: ConnectionRecord, current: ConnectionRecord | null, now: number, providerStatus?: number): ConnectionTokenRefreshPendingError | null {
  if (!current || current.status !== 'needs_reauth' || !sameConnectionSelection(previous, current) ||
      !previous.encryptedRefreshToken || previous.tokenExpiresAt === null || previous.tokenExpiresAt > now + 60 ||
      previous.encryptedAccessToken !== current.encryptedAccessToken || previous.encryptedRefreshToken !== current.encryptedRefreshToken) return null
  const retryAt = current.updatedAt + REFRESH_RECONCILIATION_SECONDS
  return now < retryAt ? new ConnectionTokenRefreshPendingError(current.platform, retryAt, providerStatus) : null
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
  if (!current || !sameConnectionSelection(connection, current)) {
    throw new ConnectionTokenReauthError(connection.platform, 'Reconnect the platform account')
  }
  if (current.status !== 'connected') {
    throw pendingRefreshReconciliation(connection, current, now) ??
      new ConnectionTokenReauthError(connection.platform, 'Reconnect the platform account')
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
    // A competing refresh may reject the rotated old grant before this success
    // arrives. Recover only that same pair; disconnects and changed selections
    // or credentials must still prevent the update.
    const result = await env.DB.prepare(`UPDATE connections
      SET status = 'connected', encrypted_access_token = ?, encrypted_refresh_token = ?, token_expires_at = ?, last_refresh_at = ?, updated_at = ?
      WHERE id = ? AND pubkey = ? AND platform = ? AND external_account_id = ?
        AND status IN ('connected', 'needs_reauth') AND encrypted_access_token = ? AND encrypted_refresh_token = ?
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
      if (!(error instanceof ConnectionTokenReauthError)) {
        const rejected = await getConnection(env.DB, current.id, current.pubkey)
        const pending = pendingRefreshReconciliation(current, rejected, now, error.providerStatus)
        if (pending) throw pending
      }
      throw new ConnectionTokenReauthError(current.platform, error.message, error.providerStatus)
    }
    throw error
  }
}

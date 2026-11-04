// ABOUTME: Obtains a usable token without a publish job or exposing secrets to callers.
// ABOUTME: Persists refreshes only while the same owner, active connection and token still match.
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

async function winningConnectionToken(env: Env, previous: ConnectionRecord, now: number): Promise<string | null> {
  const winner = await getConnection(env.DB, previous.id, previous.pubkey)
  if (!winner || winner.status !== 'connected' || winner.platform !== previous.platform || winner.externalAccountId !== previous.externalAccountId ||
    winner.encryptedAccessToken === previous.encryptedAccessToken || (winner.tokenExpiresAt !== null && winner.tokenExpiresAt <= now + 60)) return null
  return decryptToken(winner.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY)
}

async function markRejectedCredentials(env: Env, current: ConnectionRecord, now: number): Promise<void> {
  await env.DB.prepare(`UPDATE connections SET status = 'needs_reauth', updated_at = ?
    WHERE id = ? AND pubkey = ? AND status = 'connected' AND encrypted_access_token = ? AND encrypted_refresh_token IS ?`)
    .bind(now, current.id, current.pubkey, current.encryptedAccessToken, current.encryptedRefreshToken).run()
}

export async function usableConnectionToken(env: Env, connection: ConnectionRecord, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const current = await getConnection(env.DB, connection.id, connection.pubkey)
  if (!current || current.status !== 'connected' || current.platform !== connection.platform || current.externalAccountId !== connection.externalAccountId) {
    throw new ConnectionTokenReauthError(connection.platform, 'Reconnect the platform account')
  }
  if (current.tokenExpiresAt === null || current.tokenExpiresAt > now + 60) return decryptToken(current.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY)
  if (!current.encryptedRefreshToken) {
    await markRejectedCredentials(env, current, now)
    const winner = await winningConnectionToken(env, current, now)
    if (winner) return winner
    throw new ConnectionTokenReauthError(current.platform, 'Reconnect the platform account')
  }
  const adapter = getAdapter(env, current.platform)
  if (!adapter) throw new PlatformAdapterError(current.platform, 'not_connected', 'Platform is not enabled')
  try {
    const tokens = await adapter.refreshToken({ refreshToken: await decryptToken(current.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY) })
    const encryptedAccess = await encryptToken(tokens.accessToken, env.TOKEN_ENCRYPTION_KEY)
    const encryptedRefresh = tokens.refreshToken ? await encryptToken(tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY) : current.encryptedRefreshToken
    const result = await env.DB.prepare(`UPDATE connections SET encrypted_access_token = ?, encrypted_refresh_token = ?, token_expires_at = ?, last_refresh_at = ?, updated_at = ?
      WHERE id = ? AND pubkey = ? AND status = 'connected' AND encrypted_access_token = ? AND encrypted_refresh_token = ?`)
      .bind(encryptedAccess, encryptedRefresh, tokens.expiresAt ?? null, now, now, current.id, current.pubkey, current.encryptedAccessToken, current.encryptedRefreshToken).run()
    if (result.meta.changes !== 1) {
      const winner = await winningConnectionToken(env, current, now)
      if (winner) return winner
      throw new ConnectionTokenReauthError(current.platform, 'Account changed during refresh; try again')
    }
    await recordDiagnosticSafely(env, { reference: current.id, platform: current.platform, operation: 'refresh', stage: 'token_refresh', outcome: 'succeeded', now })
    return tokens.accessToken
  } catch (error) {
    await recordDiagnosticSafely(env, { reference: current.id, platform: current.platform, operation: 'refresh', stage: 'token_refresh', outcome: 'failed', now, error })
    if (error instanceof PlatformAdapterError && error.code === 'needs_reauth') {
      // A losing successful refresh has no rejected credentials to invalidate.
      if (!(error instanceof ConnectionTokenReauthError)) await markRejectedCredentials(env, current, now)
      const winner = await winningConnectionToken(env, current, now)
      if (winner) return winner
      throw new ConnectionTokenReauthError(current.platform, error.message, error.providerStatus)
    }
    throw error
  }
}

// ABOUTME: Loads owner-scoped current TikTok controls and validates explicit per-post consent.
// ABOUTME: Rechecks provider restrictions without ever changing the creator's confirmed choices.
import { recordDiagnosticSafely } from './reliability'
import { getActiveConnectionForPlatform } from '../db/connections'
import { getAdapter } from '../platforms/registry'
import { fetchTikTokCreatorInfo, sameTikTokCreatorInfo, validateTikTokPostOptions } from '../platforms/tiktok'
import { PlatformAdapterError, asRecord } from '../platforms/adapter'
import { usableConnectionToken } from './connection-token'
import type { ConnectionRecord, Env, TikTokPostOptions } from '../types'
import { HttpError } from '../utils/http'

export async function currentTikTokCreatorInfo(env: Env, pubkey: string, stage: 'creator_info' | 'confirmation_creator_info' = 'creator_info') {
  if (!getAdapter(env, 'tiktok')) throw new HttpError(400, 'not_connected', 'TikTok is not enabled')
  const connection = await getActiveConnectionForPlatform(env.DB, pubkey, 'tiktok')
  if (!connection) throw new HttpError(400, 'not_connected', 'Connect a TikTok account first')
  let accessToken: string
  try { accessToken = await usableConnectionToken(env, connection) }
  catch (error) { throw tikTokHttpError(error) }
  try {
    return { creatorInfo: await fetchTikTokCreatorInfo(accessToken), connectionId: connection.id }
  } catch (error) {
    // Provider bodies can echo captions, account values and tokens. Persist only
    // the safe endpoint/status/classification, never the raw body.
    const safeError = new PlatformAdapterError('tiktok', error instanceof PlatformAdapterError ? error.code : 'unknown_platform_error',
      'TikTok creator info request failed', error instanceof PlatformAdapterError ? error.providerStatus : undefined,
      { error: { type: error instanceof PlatformAdapterError ? error.code : 'unknown_platform_error' } }, '/v2/post/publish/creator_info/query/')
    await recordDiagnosticSafely(env, { reference: connection.id, platform: 'tiktok', operation: 'publish', stage, outcome: 'failed', now: Math.floor(Date.now() / 1000), error: safeError })
    throw tikTokHttpError(error instanceof PlatformAdapterError ? error : safeError)
  }
}

export function tikTokHttpError(error: unknown): unknown {
  if (!(error instanceof PlatformAdapterError)) return error
  return new HttpError(error.code === 'needs_reauth' ? 401 : error.code === 'rate_limited' ? 429 : error.code === 'not_eligible' ? 400 : 503, error.code, error.message)
}

export async function confirmTikTokOptions(env: Env, connection: ConnectionRecord, value: unknown, duration: number | null): Promise<TikTokPostOptions> {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'not_eligible', 'Preview and confirm TikTok options before posting')
  const current = await currentTikTokCreatorInfo(env, connection.pubkey, 'confirmation_creator_info')
  if (asRecord(value).connectionId !== connection.id || current.connectionId !== connection.id) throw new HttpError(400, 'not_eligible', 'Confirm the connected TikTok account')
  if (!sameTikTokCreatorInfo(asRecord(value).creatorInfo, current.creatorInfo)) throw new HttpError(409, 'tiktok_confirmation_changed', 'TikTok settings changed; preview and confirm again')
  try {
    return validateTikTokPostOptions(value, current.creatorInfo, duration, connection.id)
  } catch (error) { throw tikTokHttpError(error) }
}

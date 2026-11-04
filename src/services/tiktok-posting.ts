// ABOUTME: Loads owner-scoped current TikTok controls and validates explicit per-post consent.
// ABOUTME: Rechecks provider restrictions without ever changing the creator's confirmed choices.
import { getActiveConnectionForPlatform } from '../db/connections'
import { getAdapter } from '../platforms/registry'
import { fetchTikTokCreatorInfo, sameTikTokCreatorInfo, validateTikTokPostOptions } from '../platforms/tiktok'
import { PlatformAdapterError, asRecord } from '../platforms/adapter'
import { usableConnectionToken } from './connection-token'
import type { ConnectionRecord, Env, TikTokPostOptions } from '../types'
import { HttpError } from '../utils/http'

export async function currentTikTokCreatorInfo(env: Env, pubkey: string) {
  if (!getAdapter(env, 'tiktok')) throw new HttpError(400, 'not_connected', 'TikTok is not enabled')
  const connection = await getActiveConnectionForPlatform(env.DB, pubkey, 'tiktok')
  if (!connection) throw new HttpError(400, 'not_connected', 'Connect a TikTok account first')
  try {
    const accessToken = await usableConnectionToken(env, connection)
    return { creatorInfo: await fetchTikTokCreatorInfo(accessToken), connectionId: connection.id }
  } catch (error) {
    throw tikTokHttpError(error)
  }
}

export function tikTokHttpError(error: unknown): unknown {
  if (!(error instanceof PlatformAdapterError)) return error
  return new HttpError(error.code === 'needs_reauth' ? 401 : error.code === 'rate_limited' ? 429 : error.code === 'not_eligible' ? 400 : 503, error.code, error.message)
}

export async function confirmTikTokOptions(env: Env, connection: ConnectionRecord, value: unknown, duration: number | null): Promise<TikTokPostOptions> {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'not_eligible', 'Preview and confirm TikTok options before posting')
  const current = await currentTikTokCreatorInfo(env, connection.pubkey)
  if (asRecord(value).connectionId !== connection.id || current.connectionId !== connection.id) throw new HttpError(400, 'not_eligible', 'Confirm the connected TikTok account')
  if (!sameTikTokCreatorInfo(asRecord(value).creatorInfo, current.creatorInfo)) throw new HttpError(409, 'tiktok_confirmation_changed', 'TikTok settings changed; preview and confirm again')
  try {
    return validateTikTokPostOptions(value, current.creatorInfo, duration, connection.id)
  } catch (error) { throw tikTokHttpError(error) }
}

import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test'
import { inject } from 'vitest'
import type { ConnectionRecord, CreateJobInput } from '../types'

export const PUBKEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const PUBKEY_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
export const VIDEO_EVENT_ID = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'

export async function applyMigrations(): Promise<D1Database> {
  const migrations = inject('migrations') as D1Migration[]
  await applyD1Migrations(env.DB, migrations)
  return env.DB
}

// Badge rows this worker wrote while it carried the verification copy. Tests
// that check what crossposting does to the table read it through this helper,
// so retiring the table changes one place.
export async function verificationRows(db: D1Database): Promise<Record<string, unknown>[]> {
  const { results } = await db.prepare('SELECT * FROM verifications ORDER BY pubkey, platform, identity_key').all()
  return results
}

export function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: 'conn_1',
    pubkey: PUBKEY_A,
    platform: 'tiktok',
    externalAccountId: 'external-account-1',
    externalAccountName: '@divine',
    encryptedAccessToken: 'v1.encrypted-access-token',
    encryptedRefreshToken: 'v1.encrypted-refresh-token',
    tokenExpiresAt: 1_800,
    grantedScopes: 'video.publish',
    status: 'connected',
    createdAt: 1_000,
    updatedAt: 1_000,
    lastRefreshAt: null,
    metadataJson: '{}',
    ...overrides,
  }
}

export function job(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    id: 'job_1',
    pubkey: PUBKEY_A,
    videoEventId: VIDEO_EVENT_ID,
    platform: 'tiktok',
    connectionId: 'conn_1',
    externalAccountId: 'external-account-1',
    sourceMediaUrl: 'https://cdn.divine.video/video.mp4',
    sourceMediaHash: 'sha256:example',
    caption: 'six seconds of weird human internet',
    status: 'queued',
    expiresAt: 174_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

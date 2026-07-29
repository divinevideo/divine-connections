// ABOUTME: D1 access for the verifications table (durable badge store).
// ABOUTME: Upsert/revoke return prepared statements so callers can compose them
// into their existing db.batch writes; reads are plain async helpers.
import type { VerificationPlatform, VerificationRecord } from '../types'

export interface OauthVerificationInput {
  pubkey: string
  platform: VerificationPlatform
  identity: string
  connectionId: string
  verifiedAt: number
}

export interface ProofPostVerificationInput {
  pubkey: string
  platform: VerificationPlatform
  identity: string
  proofUrl: string | null
  verifiedAt: number
}

/**
 * The normalized value writes dedupe on and reads match against.
 *
 * YouTube proves a channel id (UC…) where case is significant — two ids differing
 * only by case are different channels, so folding them would let a lookup resolve
 * one channel to another channel's pubkey. Every other platform proves a handle
 * that upstreams treat as case-insensitive. `identity` keeps its display casing.
 */
export function verificationIdentityKey(platform: VerificationPlatform, identity: string): string {
  return platform === 'youtube' ? identity : identity.toLowerCase()
}

export function upsertOauthVerificationStatement(
  db: D1Database,
  input: OauthVerificationInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO verifications (pubkey, platform, identity, identity_key, method, proof_url, connection_id, verified_at, revoked_at)
       VALUES (?, ?, ?, ?, 'oauth', NULL, ?, ?, NULL)
       ON CONFLICT(pubkey, platform, identity_key) DO UPDATE SET
         identity = excluded.identity,
         method = excluded.method,
         proof_url = excluded.proof_url,
         connection_id = excluded.connection_id,
         verified_at = excluded.verified_at,
         revoked_at = NULL`,
    )
    .bind(
      input.pubkey,
      input.platform,
      input.identity,
      verificationIdentityKey(input.platform, input.identity),
      input.connectionId,
      input.verifiedAt,
    )
}

export function upsertProofPostVerificationStatement(
  db: D1Database,
  input: ProofPostVerificationInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO verifications (pubkey, platform, identity, identity_key, method, proof_url, connection_id, verified_at, revoked_at)
       VALUES (?, ?, ?, ?, 'proof-post', ?, NULL, ?, NULL)
       ON CONFLICT(pubkey, platform, identity_key) DO UPDATE SET
         identity = excluded.identity,
         method = excluded.method,
         proof_url = excluded.proof_url,
         -- Keep any existing connection link: revocation matches on connection_id,
         -- so clearing it here would strand a badge that disconnecting can never remove.
         connection_id = COALESCE(verifications.connection_id, excluded.connection_id),
         verified_at = excluded.verified_at,
         revoked_at = NULL`,
    )
    .bind(
      input.pubkey,
      input.platform,
      input.identity,
      verificationIdentityKey(input.platform, input.identity),
      input.proofUrl,
      input.verifiedAt,
    )
}

export function revokeVerificationsForConnectionStatement(
  db: D1Database,
  input: { connectionId: string; pubkey: string; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE verifications SET revoked_at = ?
       WHERE connection_id = ? AND pubkey = ? AND revoked_at IS NULL`,
    )
    .bind(input.now, input.connectionId, input.pubkey)
}

interface VerificationRow {
  pubkey: string
  platform: string
  identity: string
  method: string
  proof_url: string | null
  connection_id: string | null
  verified_at: number
  revoked_at: number | null
}

function toRecord(row: VerificationRow): VerificationRecord {
  return {
    pubkey: row.pubkey,
    platform: row.platform as VerificationPlatform,
    identity: row.identity,
    method: row.method as VerificationRecord['method'],
    proofUrl: row.proof_url,
    connectionId: row.connection_id,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at,
  }
}

export async function listVerificationsByPubkey(
  db: D1Database,
  pubkey: string,
): Promise<VerificationRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM verifications WHERE pubkey = ? AND revoked_at IS NULL
       ORDER BY platform ASC, identity ASC`,
    )
    .bind(pubkey)
    .all<VerificationRow>()
  return results.map(toRecord)
}

export async function findLiveVerification(
  db: D1Database,
  pubkey: string,
  platform: VerificationPlatform,
  identity: string,
): Promise<VerificationRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM verifications
       WHERE pubkey = ? AND platform = ? AND identity_key = ? AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(pubkey, platform, verificationIdentityKey(platform, identity))
    .first<VerificationRow>()
  return row ? toRecord(row) : null
}

export async function findVerificationByIdentity(
  db: D1Database,
  platform: VerificationPlatform,
  identity: string,
): Promise<VerificationRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM verifications
       WHERE platform = ? AND identity_key = ? AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(platform, verificationIdentityKey(platform, identity))
    .first<VerificationRow>()
  return row ? toRecord(row) : null
}

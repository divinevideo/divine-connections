// ABOUTME: Public badge-read API over the verifications projection.
// ABOUTME: Reads only verifications columns; never touches connections token data.
import { Hono } from 'hono'
import type { Env } from '../types'
import { findVerificationByIdentity, listVerificationsByPubkey } from '../db/verifications'
import type { VerificationRecord } from '../types'
import { normalizeVerifyPlatform } from '../services/verify'
import { errorResponse, HttpError, jsonResponse } from '../utils/http'

const PUBKEY_RE = /^[0-9a-f]{64}$/

function toBadge(row: VerificationRecord) {
  return {
    platform: row.platform,
    identity: row.identity,
    method: row.method,
    proof_url: row.proofUrl,
    verified_at: row.verifiedAt,
  }
}

export const verified = new Hono<{ Bindings: Env }>()

verified.get('/verified', async (c) => {
  try {
    const platformParam = c.req.query('platform')
    const identity = c.req.query('identity')
    const platform = platformParam ? normalizeVerifyPlatform(platformParam) : null
    if (!platform || !identity) throw new HttpError(400, 'invalid_request', 'platform and identity are required')
    const row = await findVerificationByIdentity(c.env.DB, platform, identity)
    if (!row) throw new HttpError(404, 'not_found', 'no live verification for this platform identity')
    return jsonResponse({ platform, identity: row.identity, pubkey: row.pubkey, method: row.method, verified_at: row.verifiedAt })
  } catch (error) {
    return errorResponse(error)
  }
})

verified.get('/verified/:pubkey', async (c) => {
  try {
    const pubkey = c.req.param('pubkey').toLowerCase()
    if (!PUBKEY_RE.test(pubkey)) throw new HttpError(400, 'invalid_pubkey', 'pubkey must be 64 lowercase hex chars')
    const rows = await listVerificationsByPubkey(c.env.DB, pubkey)
    return jsonResponse({ pubkey, verifications: rows.map(toBadge) })
  } catch (error) {
    return errorResponse(error)
  }
})

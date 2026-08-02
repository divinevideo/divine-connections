// ABOUTME: Shared helpers for the end-to-end suite: which deployment to hit,
// ABOUTME: how to call it, and how to read the proof fixtures from the environment.
import { hexToNpub } from '../../src/utils/npub'

// Defaults to the workers.dev deployment because that is where the merged
// worker lives until the domain cutover (issue #2). Point E2E_BASE_URL at
// verifier.divine.video once that lands, or at `wrangler dev` to run locally.
export const BASE_URL = (process.env.E2E_BASE_URL || 'https://divine-connections.protestnet.workers.dev').replace(/\/$/, '')

export interface ApiResponse<T> {
  status: number
  headers: Headers
  body: T
  text: string
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const response = await fetch(`${BASE_URL}${path}`, init)
  const text = await response.text()
  let body: T
  try {
    body = JSON.parse(text) as T
  } catch {
    body = text as unknown as T
  }
  return { status: response.status, headers: response.headers, body, text }
}

export function postJson<T = unknown>(path: string, payload: unknown): Promise<ApiResponse<T>> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export interface VerifyResult {
  platform?: string
  identity?: string
  verified?: boolean
  error?: string
  method?: string
}

export function verifySingle(claim: {
  platform: string
  identity: string
  proof?: string
  pubkey: string
}): Promise<ApiResponse<VerifyResult>> {
  return postJson<VerifyResult>('/verify/single', claim)
}

// A pubkey that is syntactically valid but belongs to nobody. Used by the
// rejection tests, which must never produce a stored verification — if one of
// them ever does write a row, it is attributed to an obviously fake identity
// rather than to a real person.
export const UNCLAIMED_PUBKEY = '0000000000000000000000000000000000000000000000000000000000000001'
export const UNCLAIMED_NPUB = hexToNpub(UNCLAIMED_PUBKEY)

// The positive path needs real content, posted by a real account holder, that
// contains that holder's own npub. We cannot manufacture that from a test — it
// is the exact human step the product asks a user to take. Supply it via env:
//
//   E2E_PROOF_PUBKEY=<64-char hex pubkey>
//   E2E_PROOF_GITHUB_USER=<github login that owns the gist>
//   E2E_PROOF_GITHUB_GIST=<gist id whose content contains that pubkey's npub>
//
// See e2e/README.md for the one command that creates the fixture.
export interface GitHubProofFixture {
  pubkey: string
  npub: string
  user: string
  gist: string
}

export function githubProofFixture(): GitHubProofFixture | null {
  const pubkey = process.env.E2E_PROOF_PUBKEY
  const user = process.env.E2E_PROOF_GITHUB_USER
  const gist = process.env.E2E_PROOF_GITHUB_GIST
  if (!pubkey || !user || !gist) return null
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    throw new Error(`E2E_PROOF_PUBKEY must be 64-char hex, got: ${pubkey}`)
  }
  return { pubkey, npub: hexToNpub(pubkey), user, gist }
}

export interface PlatformsResponse {
  platforms: Record<string, { label: string; supported: boolean; methods: string[] }>
}

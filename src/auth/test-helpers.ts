// ABOUTME: Test helpers that build and sign NIP-98 HTTP-auth events with a fixed, never-real secret key,
// ABOUTME: and encode them as the value of an `Authorization: Nostr ...` header.
import { schnorr } from '@noble/curves/secp256k1.js'

/** Fixed test-only secret key (never a real account). */
export const NIP98_TEST_SECRET_KEY = new Uint8Array(32).fill(7)

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const NIP98_TEST_PUBKEY = toHex(schnorr.getPublicKey(NIP98_TEST_SECRET_KEY))

/** The fields an event id commits to, typed loosely so a test can sign a malformed event. */
export type EventFields = { pubkey: unknown; created_at: unknown; kind: unknown; tags: unknown; content: unknown }

export type Nip98TestEventOptions = {
  url: string
  method: string
  createdAt: number
  body?: string
  kind?: number
  extraTags?: string[][]
  omitPayload?: boolean
  payloadOverride?: string
  /** Adds divine-mobile's non-standard ['created_at', seconds] tag, between the method and payload tags. */
  createdAtTag?: boolean
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))))
}

/**
 * Signs an event with exactly these field values, whatever their types, so the signature is
 * genuine and only the verifier's own checks can be what rejects the event.
 */
export async function signEventFields(fields: EventFields): Promise<Record<string, unknown>> {
  const serialized = JSON.stringify([0, fields.pubkey, fields.created_at, fields.kind, fields.tags, fields.content])
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))
  return { id: toHex(digest), ...fields, sig: toHex(schnorr.sign(digest, NIP98_TEST_SECRET_KEY)) }
}

/**
 * Builds and signs a NIP-98 event. By default it carries only the tags the NIP defines; pass
 * `createdAtTag` for the exact layout divine-mobile's Nip98AuthService signs: u, method, created_at, payload.
 */
export async function signNip98Event(options: Nip98TestEventOptions): Promise<Record<string, unknown>> {
  const tags: string[][] = [
    ['u', options.url],
    ['method', options.method],
  ]
  if (options.createdAtTag) {
    tags.push(['created_at', String(options.createdAt)])
  }
  if (!options.omitPayload && (options.body !== undefined || options.payloadOverride !== undefined)) {
    tags.push(['payload', options.payloadOverride ?? (await sha256Hex(options.body ?? ''))])
  }
  tags.push(...(options.extraTags ?? []))

  return signEventFields({
    pubkey: NIP98_TEST_PUBKEY,
    created_at: options.createdAt,
    kind: options.kind ?? 27235,
    tags,
    content: '',
  })
}

/** Encodes an event as the value of an `Authorization: Nostr ...` header. */
export function nip98Header(event: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(event))
  return `Nostr ${btoa(String.fromCharCode(...bytes))}`
}

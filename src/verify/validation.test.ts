// ABOUTME: Tests for the proof-post and NIP-05 input validators.
// ABOUTME: Pure functions; no mocks.
import { describe, expect, it } from 'vitest'
import { isValidIdentity, isValidProof, validateNip05Name } from './validation'

describe('isValidProof', () => {
  it('accepts valid proofs', () => {
    expect(isValidProof('abc123')).toBe(true)
    expect(isValidProof('1234567890')).toBe(true)
    expect(isValidProof('my-channel/123')).toBe(true)
  })

  it('rejects invalid proofs', () => {
    expect(isValidProof('')).toBe(false)
    expect(isValidProof('<script>')).toBe(false)
  })
})

describe('isValidIdentity', () => {
  it('accepts valid identities', () => {
    expect(isValidIdentity('jack')).toBe(true)
    expect(isValidIdentity('mastodon.social/@alice')).toBe(true)
    expect(isValidIdentity('user.bsky.social')).toBe(true)
  })

  it('rejects invalid identities', () => {
    expect(isValidIdentity('')).toBe(false)
    expect(isValidIdentity('<script>alert(1)</script>')).toBe(false)
  })
})

describe('validateNip05Name', () => {
  it('parses valid NIP-05 names', () => {
    expect(validateNip05Name('_@divine.video')).toEqual({ local: '_', domain: 'divine.video' })
    expect(validateNip05Name('alice@example.com')).toEqual({ local: 'alice', domain: 'example.com' })
  })

  it('rejects invalid NIP-05 names', () => {
    expect(validateNip05Name('')).toBeNull()
    expect(validateNip05Name('noat')).toBeNull()
    expect(validateNip05Name('@nodomain')).toBeNull()
    expect(validateNip05Name('user@')).toBeNull()
    expect(validateNip05Name('user@localhost')).toBeNull()
  })
})

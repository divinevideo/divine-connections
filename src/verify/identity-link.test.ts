// ABOUTME: Tests for the AT Protocol identity-link record helpers.
// ABOUTME: Pure functions; no mocks.
import { describe, expect, it } from 'vitest'
import { buildNostrIdentityLinkRecord, matchNostrIdentityLinkRecord } from './identity-link'

describe('identity-link', () => {
  it('builds a valid nostr identity link record', () => {
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
    const record = buildNostrIdentityLinkRecord(npub)

    expect(record.$type).toBe('video.divine.identity.link')
    expect(record.version).toBe(1)
    expect(record.target.protocol).toBe('nostr')
    expect(record.target.id).toBe(npub)
    expect(record.target.uri).toBe(`nostr:${npub}`)
  })

  it('matches valid nostr identity link records', () => {
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
    const result = matchNostrIdentityLinkRecord({
      $type: 'video.divine.identity.link',
      version: 1,
      target: {
        protocol: 'nostr',
        id: npub,
      },
      gateway: {
        domain: 'atproto.brid.gy',
      },
    }, npub)

    expect(result.matched).toBe(true)
    expect(result.gateway?.domain).toBe('atproto.brid.gy')
  })

  it('rejects non-matching records', () => {
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
    const result = matchNostrIdentityLinkRecord({
      $type: 'video.divine.identity.link',
      version: 1,
      target: {
        protocol: 'nostr',
        id: 'npub1wrong',
      },
    }, npub)

    expect(result.matched).toBe(false)
  })
})

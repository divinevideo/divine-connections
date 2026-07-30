// ABOUTME: Tests for the Twitter/X proof-post verifier (oEmbed boundary).
// ABOUTME: Stubs upstream HTTP at the fetch boundary only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TwitterVerifier } from './twitter'

describe('TwitterVerifier', () => {
  const verifier = new TwitterVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when the oEmbed tweet from the claimed author contains the npub', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_url: 'https://x.com/alice',
        html: `<blockquote>Verifying my account on nostr My Public Key: &quot;${npub}&quot;</blockquote>`,
      }),
    }))

    const result = await verifier.verify('alice', '1234567890', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when the tweet author does not match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_url: 'https://x.com/bob',
        html: `<blockquote>${npub}</blockquote>`,
      }),
    }))

    const result = await verifier.verify('alice', '1234567890', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('author does not match')
  })

  it('returns not verified when the tweet 404s upstream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }))

    const result = await verifier.verify('alice', '1234567890', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not found')
  })
})

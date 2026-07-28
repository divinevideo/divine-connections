// ABOUTME: Tests for the TikTok platform adapter's account lookup.
// ABOUTME: Stubs upstream HTTP at the fetch boundary only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTikTokAdapter } from './tiktok'

describe('tiktok adapter fetchAccount', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the username field and names the account by its unique handle', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { user: { open_id: 'open-1', display_name: 'Alice Shows', username: 'alice.shows' } } }),
    )
    const adapter = createTikTokAdapter({ clientKey: 'client', clientSecret: 'secret' })
    const account = await adapter.fetchAccount({ accessToken: 'access' })

    const requestUrl = String(fetchMock.mock.calls[0][0])
    const fields = new URL(requestUrl).searchParams.get('fields')
    expect(fields).toContain('username')
    expect(account.name).toBe('alice.shows')
    expect(account.metadata).toMatchObject({ data: { user: { display_name: 'Alice Shows' } } })
  })
})

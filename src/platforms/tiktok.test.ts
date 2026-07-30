// ABOUTME: Tests for the TikTok platform adapter's account lookup and its scope contract.
// ABOUTME: Stubs upstream HTTP at the fetch boundary only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTikTokAdapter } from './tiktok'

// TikTok gates each user/info field behind a scope and rejects the whole request with
// scope_not_authorized when an ungranted field is asked for.
// https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
const SCOPE_FOR_USER_INFO_FIELD: Record<string, string> = {
  open_id: 'user.info.basic',
  union_id: 'user.info.basic',
  avatar_url: 'user.info.basic',
  avatar_url_100: 'user.info.basic',
  avatar_large_url: 'user.info.basic',
  display_name: 'user.info.basic',
  username: 'user.info.profile',
  bio_description: 'user.info.profile',
  profile_deep_link: 'user.info.profile',
  is_verified: 'user.info.profile',
  follower_count: 'user.info.stats',
  following_count: 'user.info.stats',
  likes_count: 'user.info.stats',
  video_count: 'user.info.stats',
}

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

  it('authorizes every scope the fields it requests are gated behind', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: { user: { open_id: 'open-1', username: 'alice.shows' } } }))
    const adapter = createTikTokAdapter({ clientKey: 'client', clientSecret: 'secret' })
    await adapter.fetchAccount({ accessToken: 'access' })

    const fields = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('fields')?.split(',') ?? []
    const authorizationUrl = new URL(
      adapter.buildAuthorizationUrl({ state: 'oauth-state', redirectUri: 'https://example.test/callback' }),
    )
    const grantedScopes = new Set(authorizationUrl.searchParams.get('scope')?.split(','))

    expect(fields.length).toBeGreaterThan(0)
    for (const field of fields) {
      expect(SCOPE_FOR_USER_INFO_FIELD).toHaveProperty(field)
      expect(grantedScopes).toContain(SCOPE_FOR_USER_INFO_FIELD[field])
    }
  })
})

// ABOUTME: Exercises YouTube OAuth permissions and malformed provider responses.
// ABOUTME: Keeps upstream HTTP mocked while testing the real adapter contract.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createYouTubeAdapter } from './youtube'

const adapter = createYouTubeAdapter({ clientId: 'client', clientSecret: 'secret' })
afterEach(() => vi.unstubAllGlobals())

describe('YouTube connection', () => {
  it('requests permission for both own-channel lookup and video upload', async () => {
    const url = new URL(adapter.buildAuthorizationUrl({ state: 'state', redirectUri: 'https://example.test/callback' }))
    const scopes = new Set(url.searchParams.get('scope')?.split(' '))
    // channels.list does not accept youtube.upload (Google discovery document).
    vi.stubGlobal('fetch', vi.fn(async () => scopes.has('https://www.googleapis.com/auth/youtube.readonly')
      ? Response.json({ items: [{ id: 'channel-1', snippet: { title: 'Creator' } }] })
      : Response.json({ error: { code: 403, message: 'Insufficient Permission' } }, { status: 403 })))
    await expect(adapter.fetchAccount({ accessToken: 'access' })).resolves.toMatchObject({ id: 'channel-1' })
    expect(scopes).toContain('https://www.googleapis.com/auth/youtube.upload')
  })

  it.each([{}, { access_token: '' }, { access_token: '  ' }, { access_token: 123 }])(
    'rejects an unusable token response before account lookup: %j', async (body) => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
      await expect(adapter.exchangeCallback({ code: 'code', redirectUri: 'https://example.test/callback' }))
        .rejects.toMatchObject({ code: 'unknown_platform_error' })
    },
  )
})

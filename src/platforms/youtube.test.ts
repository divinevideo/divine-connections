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

const publishInput = { accessToken: 'access', videoUrl: 'https://media.divine.video/synthetic.mp4', mediaHash: 'synthetic-hash', caption: 'Complete human description', externalAccountId: 'synthetic-channel', youtubeTitle: 'Human title' }
const syntheticId = 'synthetic01'

describe('YouTube publication', () => {
  it.each(['http://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic', 'https://attacker.example.test/upload', 'https://www.googleapis.com.attacker.example.test/upload', 'https://www.googleapis.com/wrong/path', 'https://user:password@www.googleapis.com/upload/youtube/v3/videos', 'not a URL'])('rejects unsafe upload session %s without forwarding tokens or raising dispatch', async (location) => {
    const beforeExternalPost = vi.fn()
    const fetchMock = vi.fn(async (url) => String(url).includes('media.divine.video') ? new Response('video') : new Response('{}', { headers: { location } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(adapter.publishVideo({ ...publishInput, beforeExternalPost })).rejects.toMatchObject({ code: 'unknown_platform_error' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(beforeExternalPost).not.toHaveBeenCalled()
  })

  it.each(['private', 'unlisted', 'public'] as const)('uploads with frozen %s visibility then returns processing without polling', async (youtubePrivacyStatus) => {
    const requests: string[] = []
    const beforeExternalPost = vi.fn(async () => { requests.push('fence') })
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('media.divine.video')) return new Response('video')
      if (url.includes('uploadType=resumable')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ snippet: { title: 'Human title', description: publishInput.caption }, status: { privacyStatus: youtubePrivacyStatus } })
        return new Response('{}', { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic' } })
      }
      expect(requests.at(-2)).toBe('fence')
      return Response.json({ id: syntheticId, access_token: 'never-store' })
    }))
    const result = await adapter.publishVideo({ ...publishInput, youtubePrivacyStatus, beforeExternalPost })
    expect(result).toEqual({ status: 'processing', externalPostId: syntheticId, externalPostUrl: 'https://www.youtube.com/watch?v=' + syntheticId, providerResponse: { id: syntheticId } })
    expect(beforeExternalPost).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(4)
  })

  it('keeps configured privacy for legacy uploads and derives a safe fallback title', async () => {
    const legacy = createYouTubeAdapter({ clientId: 'client', clientSecret: 'secret', defaultPrivacyStatus: 'unlisted' })
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).includes('media.divine.video')) return new Response('video')
      if (String(url).includes('uploadType=resumable')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ snippet: { title: 'Divine video' }, status: { privacyStatus: 'unlisted' } })
        return new Response('{}', { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic' } })
      }
      return Response.json({ id: syntheticId })
    }))
    await legacy.publishVideo({ ...publishInput, youtubeTitle: undefined })
  })

  it.each([{}, { id: '' }, { id: 123 }, { id: 'bad/id' }])('rejects an upload response without a usable video ID: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('media.divine.video') ? new Response('video') : String(url).includes('uploadType=resumable') ? new Response('{}', { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic' } }) : Response.json(body)))
    await expect(adapter.publishVideo(publishInput)).rejects.toMatchObject({ code: 'ambiguous_post_result' })
  })

  it.each(['private', 'unlisted', 'public'] as const)('verifies processing success and effective %s visibility', async (youtubePrivacyStatus) => {
    const fetchMock = vi.fn(async (url) => {
      const request = new URL(String(url))
      expect(request.pathname).toBe('/youtube/v3/videos')
      expect(request.searchParams.get('id')).toBe(syntheticId)
      expect(request.searchParams.get('part')).toBe('status,processingDetails')
      return Response.json({ items: [{ id: syntheticId, status: { uploadStatus: 'processed', privacyStatus: youtubePrivacyStatus }, processingDetails: { processingStatus: 'succeeded' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(adapter.pollPublishStatus).toBeTypeOf('function')
    const result = await adapter.pollPublishStatus!({ accessToken: 'access', youtubePrivacyStatus, providerResponse: { id: syntheticId, untrusted: 'discard' } })
    expect(result).toMatchObject({ status: 'posted', externalPostId: syntheticId, externalPostUrl: 'https://www.youtube.com/watch?v=' + syntheticId, providerResponse: { id: syntheticId } })
  })

  it.each([
    {},
    { status: { uploadStatus: 'processed', privacyStatus: 'public' } },
    { status: { uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } },
    { status: { uploadStatus: 'processed', privacyStatus: 'unknown' }, processingDetails: { processingStatus: 'succeeded' } },
    { status: { uploadStatus: 'unknown', privacyStatus: 'public' }, processingDetails: { processingStatus: 'succeeded' } },
    { status: { uploadStatus: 'processed', privacyStatus: 'public' }, processingDetails: { processingStatus: 'unknown' } },
  ])('never treats missing or unknown status as success: %j', async (resource) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [{ id: syntheticId, ...resource }] })))
    expect(await adapter.pollPublishStatus!({ accessToken: 'access', youtubePrivacyStatus: 'public', providerResponse: { id: syntheticId } })).toMatchObject({ status: 'processing' })
  })

  it('retains processing while provider is unfinished', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [{ id: syntheticId, status: { uploadStatus: 'uploaded', privacyStatus: 'private' }, processingDetails: { processingStatus: 'processing' } }] })))
    expect(adapter.pollPublishStatus).toBeTypeOf('function')
    expect(await adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { id: syntheticId } })).toMatchObject({ status: 'processing', externalPostId: syntheticId })
  })

  it.each([
    { status: { uploadStatus: 'rejected' }, processingDetails: {} },
    { status: { uploadStatus: 'failed' }, processingDetails: {} },
    { status: { uploadStatus: 'deleted' }, processingDetails: {} },
    { status: { uploadStatus: 'uploaded' }, processingDetails: { processingStatus: 'failed' } },
    { status: { uploadStatus: 'uploaded' }, processingDetails: { processingStatus: 'terminated' } },
  ])('treats terminal rejection/processing failure as failure: %j', async (resource) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [{ id: syntheticId, ...resource }] })))
    expect(adapter.pollPublishStatus).toBeTypeOf('function')
    await expect(adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { id: syntheticId } })).rejects.toMatchObject({ code: 'media_rejected' })
  })

  it('fails a privacy mismatch instead of silently narrowing audience', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [{ id: syntheticId, status: { uploadStatus: 'processed', privacyStatus: 'private' }, processingDetails: { processingStatus: 'succeeded' } }] })))
    expect(adapter.pollPublishStatus).toBeTypeOf('function')
    await expect(adapter.pollPublishStatus!({ accessToken: 'access', youtubePrivacyStatus: 'public', providerResponse: { id: syntheticId } })).rejects.toMatchObject({ code: 'platform_review_required' })
  })

  it('fails safely without a poll checkpoint ID and makes no request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(adapter.pollPublishStatus).toBeTypeOf('function')
    await expect(adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: {} })).rejects.toMatchObject({ code: 'ambiguous_post_result' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not report missing video resources as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [] })))
    expect(adapter.pollPublishStatus).toBeTypeOf('function')
    await expect(adapter.pollPublishStatus!({ accessToken: 'access', providerResponse: { id: syntheticId } })).rejects.toMatchObject({ code: 'processing_timeout' })
  })

  it('rejects over-limit UTF-8 descriptions before upload', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(adapter.publishVideo({ ...publishInput, caption: '🎉'.repeat(1251) })).rejects.toMatchObject({ code: 'media_rejected' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ABOUTME: End-to-end checks that the deployed worker is up, serves the landing
// ABOUTME: page freshly, and reports every platform its configuration claims to support.
import { describe, expect, it } from 'vitest'
import { api, BASE_URL, type PlatformsResponse } from './support/deployment'

describe(`deployment at ${BASE_URL}`, () => {
  it('answers /health as the merged connections worker', async () => {
    const response = await api<{ status: string; service: string }>('/health')

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
    // The merged worker, not one of the two services it replaces. If this ever
    // reads divine-crossposter or divine-identity-verification-service, the
    // hostname is pointing at the old deployment.
    expect(response.body.service).toBe('divine-connections')
  })

  it('serves the landing page as HTML', async () => {
    const response = await api<string>('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.text).toContain('<!DOCTYPE html>')
  })

  it('serves the landing page with revalidation headers so testers cannot run a stale build', async () => {
    const response = await api<string>('/')

    expect(response.headers.get('cache-control')).toContain('no-cache')
  })

  // Cloudflare strips `ETag` from this worker's responses at the edge, so
  // conditional requests can never short-circuit. A client that presents a
  // validator anyway must still be handed the current page, not a 304 it
  // cannot satisfy from cache.
  it('serves the current page even to a client presenting a validator', async () => {
    const response = await api<string>('/', { headers: { 'if-none-match': 'W/"deadbeef"' } })

    expect(response.status).toBe(200)
    expect(response.text).toContain('<!DOCTYPE html>')
  })

  it('reflects a redeploy immediately rather than serving a stale build', async () => {
    // The property that actually matters: two loads separated by a deploy must
    // not differ. Approximated here by asserting the page is served fresh with
    // no stored-response directive that would let a browser skip revalidation.
    const cacheControl = (await api<string>('/')).headers.get('cache-control') ?? ''

    expect(cacheControl).not.toMatch(/max-age=(?!0)\d+/)
    expect(cacheControl).not.toContain('immutable')
  })

  it('exposes the machine-readable service identity on JSON content negotiation', async () => {
    const response = await api<{ service: string }>('/', { headers: { accept: 'application/json' } })

    expect(response.status).toBe(200)
    expect(response.body.service).toBe('divine-connections')
  })
})

// /platforms reports what this *deployment* can actually do, which is a
// function of the secrets installed on it — not of the code. That makes it the
// honest place to catch "we shipped the feature but never installed the token",
// which is otherwise invisible until a user hits a dead button.
describe('platform capability, as the live deployment reports it', () => {
  const platformsOnce = api<PlatformsResponse>('/platforms')

  it('reports every platform the product offers', async () => {
    const { status, body } = await platformsOnce

    expect(status).toBe(200)
    expect(Object.keys(body.platforms).sort()).toEqual(
      ['bluesky', 'discord', 'github', 'instagram', 'mastodon', 'telegram', 'tiktok', 'x', 'youtube'].sort(),
    )
  })

  // These need no credentials — they read public APIs — so they must work on
  // any deployment. A failure here is a real outage, not a config gap.
  it.each(['github', 'mastodon', 'bluesky', 'x', 'telegram', 'tiktok'])(
    'supports %s, which needs no credentials',
    async (platform) => {
      const { body } = await platformsOnce

      expect(body.platforms[platform].supported).toBe(true)
      expect(body.platforms[platform].methods).toContain('proof_post')
    },
  )

  // These are credential-gated. They fail until the secret is installed on the
  // deployment, and that failure is the point: the button exists in the UI.
  it.each([
    ['discord', 'DISCORD_BOT_TOKEN'],
    ['youtube', 'YOUTUBE_API_KEY'],
  ])('supports %s (requires the %s secret on this deployment)', async (platform, secret) => {
    const { body } = await platformsOnce

    expect(
      body.platforms[platform].supported,
      `${platform} reports supported:false — install ${secret}: npx wrangler secret put ${secret}`,
    ).toBe(true)
  })
})

// Quick Connect — linking an account by signing into that platform, with no
// post or gist — exists in code for x, instagram, tiktok and youtube. Whether
// it is *offered* depends on the client secrets installed on this deployment,
// so with none installed the step is omitted and every user is sent down the
// manual proof-post path instead. That is a configuration gap, not a design
// choice, and it should be visible here rather than inferred from a screenshot.
describe('Quick Connect is offered, not silently replaced by manual proof', () => {
  it('renders the OAuth step on the landing page', async () => {
    const page = (await api<string>('/')).text

    expect(
      page,
      'Quick Connect is absent, so every user is asked to post a proof by hand. ' +
        'This deployment is missing TOKEN_ENCRYPTION_KEY plus at least one provider ' +
        "secret. TOKEN_ENCRYPTION_KEY must be byte-identical to the crossposter " +
        'worker\'s: both bind the same D1 and existing tokens are encrypted with it.',
    ).toContain('Quick Connect (no posting)')
  })

  it.each([
    ['Twitter / X', 'TWITTER_CLIENT_ID + TWITTER_CLIENT_SECRET'],
    ['Instagram', 'INSTAGRAM_CLIENT_SECRET'],
  ])('offers %s without requiring a manual post', async (label, secrets) => {
    const page = (await api<string>('/')).text
    const options = page.match(/<select id="oauth-platform-select"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? ''

    expect(options, `${label} Quick Connect needs ${secrets} on this deployment`).toContain(label)
  })
})

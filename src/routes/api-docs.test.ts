// ABOUTME: Tests for the API reference page, including the platform table
// ABOUTME: assertions that used to live against the landing page.
import { describe, it, expect } from 'vitest'
import { renderApiDocsPage } from './api-docs'
import { app } from '../index'
import type { Env } from '../types'

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    CACHE_KV: {} as KVNamespace,
    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: 'test-key',
    ...overrides,
  }
}

const docs = renderApiDocsPage(testEnv(), 'https://verify.divine.video')

describe('API reference page', () => {
  it('is served at /docs', async () => {
    const response = await app.request('/docs', {}, testEnv())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('API Reference')
  })

  it('revalidates like the landing page, so a deploy is visible immediately', async () => {
    const response = await app.request('/docs', {}, testEnv())

    expect(response.headers.get('cache-control')).toContain('no-cache')
  })

  it('carries the endpoint reference that used to crowd the landing page', () => {
    for (const heading of ['About the API', 'Rate Limits', 'NIP-05']) {
      expect(docs).toContain(heading)
    }
  })

  it('renders example URLs against the origin it is served from', () => {
    expect(docs).toContain('https://verify.divine.video')
    expect(docs).not.toContain('https://verifier.divine.video/verify')
  })

  it('points readers back to the page where they can actually verify', () => {
    expect(docs).toContain('href="/#verify-here"')
  })

  it('shares the landing page chrome rather than a second stylesheet', () => {
    expect(docs).toContain('<nav class="topbar">')
    expect(docs).toContain('.platform-pill')
    expect(docs).toContain('aria-current="page"')
  })
})

// Moved here with the table itself. These describe what the reference says
// about each platform, which is documentation, not landing-page behaviour.
describe('API reference platform table', () => {
  const table = (page: string) => page.split('Supported Platforms')[1].split('</table>')[0]

  it('documents every platform the service knows about', () => {
    const rows = table(docs)
    for (const key of ['x', 'instagram', 'youtube', 'tiktok', 'github', 'bluesky', 'mastodon', 'telegram', 'discord']) {
      expect(rows).toContain(`<code>${key}</code>`)
    }
  })

  it('does not advertise Bluesky Quick Connect, which is deferred (#1)', () => {
    const blueskyRow = table(docs).split('<code>bluesky</code>')[1].split('</tr>')[0]

    expect(blueskyRow).not.toContain('>Yes<')
  })

  it('marks Instagram as connect-only, since it has no proof-post verifier', () => {
    const igRow = table(docs).split('<code>instagram</code>')[1].split('</tr>')[0]

    expect(igRow).toContain('Not supported')
  })

  it('asks for a Discord message link, never a server invite', () => {
    const withToken = renderApiDocsPage(testEnv({ DISCORD_BOT_TOKEN: 'bot' }), 'https://verify.divine.video')
    expect(withToken).not.toContain('discord.gg')

    const discordRow = table(withToken).split('<code>discord</code>')[1].split('</tr>')[0]
    expect(discordRow).toContain('Message link')
    expect(discordRow).toContain('DISCORD_BOT_TOKEN')
  })
})

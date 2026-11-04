// ABOUTME: Tests for the crossposter setup page, focused on the manual
// ABOUTME: crosspost button giving feedback before its request returns.
import { describe, it, expect } from 'vitest'
import { renderHome } from './health'
import type { Env } from '../types'

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    CACHE_KV: {} as KVNamespace,
    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://login.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: 'test-key',
    ...overrides,
  }
}

const html = renderHome(testEnv())

// "Post to Instagram Reels" left the button enabled and unlabelled for the
// whole round trip, which reads as nothing having happened and invites a
// second click.
describe('manual crosspost button responds to the click immediately', () => {
  // Anchor on the delegated click handler, not the button markup, which also
  // mentions crosspostVideo.
  const handler = () => html.split('if (target?.dataset?.crosspostVideo)')[1]?.split('});')[0] ?? ''

  it('disables the button and relabels it before awaiting the request', () => {
    const block = handler()
    const disable = block.indexOf('target.disabled = true')
    const await_ = block.indexOf('await triggerCrosspost')

    expect(disable).toBeGreaterThan(-1)
    expect(await_).toBeGreaterThan(-1)
    expect(disable).toBeLessThan(await_)
    expect(block).toContain("target.textContent = 'Sending...'")
  })

  it('ignores a second click while the first is still in flight', () => {
    expect(handler()).toContain('if (target.disabled) return;')
  })

  it('restores the button when the request fails, so it is not left dead', () => {
    const block = handler()
    expect(block).toContain('target.disabled = false')
    expect(block).toContain('target.textContent = previousLabel')
  })
})

// The setup copy told users "provider keys are still off until we add the app
// credentials" long after X and Instagram had credentials installed, and it
// leaked our rollout state into a user-facing page either way.
describe('crossposter setup copy describes the product, not our rollout', () => {
  it('does not claim every provider is switched off', () => {
    expect(html).not.toContain('Provider keys are still off')
    expect(html).not.toContain('Ready providers will unlock here')
  })

  it('tells the reader that connecting also verifies the account', () => {
    // These stopped being two products when the workers merged: a connection
    // now writes a verification, so the page should say so.
    expect(html).toContain('also verifies it on your Divine profile')
  })
})

describe('Instagram destination controls', () => {
  it('offers saved and per-video Story, Reel, and Reel + feed choices', () => {
    expect(html).toContain('data-instagram-default')
    expect(html).toContain('data-instagram-video')
    expect(html).toContain("['story', 'Story']")
    expect(html).toContain("['reel', 'Reel']")
    expect(html).toContain("['reel_feed', 'Reel + feed']")
    expect(html).toContain('Professional Instagram account required')
    expect(html).toContain('Stories expire after 24 hours')
  })
  it('sends the selected per-video destination and preserves it across rerenders', () => {
    expect(html).toContain('instagramVideoDestinations[videoId]')
    expect(html).toContain('instagramDestination: instagramVideoDestination(videoId)')
    expect(html).toContain('instagramVideoDestinations[target.dataset.instagramVideo] = target.value')
    expect(html).toContain('job.instagramDestination')
  })
})

describe('Instagram draft selection follows account settings', () => {
  it('derives untouched video choices from the current default without storing a draft override', () => {
    const rendering = html.split('function renderVideoRows()')[1]?.split('async function pollJobs')[0] || ''
    expect(rendering).not.toContain('instagramVideoDestinations[video.id] =')
    expect(rendering).toContain('instagramVideoDestination(video.id)')
    expect(html).toContain("instagramVideoDestinations[videoId] || preferences.find")
  })
  it('matches an existing job to the connected external account', () => {
    expect(html).toContain('job.externalAccountId === connection.externalAccountId')
  })
})

describe('Instagram per-video choice without a saved default', () => {
  it('keeps the legacy Reel request instead of sending an explicit destination', () => {
    const fallback = html.split('function instagramVideoDestination(videoId)')[1]?.split('}')[0] ?? ''
    expect(fallback).toContain("?.instagramDestination || ''")
    expect(fallback).not.toContain("|| 'reel'")
    expect(html).toContain("platform === 'instagram' && instagramVideoDestination(videoId) ? { instagramDestination")
  })
})

describe('Instagram default destination saves', () => {
  it('queues preference saves so a destination save cannot resend a stale mode', () => {
    const listener = html.split("document.addEventListener('change'")[1]?.split('(async function boot()')[0] ?? ''
    const queued = listener.indexOf('preferenceSaves = preferenceSaves.then(')
    const modeRead = listener.indexOf("preferences.find((item) => item.platform === 'instagram')?.mode")
    expect(html).toContain('let preferenceSaves = Promise.resolve()')
    expect(queued).toBeGreaterThan(-1)
    expect(modeRead).toBeGreaterThan(queued)
  })
})

it('shows reconnect requirements and provider trouble in the signed-in connection list', () => {
  const source = html.split('function renderConnectRows() {')[1].split('function instagramVideoDestination')[0]
  const list = { innerHTML: '' }
  const render = new Function('platforms', 'connections', 'session', 'providerObservations', '$', 'platformName', 'escapeHtml', 'function renderConnectRows() {' + source + ';renderConnectRows();')
  render([{ platform: 'instagram', enabled: true }], [{ platform: 'instagram', status: 'needs_reauth' }], {}, { instagram: { connection: 'degraded', publishing: 'unknown' } }, () => list, () => 'Instagram', (value: string) => value)
  expect(list.innerHTML).toContain('Reconnect')
  expect(list.innerHTML).toContain('Provider is having trouble')
})

describe('Instagram defaults before connecting', () => {
  const preferences = [{ platform: 'instagram', mode: 'automatic', instagramDestination: 'story' }]

  function renderPreferences(status: string, session: object | null = {}, accountLoaded = true): string {
    const list = { innerHTML: '' }
    const source = html.split('function instagramDestinationSelect(')[1].split('function platformName(')[0]
    const render = new Function('platforms', 'connections', 'preferences', 'session', 'accountLoaded', '$', 'platformName', 'escapeHtml',
      'function instagramDestinationSelect(' + source + ';renderPreferenceRows();')
    render([{ platform: 'instagram', enabled: true }], status === 'missing' ? [] : [{ platform: 'instagram', status }], preferences, session, accountLoaded,
      () => list, () => 'Instagram', (value: string) => value)
    return list.innerHTML
  }

  it.each(['missing', 'needs_reauth', 'disconnected'])('allows choosing a destination with a %s connection while posting stays disabled', (status) => {
    const markup = renderPreferences(status)
    const modeSelect = markup.match(/<select data-preference="instagram"[^>]*>/)?.[0]
    const destinationSelect = markup.match(/<select aria-label="Instagram destination"[^>]*>/)?.[0]
    expect(modeSelect).toContain('disabled')
    expect(destinationSelect).toBeDefined()
    expect(destinationSelect).not.toContain(' disabled')
    expect(markup).toContain('<option value="story" selected>Story</option>')
  })

  it('hides destination controls until the signed-in account is loaded', () => {
    expect(renderPreferences('missing', null)).not.toContain('data-instagram-default')
    expect(renderPreferences('missing', {}, false)).not.toContain('data-instagram-default')
  })

  it.each(['missing', 'needs_reauth', 'disconnected', 'connected'])('saves a destination with the safe mode for a %s connection', async (status) => {
    const requests: Array<{ mode: string; instagramDestination: string }> = []
    const save = html.split('async function updatePreference(')[1].split("document.addEventListener('click'")[0]
    const change = html.split("document.addEventListener('change'")[1].split('(async function boot()')[0]
    const handler = new Function('connections', 'preferences', 'api', `
      let preferenceSaves = Promise.resolve();
      let listener;
      const document = { addEventListener: (type, callback) => { listener = callback; } };
      const setStatus = () => {};
      const platformName = () => 'Instagram';
      const refreshAccount = async () => {};
      async function updatePreference(` + save + "document.addEventListener('change'" + change + ';return listener;')
    const changePreference = handler(status === 'missing' ? [] : [{ platform: 'instagram', status }], preferences,
      async (_path: string, options: RequestInit) => { requests.push(JSON.parse(String(options.body))) })
    await changePreference({ target: { dataset: { instagramDefault: 'true' }, value: 'story' } })
    expect(requests).toEqual([{ mode: status === 'connected' ? 'automatic' : 'disabled', instagramDestination: 'story' }])
  })
})

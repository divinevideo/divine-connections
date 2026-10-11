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

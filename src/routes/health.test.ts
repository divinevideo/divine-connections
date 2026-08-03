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

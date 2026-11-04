// ABOUTME: Executes Snapchat controls extracted from the served browser script.
// ABOUTME: Verifies explicit choices, cancellation and immutable submitted destination rendering.
import { describe, expect, it, vi } from 'vitest'
import { renderHome } from './health'
import type { Env } from '../types'
const html = renderHome({} as Env)
const escape = (value: unknown) => String(value).replaceAll('<', '&lt;').replaceAll('"', '&quot;')
describe('Snapchat UI', () => {
  it('offers Spotlight/public Story with saved default and manual override', () => {
    expect(html).toContain('function snapchatVideoDestination')
    const source = html.split('function snapchatVideoDestination(videoId) {')[1]?.split('function youtubeVideoPrivacy')[0]
    const functions = new Function('snapchatVideoDestinations', 'preferences', 'return { destination: function snapchatVideoDestination(videoId) {' + source?.split('function snapchatDestinationSelect')[0] + ', select: function snapchatDestinationSelect' + source?.split('function snapchatDestinationSelect')[1] + '};')({ edited: 'story' }, [{ platform: 'snapchat', snapchatDestination: 'spotlight' }])
    expect(functions.destination('new')).toBe('spotlight'); expect(functions.destination('edited')).toBe('story')
    expect(functions.select('story', 'data-snapchat-video="video"', true)).toContain('disabled')
    expect(functions.select('story', '', false)).toContain('value="story" selected')
  })
  it('requires explicit profile selection and escapes provider names', () => {
    expect(html).toContain('function snapchatProfileMarkup')
    const source = html.split('function snapchatProfileMarkup(data) {')[1]?.split('async function selectSnapchatProfile')[0]
    const markup = new Function('escapeHtml', 'return function snapchatProfileMarkup(data) {' + source)(escape)
    const value = markup({ profiles: [{ id: 'id', name: '<unsafe>' }] })
    expect(value).toContain('value=""'); expect(value).toContain('&lt;unsafe>'); expect(value).not.toContain('<unsafe>'); expect(value).toContain('Confirm public profile')
  })
  it('cancels Snapchat confirmation without sending a job', async () => {
    expect(html).toContain("if (platform === 'snapchat')")
    const source = html.split('async function triggerCrosspost(videoId, platform) {')[1]?.split('async function connectPlatform')[0]
    const api = vi.fn(); const render = vi.fn()
    const fn = new Function('window', 'connections', 'snapchatVideoDestination', 'renderVideoRows', 'api', 'return async function triggerCrosspost(videoId, platform) {' + source)({ confirm: () => false }, [{ platform: 'snapchat', status: 'connected', externalAccountName: 'synthetic' }], () => 'story', render, api)
    await fn('video', 'snapchat'); expect(api).not.toHaveBeenCalled(); expect(render).toHaveBeenCalledOnce()
  })
  it('labels pending Snapchat as processing and public Story as posted only at completion', () => {
    const source = html.split('function jobLabel(job) {')[1]?.split('function renderVideoRows')[0]
    const label = new Function('escapeHtml', 'platformName', 'return function jobLabel(job) {' + source)(escape, () => 'Snapchat')
    expect(label({ platform: 'snapchat', status: 'processing', snapchatDestination: 'spotlight' })).toContain('processing')
    expect(label({ platform: 'snapchat', status: 'posted', snapchatDestination: 'story' })).toContain('public Story')
  })
})

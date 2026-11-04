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

it('submits the exact profile displayed at confirmation even if the cached selection changes', async () => {
  const source = html.split('async function triggerCrosspost(videoId, platform) {')[1]?.split('async function connectPlatform')[0]
  const account = { id: 'conn_a', externalAccountId: 'profile_a', platform: 'snapchat', status: 'connected', externalAccountName: 'Profile A', snapchatProfileConfirmed: true }
  let payload: any
  const api = vi.fn(async (_path, init) => { payload = JSON.parse(init.body); return { jobs: [] } })
  const confirm = vi.fn((message: string) => {
    expect(message).toContain('Profile A')
    account.id = 'conn_b'; account.externalAccountId = 'profile_b'
    return true
  })
  const trigger = new Function('window', 'connections', 'snapchatVideoDestination', 'renderVideoRows', 'api', 'videoJobs', 'setStatus', 'platformName', 'videoPolls', 'clearTimeout', 'setTimeout', 'return async function triggerCrosspost(videoId, platform) {' + source)(
    { confirm }, [account], () => 'story', vi.fn(), api, {}, vi.fn(), () => 'Snapchat', {}, vi.fn(), vi.fn())
  await trigger('video', 'snapchat')
  expect(payload).toMatchObject({ snapchatProfile: { connectionId: 'conn_a', profileId: 'profile_a' }, snapchatDestination: 'story' })
})

it('refreshes connection controls after discovery fails so reconnect is available', async () => {
  const source = html.split('async function selectSnapchatProfile(connectionId) {')[1]?.split('async function triggerCrosspost')[0]
  const refresh = vi.fn(async () => undefined)
  const select = new Function('api', 'refreshAccount', 'return async function selectSnapchatProfile(connectionId) {' + source)(async () => { throw Error('Reconnect Snapchat') }, refresh)
  await expect(select('conn')).rejects.toThrow('Reconnect Snapchat')
  expect(refresh).toHaveBeenCalledOnce()
})

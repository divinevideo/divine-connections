// ABOUTME: Tests for the attribution appended to every crosspost caption, which
// ABOUTME: is the only thing that sends a viewer on another platform back to Divine.
import { describe, expect, it } from 'vitest'
import { buildCrosspostCaption, videoUrlFor } from './attribution'

const EVENT = '48612945f1c96f8740c3131627bc00123a27b669fa6f5f945803bd61ba1e1454'
const LINK = `https://divine.video/video/${EVENT}`

function build(overrides: Partial<Parameters<typeof buildCrosspostCaption>[0]> = {}): string {
  return buildCrosspostCaption({
    caption: 'a cat falls off a shelf',
    eventId: EVENT,
    authorName: 'rabble',
    platform: 'instagram',
    ...overrides,
  })
}

describe('crosspost attribution', () => {
  it('links back to the specific video, not the homepage', () => {
    // A viewer who liked this vine should land on this vine. A homepage link
    // captures a fraction of the same intent.
    expect(videoUrlFor(EVENT)).toBe(LINK)
    expect(build()).toContain(LINK)
  })

  it('credits the creator by handle', () => {
    expect(build()).toContain('@rabble')
  })

  it('keeps the creator caption first', () => {
    const result = build()
    expect(result.startsWith('a cat falls off a shelf')).toBe(true)
    expect(result.indexOf('a cat falls off a shelf')).toBeLessThan(result.indexOf(LINK))
  })

  it('still attributes when the creator wrote no caption', () => {
    const result = build({ caption: '' })
    expect(result).toContain(LINK)
    expect(result).toContain('@rabble')
    expect(result.startsWith('\n')).toBe(false)
  })

  it('still links when the handle is unknown', () => {
    // author_name is best-effort upstream data; losing it must not lose the link.
    const result = build({ authorName: null })
    expect(result).toContain(LINK)
    expect(result).not.toContain('@null')
    expect(result).not.toContain('undefined')
  })
})

// Jobs are recreated on retry and re-verified by the reconciler, so the same
// caption can pass through here more than once.
describe('crosspost attribution is idempotent', () => {
  it('does not append a second time when the link is already present', () => {
    const once = build()
    const twice = build({ caption: once })

    expect(twice).toBe(once)
  })

  it('leaves a caption alone when the creator already linked the video themselves', () => {
    const result = build({ caption: `watch this ${LINK}` })

    expect(result.match(new RegExp(LINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1)
  })
})

// A caption rejected by the platform is a failed crosspost, and the attribution
// is the part we cannot afford to lose, so the creator's text is what gives way.
describe('crosspost attribution respects platform caption limits', () => {
  it('truncates the creator caption rather than the link on X', () => {
    const result = build({ caption: 'x'.repeat(400), platform: 'x' })

    expect(result.length).toBeLessThanOrEqual(280)
    expect(result).toContain(LINK)
    expect(result).toContain('@rabble')
  })

  it('marks where the caption was cut', () => {
    const result = build({ caption: 'y'.repeat(400), platform: 'x' })

    expect(result).toContain('…')
  })

  it('allows a long caption where the platform does', () => {
    const result = build({ caption: 'z'.repeat(1500), platform: 'instagram' })

    expect(result).toContain('z'.repeat(1500))
    expect(result).toContain(LINK)
  })

  it('never returns a caption that is only attribution when the limit is tiny', () => {
    // Degenerate but must not throw or produce a negative slice.
    const result = build({ caption: 'w'.repeat(400), platform: 'x' })

    expect(result.length).toBeGreaterThan(0)
    expect(result).not.toContain('NaN')
  })
})

describe('crosspost attribution can be reshaped without a redeploy', () => {
  it('honours a template from configuration', () => {
    const result = build({ template: 'via {handle} - {url}' })

    expect(result).toContain(`via @rabble - ${LINK}`)
  })

  it('drops the handle placeholder cleanly when there is no handle', () => {
    const result = build({ template: '{handle} {url}', authorName: null })

    expect(result).toContain(LINK)
    expect(result).not.toContain('{handle}')
    expect(result.trim().startsWith('a cat')).toBe(true)
  })

  it('can be switched off entirely', () => {
    const result = build({ template: '' })

    expect(result).toBe('a cat falls off a shelf')
  })

  it('ignores a template that forgets the link, rather than silently dropping it', () => {
    // Attribution with no way back is the failure mode this whole feature
    // exists to prevent, so a malformed template falls back to the default.
    const result = build({ template: 'just some words' })

    expect(result).toContain(LINK)
  })
})

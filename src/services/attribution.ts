// ABOUTME: Appends creator credit and a link back to the video onto every
// ABOUTME: crosspost caption, so distributing content also returns viewers.
import type { Platform } from '../types'

// Crossposting without this exports content to competitors and captures
// nothing: a vine lands on TikTok as a nice video with no creator handle, no
// Divine reference, and no route back. The link is the whole point, so it is
// the part that survives truncation and the part a custom template cannot drop.
const DEFAULT_TEMPLATE = '{handle} on Divine\n{url}'

// The canonical per-video URL, matching the web app's own `/video/:id` route.
// A homepage link captures a fraction of the intent a deep link does: the
// viewer already liked *this* video.
export function videoUrlFor(eventId: string): string {
  return `https://divine.video/video/${encodeURIComponent(eventId)}`
}

// Where a platform rejects an over-long caption the whole crosspost fails, so
// these are enforced before we hand anything over. Conservative on purpose:
// being slightly under a limit costs nothing, being over costs the post.
const CAPTION_LIMITS: Record<string, number> = {
  x: 280,
  instagram: 2_200,
  tiktok: 2_200,
  youtube: 5_000,
}
const DEFAULT_LIMIT = 2_200

export interface CaptionInput {
  caption: string
  eventId: string
  authorName: string | null
  platform: Platform | string
  /** Overrides the default shape. Empty string disables attribution entirely. */
  template?: string
}

function renderAttribution(template: string, handle: string | null, url: string): string {
  return template
    .replace(/\{handle\}/g, handle ? `@${handle}` : '')
    .replace(/\{url\}/g, url)
    // A missing handle leaves stray whitespace where it would have been.
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

export function buildCrosspostCaption(input: CaptionInput): string {
  const caption = (input.caption ?? '').trim()
  const url = videoUrlFor(input.eventId)

  // An explicit empty template is the off switch, distinct from an absent one.
  if (input.template === '') {
    return caption
  }

  // A template that cannot produce a link is a configuration mistake, and
  // silently honouring it would defeat the feature. Fall back instead.
  const template = input.template && input.template.includes('{url}') ? input.template : DEFAULT_TEMPLATE

  // Jobs are recreated on retry and the reconciler re-reads them, so the same
  // caption can arrive here more than once. A creator who linked their own
  // video counts too — one link is enough.
  if (caption.includes(url)) {
    return caption
  }

  const attribution = renderAttribution(template, input.authorName, url)
  const limit = CAPTION_LIMITS[input.platform] ?? DEFAULT_LIMIT
  const separator = caption ? '\n\n' : ''
  const budget = limit - attribution.length - separator.length

  if (!caption) {
    return attribution
  }
  if (caption.length <= budget) {
    return `${caption}${separator}${attribution}`
  }
  // The creator's words give way, never the link. One character is reserved
  // for the ellipsis so the cut is visible rather than looking like a bug.
  const room = Math.max(0, budget - 1)
  if (room === 0) {
    return attribution
  }
  return `${caption.slice(0, room)}…${separator}${attribution}`
}

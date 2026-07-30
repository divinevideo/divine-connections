// ABOUTME: Merged platform info for the verifier surface /platforms: supported =
// ABOUTME: OAuth-enabled OR proof-capable, with a methods array so clients can tell.
import type { Context } from 'hono'
import type { Env, VerificationPlatform } from '../types'
import { getProviderSummaries } from '../platforms/registry'

export interface VerificationPlatformInfo {
  label: string
  supported: boolean
  methods: Array<'oauth' | 'proof_post'>
}

const LABELS: Record<VerificationPlatform, string> = {
  x: 'Twitter / X',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  bluesky: 'Bluesky',
  github: 'GitHub',
  mastodon: 'Mastodon',
  telegram: 'Telegram',
  discord: 'Discord',
}

export function getVerificationPlatformInfo(env: Env): { platforms: Record<VerificationPlatform, VerificationPlatformInfo> } {
  const oauthEnabled = new Map(getProviderSummaries(env).map((summary) => [summary.platform, summary.enabled]))
  const oauth = (platform: 'x' | 'instagram' | 'tiktok' | 'youtube'): boolean => oauthEnabled.get(platform) === true

  const methods = (platform: 'x' | 'instagram' | 'tiktok' | 'youtube', proofCapable: boolean): Array<'oauth' | 'proof_post'> => [
    ...(oauth(platform) ? (['oauth'] as const) : []),
    ...(proofCapable ? (['proof_post'] as const) : []),
  ]

  const proofOnly = { supported: true, methods: ['proof_post'] as Array<'oauth' | 'proof_post'> }

  return {
    platforms: {
      x: { label: LABELS.x, supported: true, methods: methods('x', true) },
      instagram: { label: LABELS.instagram, supported: oauth('instagram'), methods: ['oauth'] },
      tiktok: { label: LABELS.tiktok, supported: true, methods: methods('tiktok', true) },
      youtube: {
        label: LABELS.youtube,
        supported: oauth('youtube') || Boolean(env.YOUTUBE_API_KEY),
        methods: methods('youtube', Boolean(env.YOUTUBE_API_KEY)),
      },
      bluesky: { label: LABELS.bluesky, ...proofOnly },
      github: { label: LABELS.github, ...proofOnly },
      mastodon: { label: LABELS.mastodon, ...proofOnly },
      telegram: { label: LABELS.telegram, ...proofOnly },
      // Discord resolves the proof message through the bot API; server invites cannot
      // bind an account, so without the bot token there is no verification path.
      discord: {
        label: LABELS.discord,
        supported: Boolean(env.DISCORD_BOT_TOKEN),
        methods: env.DISCORD_BOT_TOKEN ? ['proof_post'] : [],
      },
    },
  }
}

// Verifier-host GET /platforms handler; mounted by host dispatch.
export function platformsInfoHandler(c: Context<{ Bindings: Env }>): Response {
  return c.json(getVerificationPlatformInfo(c.env))
}

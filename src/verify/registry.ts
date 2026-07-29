// ABOUTME: Factory + platform info for the stateless proof-post verifiers.
// ABOUTME: Tokens come from Env; a platform without its token reports supported:false.
import type { Env } from '../types'
import { GitHubVerifier } from './github'
import { TwitterVerifier } from './twitter'
import { MastodonVerifier } from './mastodon'
import { TelegramVerifier } from './telegram'
import { DiscordVerifier } from './discord'
import { BlueskyVerifier } from './bluesky'
import { YouTubeVerifier } from './youtube'
import { TikTokVerifier } from './tiktok'
import type { PlatformVerifier } from './base'
import type { VerificationPlatform } from '../types'

export function getProofVerifier(platform: VerificationPlatform, env: Env): PlatformVerifier {
  switch (platform) {
    case 'github': return new GitHubVerifier(env.GITHUB_TOKEN)
    case 'x': return new TwitterVerifier()
    case 'mastodon': return new MastodonVerifier()
    case 'telegram': return new TelegramVerifier()
    case 'discord': return new DiscordVerifier(env.DISCORD_BOT_TOKEN, env.DISCORD_VERIFY_CHANNEL_ID)
    case 'bluesky': return new BlueskyVerifier()
    case 'youtube': return new YouTubeVerifier(env.YOUTUBE_API_KEY)
    case 'tiktok': return new TikTokVerifier()
    default: throw new Error(`no proof-post verifier for platform: ${platform}`)
  }
}

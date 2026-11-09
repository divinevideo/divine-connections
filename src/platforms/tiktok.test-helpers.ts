// ABOUTME: Provides complete synthetic TikTok confirmation fixtures for provider tests.
// ABOUTME: Keeps consent and current creator settings explicit in publishing test inputs.
import type { TikTokCreatorInfo, TikTokPostOptions } from '../types'
export const TIKTOK_CREATOR: TikTokCreatorInfo = {
  creator_username: 'synthetic.creator', creator_nickname: 'Synthetic Creator',
  privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
  comment_disabled: false, duet_disabled: false, stitch_disabled: false,
  max_video_post_duration_sec: 60,
}
export function tiktokOptions(overrides: Partial<TikTokPostOptions> = {}): TikTokPostOptions {
  return { connectionId: 'conn_1', creatorInfo: TIKTOK_CREATOR, privacyLevel: 'SELF_ONLY',
    allowComment: false, allowDuet: false, allowStitch: false, commercialContent: false,
    brandOrganic: false, brandContent: false, confirmedCaption: 'caption', musicUsageConfirmed: true,
    brandedContentConfirmed: false, durationSeconds: 6, ...overrides }
}

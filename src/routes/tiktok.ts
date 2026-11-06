// ABOUTME: Exposes TikTok confirmation data solely on the authenticated publishing surface.
// ABOUTME: Never returns OAuth tokens or starts uploads while a creator previews a video.
import { Hono } from 'hono'
import { authenticateRequest } from '../auth/keycast'
import { currentTikTokCreatorInfo } from '../services/tiktok-posting'
import { getTikTokSourcePreview } from '../services/crossposts'
import type { Env } from '../types'
import { errorResponse, jsonResponse } from '../utils/http'

export const tiktok = new Hono<{ Bindings: Env }>()
tiktok.get('/connections/tiktok/creator-info', async c => {
  try {
    const { pubkey } = await authenticateRequest(c.req.raw, c.env)
    const response = jsonResponse(await currentTikTokCreatorInfo(c.env, pubkey))
    response.headers.set('cache-control', 'no-store')
    return response
  } catch (error) { return errorResponse(error) }
})
tiktok.get('/videos/:event_id/tiktok-preview', async c => {
  try {
    const { pubkey } = await authenticateRequest(c.req.raw, c.env)
    const response = jsonResponse(await getTikTokSourcePreview(c.env, pubkey, c.req.param('event_id')))
    response.headers.set('cache-control', 'no-store')
    return response
  } catch (error) { return errorResponse(error) }
})

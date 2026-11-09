// ABOUTME: Exposes authenticated Snapchat publishing profile selection.
// ABOUTME: Mounted only on the publishing surface, with no credential values in responses.
import { Hono } from 'hono'
import { authenticateRequest } from '../auth/keycast'
import { confirmSnapchatProfile, listSnapchatProfiles } from '../services/snapchat-profiles'
import type { Env } from '../types'
import { errorResponse, jsonResponse } from '../utils/http'
export const snapchat = new Hono<{ Bindings: Env }>()
snapchat.get('/connections/snapchat/:connection_id/profiles', async c => {
  try {
    const { pubkey } = await authenticateRequest(c.req.raw, c.env)
    const response = jsonResponse(await listSnapchatProfiles(c.env, pubkey, c.req.param('connection_id')))
    response.headers.set('cache-control', 'no-store'); return response
  } catch (error) { return errorResponse(error) }
})
snapchat.post('/connections/snapchat/:connection_id/profile', async c => {
  try {
    const { pubkey } = await authenticateRequest(c.req.raw, c.env)
    return jsonResponse(await confirmSnapchatProfile(c.env, pubkey, c.req.param('connection_id'), await c.req.raw.clone().json()))
  } catch (error) { return errorResponse(error) }
})

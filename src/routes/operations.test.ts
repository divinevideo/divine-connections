// ABOUTME: Checks operator authorization and user isolation for durable diagnostics.
// ABOUTME: Runs against the real worker routes and D1 database.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import { applyMigrations, PUBKEY_A, PUBKEY_B } from '../db/test-helpers'
import { recordDiagnostic } from '../services/reliability'
import { startConnection, completeConnectionCallback } from '../services/connections'
import type { Env } from '../types'
let env: Env
const ctx = {} as ExecutionContext
beforeEach(async () => {
 env = { DB: await applyMigrations(), CACHE_KV: {} as KVNamespace, CROSSPOST_QUEUE: {} as Queue<{jobId:string}>, KEYCAST_URL:'https://login.divine.video', FUNNELCAKE_URL:'https://api.divine.video', OAUTH_REDIRECT_BASE:'https://crossposter.divine.video', TOKEN_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef', ENABLE_INSTAGRAM:'true', INSTAGRAM_CLIENT_ID:'example-client', INSTAGRAM_CLIENT_SECRET:'example-secret', OPS_OPERATOR_PUBKEYS:PUBKEY_A }
 vi.stubGlobal('fetch', vi.fn(async () => Response.json({result:PUBKEY_A})))
})
afterEach(() => vi.unstubAllGlobals())
function request(path: string, auth = true, host = 'crossposter.divine.video') {
 return worker.fetch(new Request('https://'+host+path, {headers:auth?{authorization:'Bearer example'}:{}}), env, ctx)
}
describe('operations access', () => {
 it('requires authentication and explicit operator authorization', async () => {
  expect((await request('/operations/data', false)).status).toBe(401)
  env.OPS_OPERATOR_PUBKEYS=PUBKEY_B
  expect((await request('/operations/data')).status).toBe(403)
  env.OPS_OPERATOR_PUBKEYS=PUBKEY_A
  expect((await request('/operations/data')).status).toBe(200)
  expect((await request('/operations/data', true, 'verify.divine.video')).status).toBe(404)
 })
 it('serves a data-free page and non-cacheable private data', async () => {
  await recordDiagnostic(env,{reference:'private-reference',platform:'instagram',operation:'connect',stage:'failed',outcome:'failed',now:1000})
  const page=await request('/operations',false)
  expect(await page.text()).not.toContain('private-reference')
  const data=await request('/operations/data')
  expect(data.headers.get('cache-control')).toBe('no-store')
  expect(await data.text()).toContain('private-reference')
 })
})
describe('OAuth diagnostics', () => {
 it('pins the callback at start, retains provider rejection and returns a support reference', async () => {
  const started=await startConnection(new Request('https://crossposter.divine.video/connections/instagram/start',{headers:{authorization:'Bearer example'}}),env,'instagram','https://crossposter.divine.video/')
  const initial=new URL(started.authorizationUrl).searchParams.get('redirect_uri')
  const calls: string[]=[]
  vi.stubGlobal('fetch',vi.fn(async (_url, options) => {
   calls.push(new URLSearchParams(options.body).get('redirect_uri') ?? '')
   return Response.json({error_type:'OAuthException',code:400,error_message:'The redirect_uri does not match the authorization request.'},{status:400})
  }))
  env.OAUTH_REDIRECT_BASE='https://verify.divine.video'
  const result=new URL(await completeConnectionCallback(env,'instagram','secret-code',started.state))
  expect(calls).toEqual([initial])
  expect(result.searchParams.get('support')).toMatch(/^oauth_attempt_/)
  const row=await env.DB.prepare("SELECT diagnostic_json FROM operation_diagnostics WHERE outcome='failed'").first<{diagnostic_json:string}>()
  expect(row?.diagnostic_json).toContain('redirect_uri does not match')
  expect(row?.diagnostic_json).not.toContain('secret-code')
 })
})

it('fails closed on application changes and does not send the code to another app',async()=>{
 const started=await startConnection(new Request('https://crossposter.divine.video/connections/instagram/start',{headers:{authorization:'Bearer example'}}),env,'instagram','https://crossposter.divine.video/')
 env.INSTAGRAM_CLIENT_ID='different-client'
 const provider=vi.fn();vi.stubGlobal('fetch',provider)
 const result=new URL(await completeConnectionCallback(env,'instagram','secret-code',started.state))
 expect(result.searchParams.get('reason')).toBe('callback_failed')
 expect(provider).not.toHaveBeenCalled()
 const response=await env.DB.prepare("SELECT diagnostic_json FROM operation_diagnostics WHERE outcome='failed'").first<{diagnostic_json:string}>()
 expect(response?.diagnostic_json).toContain('application changed')
})
it('isolates support references between users and omits provider details from owner responses',async()=>{
 const started=await startConnection(new Request('https://crossposter.divine.video/connections/instagram/start',{headers:{authorization:'Bearer example'}}),env,'instagram','https://crossposter.divine.video/')
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error_type:'OAuthException',code:400,error_message:'redirect_uri mismatch'},{status:400})))
 const reference=new URL(await completeConnectionCallback(env,'instagram','secret-code',started.state)).searchParams.get('support')!
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({result:PUBKEY_B})))
 expect((await request('/support/'+reference)).status).toBe(404)
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({result:PUBKEY_A})))
 const response=await request('/support/'+reference)
 expect(response.status).toBe(200)
 const text=await response.text()
 expect(text).toContain('token_exchange_failed')
 expect(text).not.toContain('redirect_uri mismatch')
})

it('reports readiness failure for a missing scheduler heartbeat or alert configuration',async()=>{
 const before=await request('/readiness',false)
 expect(before.status).toBe(503)
 await env.DB.prepare('INSERT INTO reliability_monitor (id,checked_at) VALUES (1,?)').bind(Math.floor(Date.now()/1000)).run()
 env.OPS_ALERT_WEBHOOK_URL='https://alerts.example/secret'
 const ready=await request('/readiness',false)
 expect(ready.status).toBe(200)
 expect(await ready.text()).not.toContain('alerts.example')
})

it('pins TikTok client_key and rejects a changed TikTok application before token exchange',async()=>{
 Object.assign(env,{ENABLE_TIKTOK:'true',TIKTOK_CLIENT_KEY:'first-client',TIKTOK_CLIENT_SECRET:'test-secret'})
 const started=await startConnection(new Request('https://crossposter.divine.video/connections/tiktok/start',{headers:{authorization:'Bearer example'}}),env,'tiktok','https://crossposter.divine.video/')
 env.TIKTOK_CLIENT_KEY='second-client'
 const provider=vi.fn();vi.stubGlobal('fetch',provider)
 const result=new URL(await completeConnectionCallback(env,'tiktok','secret-code',started.state))
 expect(result.searchParams.get('reason')).toBe('callback_failed')
 expect(provider).not.toHaveBeenCalled()
})

it('retains incomplete callbacks without treating them as observed provider failures', async () => {
 for (let i = 0; i < 3; i++) {
  const started = await startConnection(new Request('https://crossposter.divine.video/connections/instagram/start', { headers: { authorization: 'Bearer example' } }), env, 'instagram', 'https://crossposter.divine.video/')
  await completeConnectionCallback(env, 'instagram', null, started.state)
 }
 const { providerHealth, recentDiagnostics } = await import('../services/reliability')
 const rows = await recentDiagnostics(env.DB)
 expect(rows.filter(row => row.stage === 'callback_failed')).toHaveLength(3)
 expect(rows.filter(row => row.stage === 'callback_failed').every(row => row.outcome === 'abandoned')).toBe(true)
 expect((await providerHealth(env.DB, Math.floor(Date.now() / 1000))).instagram.connection).toBe('unknown')
})

it.each([
 { error: 'invalid_grant', error_description: 'The authorization grant is invalid.' },
 { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' },
])('retains rejected authorization grants without degrading observed health: %j', async body => {
 for (let i = 0; i < 3; i++) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ result: PUBKEY_A })))
  const started = await startConnection(new Request('https://crossposter.divine.video/connections/instagram/start', { headers: { authorization: 'Bearer example' } }), env, 'instagram', 'https://crossposter.divine.video/')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 400 })))
  await completeConnectionCallback(env, 'instagram', 'synthetic-code', started.state)
 }
 const { providerHealth, recentDiagnostics } = await import('../services/reliability')
 expect((await recentDiagnostics(env.DB)).filter(row => row.stage === 'token_exchange_failed' && row.outcome === 'abandoned')).toHaveLength(3)
 expect((await providerHealth(env.DB, Math.floor(Date.now() / 1000))).instagram.connection).toBe('unknown')
})

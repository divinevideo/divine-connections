// ABOUTME: Verifies durable diagnostics, access boundaries, and observed provider health.
// ABOUTME: Exercises real D1 storage without retaining provider credentials.
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../db/test-helpers'
import { recordDiagnostic, providerHealth, recentDiagnostics, pruneDiagnostics } from './reliability'
import { PlatformAdapterError } from '../platforms/adapter'

describe('durable diagnostics', () => {
  let db: D1Database
  beforeEach(async () => { db = await applyMigrations() })
  it('retains the failure reason while discarding raw secrets and identity fields', async () => {
    await recordDiagnostic({ DB: db }, { reference: 'example-attempt', platform: 'instagram', operation: 'connect', stage: 'token_exchange_failed', outcome: 'failed', now: 1000,
      error: new PlatformAdapterError('instagram', 'unknown_platform_error', 'failed', 400, {
        error: { code: 100, error_subcode: 36008, type: 'OAuthException', message: 'Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request. access_token=secretvalue person@example.com 192.0.2.1' },
        access_token: 'never-store-this', user_id: 'private-account',
      }),
    })
    const rows = await recentDiagnostics(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].diagnostic.code).toBe(100)
    expect(rows[0].diagnostic.message).toContain('redirect_uri')
    const serialized = JSON.stringify(rows)
    for (const secret of ['secretvalue', 'person@example.com', '192.0.2.1', 'never-store-this', 'private-account']) expect(serialized).not.toContain(secret)
  })
  it('does not call absence of evidence healthy, and excludes abandonment', async () => {
    expect((await providerHealth(db, 1000)).instagram.connection).toBe('unknown')
    for (let i=0;i<3;i++) await recordDiagnostic({ DB: db }, { reference: 'a'+i, platform: 'instagram', operation: 'connect', stage: 'token_exchange_failed', outcome: 'failed', now: 1000 })
    expect((await providerHealth(db, 1001)).instagram.connection).toBe('degraded')
    expect((await providerHealth(db, 1001)).instagram.publishing).toBe('unknown')
    expect((await providerHealth(db, 1000+86401)).instagram.connection).toBe('unknown')
  })
  it('deletes diagnostic data after thirty days', async () => {
    await recordDiagnostic({ DB: db }, { reference: 'old', platform: 'x', operation: 'publish', stage: 'publish', outcome: 'failed', now: 1 })
    await pruneDiagnostics(db, 31*86400)
    expect(await recentDiagnostics(db)).toEqual([])
  })
})

import { checkProviderReliability } from './reliability'
import { vi, afterEach } from 'vitest'
import type { Env } from '../types'
afterEach(() => vi.unstubAllGlobals())
describe('reliability alerts', () => {
 it('alerts without a DLQ, retries failed delivery, then suppresses repeats', async () => {
  const db=await applyMigrations()
  const env={DB:db,OPS_ALERT_WEBHOOK_URL:'https://alerts.example/secret'} as Env
  for(let i=0;i<3;i++) await recordDiagnostic(env,{reference:'test-'+i,platform:'instagram',operation:'connect',stage:'token_exchange_failed',outcome:'failed',now:1000})
  const fetchMock=vi.fn().mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValue(new Response())
  vi.stubGlobal('fetch',fetchMock)
  await expect(checkProviderReliability(env,1001)).rejects.toThrow('delivery failed')
  await checkProviderReliability(env,1002)
  await checkProviderReliability(env,1003)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(String(fetchMock.mock.calls[1][1].body)).toContain('instagram')
  expect(String(fetchMock.mock.calls[1][1].body)).not.toContain('test-')
  const row=await db.prepare('SELECT last_delivered_at FROM reliability_alerts').first()
  expect(row?.last_delivered_at).toBe(1002)
 })
 it('does not report successful delivery when the webhook is absent',async()=>{
  const db=await applyMigrations()
  for(let i=0;i<3;i++) await recordDiagnostic({DB:db},{reference:'test-'+i,platform:'instagram',operation:'connect',stage:'token_exchange_failed',outcome:'failed',now:1000})
  await expect(checkProviderReliability({DB:db} as Env,1001)).rejects.toThrow('not configured')
 })
})

it('counts distinct attempts, and a successful retry resolves that job failure',async()=>{
 const db=await applyMigrations()
 for(let i=0;i<5;i++) await recordDiagnostic({DB:db},{reference:'same-job',platform:'instagram',operation:'publish',stage:'publish',outcome:'failed',now:1000+i})
 expect((await providerHealth(db,1005)).instagram.publishingFailures).toBe(1)
 await recordDiagnostic({DB:db},{reference:'same-job',platform:'instagram',operation:'publish',stage:'posted',outcome:'succeeded',now:1006})
 expect((await providerHealth(db,1007)).instagram.publishing).toBe('healthy')
 expect((await providerHealth(db,1007)).instagram.publishingFailures).toBe(0)
})
it('delivers a single alert when scheduled invocations overlap',async()=>{
 const db=await applyMigrations()
 const env={DB:db,OPS_ALERT_WEBHOOK_URL:'https://alerts.example/secret'} as Env
 for(let i=0;i<3;i++) await recordDiagnostic(env,{reference:'test-'+i,platform:'instagram',operation:'connect',stage:'token_exchange_failed',outcome:'failed',now:1000})
 const fetchMock=vi.fn().mockImplementation(async()=>new Response());vi.stubGlobal('fetch',fetchMock)
 await Promise.all([checkProviderReliability(env,1001),checkProviderReliability(env,1001)])
 expect(fetchMock).toHaveBeenCalledOnce()
})

it('redacts short labeled credentials and synthetic provider object identifiers',async()=>{
 const db=await applyMigrations()
 await recordDiagnostic({DB:db},{reference:'synthetic',platform:'instagram',operation:'connect',stage:'token_exchange_failed',outcome:'failed',now:1000,error:new PlatformAdapterError('instagram','unknown_platform_error','failed',400,{error:{message:"Invalid authorization code abcdefghijklmnop. Object with ID '17841400000000000' does not exist"}})})
 const text=JSON.stringify(await recentDiagnostics(db))
 expect(text).not.toContain('abcdefghijklmnop')
 expect(text).not.toContain('17841400000000000')
})
it('alerts when a connection requires reauthorization, including after refresh failure',async()=>{
 const db=await applyMigrations()
 const {upsertConnection}=await import('../db/connections')
 const {connection}=await import('../db/test-helpers')
 await upsertConnection(db,connection({platform:'instagram',status:'needs_reauth'}))
 const fetchMock=vi.fn().mockImplementation(async()=>new Response());vi.stubGlobal('fetch',fetchMock)
 await checkProviderReliability({DB:db,OPS_ALERT_WEBHOOK_URL:'https://alerts.example/secret'} as Env,1001)
 expect(fetchMock).toHaveBeenCalledOnce()
 expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('reconnect_required')
})

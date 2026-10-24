// ABOUTME: Persists redacted operation evidence and derives recent provider health.
// ABOUTME: Keeps diagnostic retention and aggregate health independent of live logs.
import { allPrepared } from '../db/client'
import { PlatformAdapterError } from '../platforms/adapter'
import { providerErrorDiagnostics } from '../utils/provider-error-diagnostics'
import type { Env, Platform } from '../types'

export type DiagnosticInput = {
  reference: string; platform: Platform; operation: 'connect' | 'publish' | 'refresh'
  configuration?: { callbackUri: string; clientId: string | null };
  stage: string; outcome: 'started' | 'succeeded' | 'failed' | 'abandoned'; now: number; error?: unknown
}
export async function recordDiagnostic(env: Pick<Env, 'DB' | 'RELEASE_SHA'> & Partial<Env>, input: DiagnosticInput): Promise<void> {
  const diagnostic = { ...(providerErrorDiagnostics(input.error) ?? {}), ...(input.configuration ? { configuration: input.configuration } : {}) }
  const secrets = [env.INSTAGRAM_CLIENT_SECRET, env.TWITTER_CLIENT_SECRET, env.TIKTOK_CLIENT_SECRET, env.GOOGLE_CLIENT_SECRET, env.TOKEN_ENCRYPTION_KEY].filter((value): value is string => Boolean(value))
  function scrub(value: unknown): unknown {
    if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry)]))
    return value
  }
  const serialized = JSON.stringify(scrub(diagnostic))
  await env.DB.prepare(`INSERT INTO operation_diagnostics
    (id,reference,platform,operation,stage,outcome,provider_status,diagnostic_json,release,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), input.reference, input.platform, input.operation,
    input.stage, input.outcome, input.error instanceof PlatformAdapterError ? input.error.providerStatus ?? null : null,
    serialized, env.RELEASE_SHA ?? 'unknown', input.now).run()
}
// A diagnostic write must never turn a completed external post into a retry.
export async function recordDiagnosticSafely(env: Env, input: DiagnosticInput): Promise<void> {
  try { await recordDiagnostic(env, input) } catch { console.error('operation_diagnostic_write_failed') }
}
export async function recentDiagnostics(db: D1Database, reference?: string) {
  const rows = await allPrepared<{ reference: string; platform: Platform; operation: string; configuration?: { callbackUri: string; clientId: string | null };
  stage: string; outcome: string; provider_status: number | null; diagnostic_json: string; release: string; created_at: number }>(db,
    `SELECT reference,platform,operation,stage,outcome,provider_status,diagnostic_json,release,created_at
     FROM operation_diagnostics ${reference ? 'WHERE reference = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 100`,
    ...(reference ? [reference] : []))
  return rows.map(({ diagnostic_json, ...row }) => ({ ...row, diagnostic: JSON.parse(diagnostic_json) }))
}
export async function pruneDiagnostics(db: D1Database, now: number): Promise<void> {
  await db.prepare('DELETE FROM operation_diagnostics WHERE created_at < ?').bind(now - 30 * 86400).run()
}
export type ObservedHealth = 'unknown' | 'healthy' | 'degraded'
export async function providerHealth(db: D1Database, now: number) {
  const rows = await allPrepared<{ platform: Platform; operation: string; failures: number; successes: number; last_success: number | null }>(db,
    `SELECT platform,operation,SUM(failed) AS failures,SUM(succeeded) AS successes,
     MAX(last_success) AS last_success
     FROM (SELECT platform,operation,reference,
       CASE WHEN SUM(outcome='succeeded')>0 THEN 0 ELSE 1 END AS failed,
       CASE WHEN SUM(outcome='succeeded')>0 THEN 1 ELSE 0 END AS succeeded,
       MAX(CASE WHEN outcome='succeeded' THEN created_at END) AS last_success
       FROM operation_diagnostics WHERE created_at >= ? AND outcome IN ('failed','succeeded')
       GROUP BY platform,operation,reference) GROUP BY platform,operation`, now - 86400)
  const health = Object.fromEntries(['instagram','tiktok','x','youtube'].map(platform => [platform, {
    connection: 'unknown' as ObservedHealth, publishing: 'unknown' as ObservedHealth,
    connectionFailures: 0, publishingFailures: 0, lastConnectionSuccess: null as number | null, lastPublishSuccess: null as number | null,
  }])) as Record<Platform, { connection: ObservedHealth; publishing: ObservedHealth; connectionFailures: number; publishingFailures: number; lastConnectionSuccess: number | null; lastPublishSuccess: number | null }>
  for (const row of rows) {
    const h = health[row.platform]
    if (!h || !['connect','publish'].includes(row.operation)) continue
    const state: ObservedHealth = row.failures >= 3 && row.failures > row.successes ? 'degraded' : row.successes > 0 ? 'healthy' : 'unknown'
    if (row.operation === 'connect') Object.assign(h, { connection: state, connectionFailures: row.failures, lastConnectionSuccess: row.last_success })
    else Object.assign(h, { publishing: state, publishingFailures: row.failures, lastPublishSuccess: row.last_success })
  }
  return health
}

export async function checkProviderReliability(env: Env, now: number): Promise<void> {
  await pruneDiagnostics(env.DB, now)
  const providers = await providerHealth(env.DB, now)
  const expired = await allPrepared<{ platform: Platform; status: string; count: number }>(env.DB,
    "SELECT platform,status,COUNT(*) AS count FROM connections WHERE status='needs_reauth' OR (status='connected' AND token_expires_at IS NOT NULL AND token_expires_at < ? AND (encrypted_refresh_token IS NULL OR platform='instagram')) GROUP BY platform,status", now)
  const issues: { key: string; platform: Platform; issue: string; count: number }[] = []
  for (const [platform, h] of Object.entries(providers) as [Platform, typeof providers[Platform]][]) {
    if (h.connection === 'degraded') issues.push({ key: platform+':connect', platform, issue:'connection_failures', count:h.connectionFailures })
    if (h.publishing === 'degraded') issues.push({ key: platform+':publish', platform, issue:'publishing_failures', count:h.publishingFailures })
  }
  for (const row of expired) issues.push({ key:row.platform+':'+row.status,platform:row.platform,issue:row.status === 'needs_reauth' ? 'reconnect_required' : 'expired_credentials',count:row.count })
  if (!issues.length) return
  if (!env.OPS_ALERT_WEBHOOK_URL) throw new Error('reliability alert webhook not configured')
  for (const item of issues) {
    // Atomic lease avoids duplicate sends from overlapping scheduled executions.
    const claim=await env.DB.prepare(`INSERT INTO reliability_alerts(alert_key,lease_until) VALUES (?,?)
      ON CONFLICT(alert_key) DO UPDATE SET lease_until=excluded.lease_until
      WHERE reliability_alerts.lease_until <= ? AND (last_delivered_at IS NULL OR last_delivered_at <= ?)`)
      .bind(item.key,now+60,now,now-3600).run()
    if (!claim.meta.changes) continue
    try {
      const response=await fetch(env.OPS_ALERT_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),
        body:JSON.stringify({service:'divine-connections',issue:item.issue,platform:item.platform,count:item.count,observedAt:now,operationsUrl:'https://crossposter.divine.video/operations'})})
      if(!response.ok) throw new Error('delivery failed')
      await env.DB.prepare('UPDATE reliability_alerts SET last_delivered_at=?,lease_until=0,last_error_at=NULL WHERE alert_key=? AND lease_until=?').bind(now,item.key,now+60).run()
    } catch {
      await env.DB.prepare('UPDATE reliability_alerts SET last_error_at=?,lease_until=0 WHERE alert_key=? AND lease_until=?').bind(now,item.key,now+60).run()
      throw new Error('reliability alert delivery failed')
    }
  }
}

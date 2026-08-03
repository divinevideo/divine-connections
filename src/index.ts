// ABOUTME: Worker entry: host-based dispatch between the verifier public surface
// ABOUTME: and the crossposter publishing API over one shared core; plus queue
// and scheduled handlers.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { connections } from './routes/connections'
import { crossposts } from './routes/crossposts'
import { health } from './routes/health'
import { landing } from './routes/landing'
import { apiDocs } from './routes/api-docs'
import { platforms } from './routes/platforms'
import { preferences } from './routes/preferences'
import verify from './routes/verify'
import { verified } from './routes/verified'
import nip05 from './routes/nip05'
import { platformsInfoHandler } from './verify/platforms-info'
import { webhooks } from './routes/webhooks'
import { processCrosspostJob, PublisherRetryError } from './services/publisher'
import { runAutoCrosspostReconciliation } from './services/reconciler'
import { runOperationalChecks } from './services/operations'
import type { Env } from './types'

// The crossposter publishing API, exactly as served today on crossposter.divine.video.
const crossposterApp = new Hono<{ Bindings: Env }>()
crossposterApp.route('/', health)
crossposterApp.route('/', platforms)
crossposterApp.route('/', connections)
crossposterApp.route('/', preferences)
crossposterApp.route('/', crossposts)
crossposterApp.route('/', webhooks)

// The verifier public surface: public verification API, badge reads, landing
// page, and the same keycast-authenticated connection routes on this domain.
const verifierApp = new Hono<{ Bindings: Env }>()
verifierApp.use('*', cors({ origin: '*' }))
verifierApp.route('/', landing)
verifierApp.route('/', apiDocs)
verifierApp.route('/verify', verify)
verifierApp.route('/', verified)
verifierApp.route('/nip05', nip05)
verifierApp.get('/platforms', platformsInfoHandler)
verifierApp.get('/health', (c) => c.json({ status: 'ok', service: 'divine-connections', timestamp: Math.floor(Date.now() / 1000) }))
verifierApp.route('/', connections)

// Alias: POST /api/verify → single claim verification (divine-web compatibility)
verifierApp.post('/api/verify', async (c) => {
  // Rewrite as a subrequest to /verify/single
  const url = new URL(c.req.url)
  url.pathname = '/verify/single'
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return verifierApp.fetch(newReq, c.env)
})

// Both public verification hostnames. keycast has each registered as a
// redirect_uri for the 'Divine Identity Verification' client, and it matches
// redirect URIs as whole strings — so sign-in only works from a host in this
// set. Anything else falls through to the union below, where the crossposter
// publishing surface would also be exposed.
const VERIFIER_HOSTS = new Set(['verifier.divine.video', 'verify.divine.video'])

// Fallback (workers.dev, localhost): union of both surfaces; the verifier shape
// wins the colliding /, /platforms, and /health paths.
const fallbackApp = new Hono<{ Bindings: Env }>()
fallbackApp.route('/', verifierApp)
fallbackApp.route('/', crossposterApp)

const app = fallbackApp

export { app }

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const host = new URL(request.url).hostname
    if (VERIFIER_HOSTS.has(host)) return verifierApp.fetch(request, env, ctx)
    if (host === 'crossposter.divine.video') return crossposterApp.fetch(request, env, ctx)
    return fallbackApp.fetch(request, env, ctx)
  },
  async queue(batch: MessageBatch<{ jobId: string }>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        const result = await processCrosspostJob(env, message.body.jobId)
        if (result.retryDelaySeconds) {
          await env.CROSSPOST_QUEUE.send({ jobId: message.body.jobId }, { delaySeconds: result.retryDelaySeconds })
        }
        message.ack()
      } catch (error) {
        if (error instanceof PublisherRetryError) {
          await env.CROSSPOST_QUEUE.send({ jobId: message.body.jobId }, { delaySeconds: error.retryDelaySeconds })
          message.ack()
        } else {
          throw error
        }
      }
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const failures: unknown[] = []
    try {
      await runAutoCrosspostReconciliation(env)
    } catch (error) {
      failures.push(error)
    }
    try {
      await runOperationalChecks(env, Math.floor(Date.now() / 1_000))
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'scheduled reconciliation and operational checks failed')
    }
  },
}

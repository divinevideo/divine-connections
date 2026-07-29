import { Hono } from 'hono'
import { connections } from './routes/connections'
import { crossposts } from './routes/crossposts'
import { health } from './routes/health'
import { platforms } from './routes/platforms'
import { preferences } from './routes/preferences'
import verify from './routes/verify'
import { webhooks } from './routes/webhooks'
import { processCrosspostJob, PublisherRetryError } from './services/publisher'
import { runAutoCrosspostReconciliation } from './services/reconciler'
import { runOperationalChecks } from './services/operations'
import type { Env } from './types'

const app = new Hono<{ Bindings: Env }>()
app.route('/', health)
app.route('/', platforms)
app.route('/', connections)
app.route('/', preferences)
app.route('/', crossposts)
app.route('/', webhooks)
// TODO(#dispatch): Task 14 moves the verify surface behind host dispatch.
app.route('/verify', verify)

// Alias: POST /api/verify → single claim verification (divine-web compatibility)
app.post('/api/verify', async (c) => {
  // Rewrite as a subrequest to /verify/single
  const url = new URL(c.req.url)
  url.pathname = '/verify/single'
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return app.fetch(newReq, c.env)
})

export { app }

export default {
  fetch: app.fetch,
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

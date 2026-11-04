// ABOUTME: Worker entry: the crossposter publishing API, served on every host,
// ABOUTME: plus the crosspost queue consumer and scheduled handlers.
import { Hono } from 'hono'
import { operations } from './routes/operations'
import { connections } from './routes/connections'
import { crossposts } from './routes/crossposts'
import { health } from './routes/health'
import { platforms } from './routes/platforms'
import { preferences } from './routes/preferences'
import { webhooks } from './routes/webhooks'
import { processCrosspostJob, PublisherRetryError } from './services/publisher'
import { runAutoCrosspostReconciliation } from './services/reconciler'
import { checkProviderReliability } from './services/reliability'
import { runOperationalChecks } from './services/operations'
import type { Env } from './types'

const app = new Hono<{ Bindings: Env }>()
app.route('/', operations)
app.route('/', health)
app.route('/', platforms)
app.route('/', connections)
app.route('/', preferences)
app.route('/', crossposts)
app.route('/', webhooks)

export { app }

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    return app.fetch(request, env, ctx)
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
    try {
      const checkedAt = Math.floor(Date.now() / 1000)
      await checkProviderReliability(env, checkedAt)
      if (failures.length === 0) await env.DB.prepare('INSERT INTO reliability_monitor(id,checked_at) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at').bind(checkedAt).run()
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'scheduled reconciliation and operational checks failed')
    }
  },
}

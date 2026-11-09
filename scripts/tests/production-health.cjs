// ABOUTME: Exercises production probe predicates with synthetic HTTP responses.
// ABOUTME: Captures safe summaries and verifies untrusted data never reaches output.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
async function probe(replace = {}) {
  const { checkProductionHealth } = await import(pathToFileURL(path.resolve('scripts/check-production-health.mjs')))
  const output = []
  const requests = []
  const code = await checkProductionHealth({ expectedRelease: 'synthetic-release', log: line => output.push(line), fetchImpl: async (url) => {
    requests.push(url)
    if (replace.throw) throw new Error('synthetic-private-token')
    if (replace[url]) return replace[url]()
    if (url.endsWith('/health')) return Response.json({ service: 'divine-connections', release: 'synthetic-release', private: 'synthetic-private-token' })
    if (url.endsWith('/readiness')) return Response.json({ ok: true })
    return Response.json({ platforms: [{ platform: 'instagram', enabled: true, connection: 'healthy', publishing: 'unknown' }, { platform: 'youtube', enabled: false, connection: 'unknown', publishing: 'unknown' }] })
  } })
  assert.ok(!output.join('\n').includes('synthetic-private-token'))
  return { code, output: output.join('\n'), requests }
}
const base = 'https://crossposter.divine.video'
test('passes correct release and non-degraded enabled providers', async () => {
  const result = await probe()
  assert.equal(result.code, 0)
  assert.equal(result.requests.length, 3)
})
for (const [name, replace, stage] of [
  ['HTTP rejection', { [base + '/health']: () => new Response('synthetic-private-token', { status: 403 }) }, /stage=http.*crossposter\.divine\.video/],
  ['network failure', { throw: true }, /stage=http/],
  ['release mismatch', { [base + '/health']: () => Response.json({ service: 'divine-connections', release: 'synthetic-private-token' }) }, /stage=release/],
  ['invalid JSON', { [base + '/health']: () => new Response('synthetic-private-token') }, /stage=release/],
  ['readiness', { [base + '/readiness']: () => Response.json({ ok: false, error: 'synthetic-private-token' }) }, /stage=readiness/],
  ['degraded provider', { [base + '/provider-health']: () => Response.json({ platforms: [{ platform: 'instagram', enabled: true, connection: 'degraded', publishing: 'healthy' }] }) }, /stage=provider.*provider=instagram.*connection=degraded.*publishing=healthy/],
  ['unknown state', { [base + '/provider-health']: () => Response.json({ platforms: [{ platform: 'x', enabled: true, connection: 'synthetic-private-token', publishing: 'healthy' }] }) }, /stage=provider.*provider=x.*connection=invalid/],
  ['unknown provider', { [base + '/provider-health']: () => Response.json({ platforms: [{ platform: 'synthetic-private-token', enabled: true, connection: 'degraded', publishing: 'healthy' }] }) }, /stage=provider.*provider=invalid/],
  ['missing platforms', { [base + '/provider-health']: () => Response.json({ private: 'synthetic-private-token' }) }, /stage=provider/],
]) test(`fails safely at ${name}`, async () => {
  const result = await probe(replace)
  assert.equal(result.code, 1)
  assert.match(result.output, stage)
})

// ABOUTME: Checks deployed release, readiness and provider health with safe summaries.
// ABOUTME: Emits fixed hosts, stages and allowlisted states without response bodies.
import { pathToFileURL } from 'node:url'

const HOSTS = ['crossposter.divine.video', 'verify.divine.video']
const PROVIDERS = ['instagram', 'x', 'youtube', 'tiktok', 'snapchat']
const STATES = ['unknown', 'healthy', 'degraded']
export async function checkProductionHealth({ expectedRelease, fetchImpl = fetch, log = console.log }) {
  const fail = (stage, host, detail = '') => { log(`Production probe failed: stage=${stage} host=${host}${detail ? ' ' + detail : ''}`); return 1 }
  async function read(host, path, stage) {
    let response
    try { response = await fetchImpl(`https://${host}/${path}`, { signal: AbortSignal.timeout(20_000) }) }
    catch { fail('http', host); return null }
    if (!response.ok) { fail('http', host); return null }
    try { return { body: await response.json() } }
    catch { fail(stage, host); return null }
  }
  if (typeof expectedRelease !== 'string' || !expectedRelease) return fail('release', HOSTS[0])
  for (const host of HOSTS) {
    const result = await read(host, 'health', 'release')
    if (!result) return 1
    if (result.body?.service !== 'divine-connections' || result.body?.release !== expectedRelease) return fail('release', host)
  }
  const ready = await read(HOSTS[0], 'readiness', 'readiness')
  if (!ready) return 1
  if (ready.body?.ok !== true) return fail('readiness', HOSTS[0])
  const providers = await read(HOSTS[0], 'provider-health', 'provider')
  if (!providers) return 1
  const platforms = providers.body?.platforms
  if (!Array.isArray(platforms) || platforms.length === 0) return fail('provider', HOSTS[0])
  for (const item of platforms) {
    const provider = PROVIDERS.includes(item?.platform) ? item.platform : 'invalid'
    const connection = STATES.includes(item?.connection) ? item.connection : 'invalid'
    const publishing = STATES.includes(item?.publishing) ? item.publishing : 'invalid'
    if (provider === 'invalid' || typeof item.enabled !== 'boolean' || connection === 'invalid' || publishing === 'invalid' ||
        (item.enabled && (connection === 'degraded' || publishing === 'degraded'))) {
      return fail('provider', HOSTS[0], `provider=${provider} connection=${connection} publishing=${publishing}`)
    }
  }
  log('Production probe passed.')
  return 0
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await checkProductionHealth({ expectedRelease: process.env.EXPECTED_RELEASE })
}

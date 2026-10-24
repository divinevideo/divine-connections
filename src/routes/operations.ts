// ABOUTME: Provides an operator-only diagnostic view and owner-scoped support lookups.
// ABOUTME: Keeps private failure details off public and verifier surfaces.
import { Hono } from 'hono'
import { authenticateRequest } from '../auth/keycast'
import { providerHealth, recentDiagnostics } from '../services/reliability'
import { errorResponse, HttpError } from '../utils/http'
import type { Env } from '../types'

export const operations = new Hono<{ Bindings: Env }>()
operations.use('/operations', async (c, next) => { c.header('Cache-Control','no-store'); c.header('Referrer-Policy','no-referrer'); await next() })
operations.use('/operations/*', async (c, next) => { c.header('Cache-Control','no-store'); c.header('Referrer-Policy','no-referrer'); await next() })
operations.use('/support/*', async (c, next) => { c.header('Cache-Control','no-store'); c.header('Referrer-Policy','no-referrer'); await next() })
operations.get('/operations/data', async c => {
  try {
    const { pubkey } = await authenticateRequest(c.req.raw, c.env)
    const allowed = (c.env.OPS_OPERATOR_PUBKEYS ?? '').split(',').map(v => v.trim()).filter(v => /^[a-f0-9]{64}$/.test(v))
    if (!allowed.includes(pubkey)) throw new HttpError(403,'forbidden','operator access required')
    const now = Math.floor(Date.now()/1000)
    const [providers, diagnostics, alerts, connections] = await Promise.all([
      providerHealth(c.env.DB,now), recentDiagnostics(c.env.DB,c.req.query('reference') || undefined),
      c.env.DB.prepare('SELECT alert_key,last_delivered_at,last_error_at FROM reliability_alerts').all(),
      c.env.DB.prepare("SELECT platform,status,COUNT(*) AS count FROM connections GROUP BY platform,status").all(),
    ])
    return c.json({ release: c.env.RELEASE_SHA ?? 'unknown', observedAt:now, alertsConfigured: Boolean(c.env.OPS_ALERT_WEBHOOK_URL), providers, diagnostics, alerts:alerts.results, connections:connections.results })
  } catch (error) { return errorResponse(error) }
})
operations.get('/support/:reference', async c => {
  try {
    const { pubkey } = await authenticateRequest(c.req.raw,c.env)
    const reference=c.req.param('reference')
    const owned=await c.env.DB.prepare('SELECT id FROM oauth_attempts WHERE id=? AND pubkey=? UNION ALL SELECT id FROM jobs WHERE id=? AND pubkey=? LIMIT 1').bind(reference,pubkey,reference,pubkey).first()
    if (!owned) throw new HttpError(404,'not_found','attempt not found')
    // Detailed provider messages stay operator-only; users get stage and support reference.
    const diagnostics=(await recentDiagnostics(c.env.DB,reference)).map(({stage,outcome,created_at})=>({stage,outcome,createdAt:created_at}))
    return c.json({ reference, diagnostics })
  } catch(error) { return errorResponse(error) }
})
operations.get('/operations', c => {
  c.header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Divine operations</title>
<style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px}input,button{font:inherit;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}td,th{padding:8px;text-align:left;border-bottom:1px solid #ddd}</style>
<h1>Crossposting operations</h1><p>Inspect saved failures and observed provider health. Access requires an authorized operator account.</p>
<label>Operator session token <input id="token" type="password" autocomplete="off"></label>
<label>Support reference <input id="reference" autocomplete="off"></label><button id="load">Load diagnostics</button><button id="clear">Clear</button>
<p id="status" role="status"></p><div id="result"></div>
<script>
const token=document.getElementById('token'), result=document.getElementById('result'), status=document.getElementById('status');
document.getElementById('clear').onclick=()=>{token.value='';result.replaceChildren();status.textContent='Cleared';};
document.getElementById('load').onclick=async()=>{result.replaceChildren();status.textContent='Loading';try{
 const reference=document.getElementById('reference').value;
 const response=await fetch('/operations/data'+(reference?'?reference='+encodeURIComponent(reference):''),{headers:{authorization:'Bearer '+token.value},cache:'no-store'});
 const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Could not load diagnostics');
 status.textContent='Release: '+data.release+'. Alerts '+(data.alertsConfigured?'configured':'NOT configured')+'. Last 24 hours; no observations means unknown.';
 const summary=document.createElement('pre');summary.textContent=JSON.stringify({providers:data.providers,connections:data.connections,alerts:data.alerts},null,2);result.append(summary);
 for(const row of data.diagnostics){const details=document.createElement('details'),label=document.createElement('summary'),body=document.createElement('pre');label.textContent=new Date(row.created_at*1000).toISOString()+' '+row.platform+' '+row.stage+' '+row.outcome+' — '+row.reference;body.textContent=JSON.stringify(row,null,2);details.append(label,body);result.append(details)}
}catch(error){status.textContent=error.message}};
</script></html>`)
})

operations.get('/readiness', async c => {
  c.header('Cache-Control','no-store')
  try {
    const heartbeat=await c.env.DB.prepare('SELECT checked_at FROM reliability_monitor WHERE id=1').first<{checked_at:number}>()
    const checks={ database:true, scheduler:Boolean(heartbeat && heartbeat.checked_at >= Math.floor(Date.now()/1000)-300),
      alerting:Boolean(c.env.OPS_ALERT_WEBHOOK_URL), operators:(c.env.OPS_OPERATOR_PUBKEYS ?? '').split(',').some(value=>/^[a-f0-9]{64}$/.test(value.trim())) }
    const ok=Object.values(checks).every(Boolean)
    return c.json({ok,service:'divine-connections',release:c.env.RELEASE_SHA ?? 'unknown',checks},ok?200:503)
  } catch { return c.json({ok:false,service:'divine-connections',checks:{database:false}},503) }
})

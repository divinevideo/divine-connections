// ABOUTME: The API reference, served at /docs so the landing page stays about
// ABOUTME: getting verified rather than doubling as developer documentation.
import { Hono } from 'hono'
import type { Env } from '../types'
import { pageShell } from './page-shell'
import { platformTableRows } from './platform-matrix'

export function renderApiDocsPage(env: Env, origin: string): string {
  const rows = platformTableRows(env)
  return pageShell({
    title: 'API Reference — Divine Identity Verification',
    description: 'HTTP API for verifying that a Nostr pubkey controls an account on another platform.',
    current: 'docs',
    body: `    <header style="padding:1rem 0 0;">
      <h1 style="margin-bottom:0.5rem;">API Reference</h1>
      <p style="max-width:60ch;">Endpoints for verifying that a Nostr pubkey controls an account on another platform. Looking to verify your own accounts? <a href="/#verify-here">Start on the main page</a>.</p>
    </header>

    <section id="api-about">
      <h2>About the API</h2>
      <p>This service verifies that a Nostr pubkey is linked to accounts on supported platforms. It fetches proof posts server-side, bypassing CORS restrictions that prevent browser-based verification.</p>
      <p>Two verification methods are supported:</p>
      <ul>
        <li><strong>Proof posts</strong> &mdash; User publishes a post containing their <code>npub</code> on the external platform. The service fetches the post and checks that the npub is present and the author matches.</li>
        <li><strong>OAuth login</strong> (X, Instagram, TikTok, YouTube) &mdash; User authenticates directly. No proof post needed.</li>
      </ul>
    </section>

    <section id="platforms-api">
      <h2>Supported Platforms</h2>
      <table>
        <tr><th>Platform</th><th>Identity Format</th><th>Proof Post</th><th>Quick Connect</th></tr>
${rows}
      </table>
      <p class="note">This table lists what the service can prove. Which Quick Connect providers are live on this deployment depends on which OAuth client secrets are installed — <code>GET /platforms</code> reports the current state.</p>
    </section>

    <section id="single-verify">
      <h2>POST /api/verify &mdash; Single Claim Verification</h2>
      <p>Verify a single identity claim.</p>

      <h4>Request</h4>
      <pre>POST ${origin}/api/verify
Content-Type: application/json

{
  "platform": "github",
  "identity": "octocat",
  "proof": "aa5a315d61ae9438b18d",
  "pubkey": "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e"
}</pre>

      <table>
        <tr><th>Field</th><th>Type</th><th>Description</th></tr>
        <tr><td><code>platform</code></td><td>string</td><td>One of: <code>github</code>, <code>twitter</code>, <code>bluesky</code>, <code>mastodon</code>, <code>telegram</code>, <code>discord</code>, <code>youtube</code>, <code>tiktok</code></td></tr>
        <tr><td><code>identity</code></td><td>string</td><td>Username or handle on the platform</td></tr>
        <tr><td><code>proof</code></td><td>string</td><td>ID of the proof post</td></tr>
        <tr><td><code>pubkey</code></td><td>string</td><td>64-character lowercase hex Nostr public key</td></tr>
      </table>

      <h4>Response (200 OK)</h4>
      <pre>{
  "platform": "github",
  "identity": "octocat",
  "verified": true,
  "checked_at": 1709571048,
  "cached": false
}</pre>

      <table>
        <tr><th>Field</th><th>Type</th><th>Description</th></tr>
        <tr><td><code>verified</code></td><td>boolean</td><td><code>true</code> if proof post contains the npub and the author matches</td></tr>
        <tr><td><code>error</code></td><td>string?</td><td>Error message (only when <code>verified</code> is <code>false</code>)</td></tr>
        <tr><td><code>checked_at</code></td><td>number</td><td>Unix timestamp (seconds)</td></tr>
        <tr><td><code>cached</code></td><td>boolean</td><td><code>true</code> if served from cache</td></tr>
      </table>
    </section>

    <section id="batch-verify">
      <h2>POST /verify &mdash; Batch Verification</h2>
      <p>Verify up to 10 claims in a single request.</p>

      <h4>Request</h4>
      <pre>POST ${origin}/verify
Content-Type: application/json

{
  "claims": [
    { "platform": "github", "identity": "octocat", "proof": "aa5a315d61ae9438b18d", "pubkey": "7e7e..." },
    { "platform": "twitter", "identity": "jack", "proof": "1234567890", "pubkey": "7e7e..." }
  ]
}</pre>

      <h4>Response (200 OK)</h4>
      <pre>{
  "results": [
    { "platform": "github", "identity": "octocat", "verified": true, "checked_at": 1709571048, "cached": false },
    { "platform": "twitter", "identity": "jack", "verified": false, "error": "Tweet not found", "checked_at": 1709571048, "cached": false }
  ]
}</pre>
    </section>

    <section id="get-verify">
      <h2>GET /verify/:platform/:identity/:proof &mdash; URL-Based Verification</h2>
      <p>Verify via URL. Returns HTML for browsers, JSON for API clients. Add <code>?format=json</code> to force JSON.</p>

      <h4>Examples</h4>
      <pre>GET ${origin}/verify/github/octocat/aa5a315d61ae9438b18d?pubkey=7e7e9c42...4e
GET ${origin}/verify/mastodon/mastodon.social/@alice/109876543210?pubkey=7e7e...4e</pre>
    </section>

    <section id="nip05">
      <h2>GET /nip05/verify &mdash; NIP-05 Verification</h2>
      <p>Check that a NIP-05 identifier resolves to a given pubkey.</p>

      <pre>GET ${origin}/nip05/verify?name=_@divine.video&amp;pubkey=7e7e9c42...4e</pre>

      <h4>Response</h4>
      <pre>{ "name": "_", "domain": "divine.video", "pubkey": "7e7e...", "verified": true, "checked_at": 1709571048, "cached": false }</pre>
    </section>

    <section id="oauth">
      <h2>Account Connection (X, Instagram, TikTok, YouTube)</h2>
      <p>Users can verify by connecting the platform account directly. No proof post needed.</p>

      <h3>Start a connection</h3>
      <pre>POST ${origin}/connections/x/start
Authorization: Bearer &lt;keycast token&gt;
{ "returnUrl": "${origin}/" }</pre>

      <h3>Read verified badges</h3>
      <pre>GET ${origin}/verified/&lt;64-hex pubkey&gt;</pre>

      <div class="note">A connected account proves ownership and also unlocks opt-in crossposting on crossposter.divine.video.</div>
    </section>

    <section id="other">
      <h2>Other Endpoints</h2>
      <div class="endpoint">
        <h3><span class="method get">GET</span> <code>/platforms</code></h3>
        <p>List supported platforms.</p>
      </div>
      <div class="endpoint">
        <h3><span class="method get">GET</span> <code>/health</code></h3>
        <p>Health check. Returns <code>{"status":"ok"}</code>.</p>
      </div>
    </section>

    <section id="rate-limits">
      <h2>Rate Limits &amp; Caching</h2>
      <table>
        <tr><th>Scope</th><th>Limit</th><th>Window</th></tr>
        <tr><td>Per IP</td><td>60 requests</td><td>1 minute</td></tr>
        <tr><td>Per pubkey</td><td>20 verifications</td><td>1 minute</td></tr>
        <tr><td>Per platform</td><td>30 outbound fetches</td><td>1 minute</td></tr>
        <tr><td>Batch max</td><td>10 claims</td><td>per request</td></tr>
      </table>
      <p style="margin-top:0.75rem;">Successful verifications are stored durably and served instantly until you disconnect the account — they are not re-fetched on a timer. Failures are cached for 15 minutes and platform errors for 5 minutes, so a fixed proof post can be re-checked shortly after.</p>
    </section>`,
  })
}

export const apiDocs = new Hono<{ Bindings: Env }>()

apiDocs.get('/docs', (c) => {
  c.header('Cache-Control', 'no-cache, must-revalidate')
  return c.html(renderApiDocsPage(c.env, new URL(c.req.url).origin))
})

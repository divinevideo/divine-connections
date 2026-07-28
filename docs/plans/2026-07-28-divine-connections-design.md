# divine-connections: merged identity verification + crossposting core

Date: 2026-07-28
Status: fresh-eyes reviewed, pre-implementation
Decision owner: Rabble

## Context

Two Divine services today own two halves of the same concept — a user's
relationship to their external platform accounts:

- **divine-identity-verification-service** (`verifier.divine.video`) proves
  account ownership (NIP-39 badges). Stateless: KV cache only.
- **divine-crossposter** (`crossposter.divine.video`) exercises account
  ownership (publish tokens, crossposting). D1 `connections` table with
  encrypted OAuth tokens.

Evidence the split is failing:

- Live probe 2026-07-28: `GET /auth/twitter/start` and `/auth/youtube/start`
  on the verifier return **503 "not configured"** — `TWITTER_*`/`GOOGLE_*`
  secrets missing in prod while the same credential pairs work in crossposter.
  Matches user complaints (Zendesk via divine-mobile#4807, Discord reports of
  verification failing on site and app).
- YouTube is absent from the verifier's live `/platforms` (API key missing).
- The verifier publishes `i` tags to kind:0 while divine-web reads NIP-39
  kind:10011 (`docs/verification-removal-plan.md`) — matching "verification
  completed but nothing changed on my account" complaints.
- Both services implement OAuth start/callback/state for the same providers
  (X, TikTok, Google) — duplicated code, secrets, and provider app configs.

## Decision

One worker, one repo: **`divine-connections`**. Two user-facing interfaces
served by host-based dispatch from the same core:

- `verifier.divine.video` → public verification API + self-service landing page
- `crossposter.divine.video` → publishing API (the crosspost setup UI stays
  in divine-web day one; no new UI is budgeted in this worker)

Rabble directive: neither existing service is treated as live legacy. No
strangler phases, no soak windows, no byte-compat shims beyond the one client
alias noted below. Build the core correctly, switch the domains, retire the
old workers.

Bonus product capability: verified state becomes **durable, queryable data**
instead of a 24h KV cache — Divine can answer "who is verified?" instantly
and serve badges without upstream fetches or relay event-kind fragility.

## Architecture

Codebase starts from divine-crossposter (the superset: D1, Queues, cron,
token encryption, hardened platform adapters, CI/CD) and ports in the
verifier's stateless proof-post verifiers, public API surface, landing page,
negative-result caching, and rate limiting.

### Modules

- `src/platforms/*` — crossposter's adapters win (X, Instagram, TikTok,
  YouTube). One shared registry.
- `src/oauth/*` — one OAuth state machine, four providers from crossposter:
  X, Instagram, TikTok, YouTube. **Bluesky OAuth is deferred** (see platform
  notes): the verifier's implementation is DPoP-bound AT Protocol OAuth that
  does not fit crossposter's PKCE adapter shape, and a Bluesky token has no
  publishing use until Bluesky crossposting exists. A follow-up tracking
  issue is filed at scaffold time.
- `src/verify/*` — ported stateless proof-post verifiers: GitHub (gist),
  Mastodon, Telegram, Discord, Bluesky posts, tweet content.
- `src/connections/*` — OAuth connect/disconnect + preferences (as today).
- `src/crossposts/*` — jobs, queue consumer, reconciler (as today).
- `src/verified/*` — new: verification store reads + badge API.

### Data model (D1)

Existing tables unchanged (`connections`, `preferences`, `jobs`, ...). New:

```sql
CREATE TABLE verifications (
  pubkey TEXT NOT NULL,          -- 64-hex Divine pubkey
  platform TEXT NOT NULL,        -- x | instagram | tiktok | youtube | bluesky |
                                 -- github | mastodon | telegram | discord
  identity TEXT NOT NULL,        -- handle / username / channel id
  method TEXT NOT NULL,          -- 'oauth' | 'proof-post'
  proof_url TEXT,                -- proof post URL when method = 'proof-post'
  connection_id TEXT,            -- connections.id when method = 'oauth'; makes
                                 -- revocation exact when a user re-connects a
                                 -- different account on the same platform
  verified_at INTEGER NOT NULL,
  revoked_at INTEGER,            -- set on explicit disconnect only (see below)
  PRIMARY KEY (pubkey, platform, identity)
);
CREATE INDEX idx_verifications_pubkey ON verifications(pubkey, revoked_at);
CREATE INDEX idx_verifications_identity ON verifications(platform, identity, revoked_at);
```

Three write sites, all atomic `db.batch`es so the tables can never drift:

1. OAuth callback completes → `completeConnectionSetup`'s existing batch
   (connection + preference + attempt) gains a fourth statement upserting the
   `verifications` row (`method='oauth'`).
2. Explicit user disconnect → one batch: connection update + preference
   disable + `verifications.revoked_at` set. `needs_reauth` never touches
   `verifications`: it is a transient, machine-initiated token state set from
   the publisher path, and badges must not flap when a token breaks at 3am.
   Verification ("you proved identity") and connection ("token currently
   works") have different lifecycles.
3. Proof-post check succeeds → upsert `verifications` row
   (`method='proof-post'`, `proof_url` set).

Revocation is disconnect-only on day one. There is no proof-post rechecker:
a deleted gist leaves a durable row until an explicit re-verify fails or the
user disconnects. A recheck cron is a future addition, deliberately out of
day-one scope.

### Caching and verify flow

D1 is the success store; KV only forgets failures. `POST /verify` flow: D1
row hit → KV negative-cache hit → rate limit → upstream fetch → write D1 on
success, write KV on failure (15m failure / 5m upstream error). There is no
24h success cache tier — keeping one alongside D1 would let `/verify` (KV)
and `/verified/:pubkey` (D1) disagree after revocation, which is exactly the
bug class this merge exists to kill. One KV namespace, shared by negative
results, NIP-05 results, and rate-limit windows.

### Rate limiting

Only upstream-fetching routes are limited: `POST /verify`, `/verify/single`,
`/api/verify`, `GET /verify/:platform/*`, `GET /nip05/verify` — IP 60/min,
plus pubkey 20/min and platform 30/min inside the verify path, checked after
D1 + KV lookups so cached results don't consume quota. D1-read endpoints
(`/verified/*`, `/platforms`, `/health`) ship unlimited day one; the ported
limiter is a pure function, so wiring it to a new route later is trivial.
`/connections/*` stays keycast-authenticated with no limits, as today.

### Read API (the "serve who's verified quickly" surface)

```
GET /verified/:pubkey                     → all live verifications (badge rendering)
GET /verified?platform=x&identity=alice   → reverse lookup (who owns this handle)
POST /verify, /verify/single, /api/verify → existing public contract, D1-backed
GET  /verify/:platform/*                  → existing URL-based verification
GET  /nip05/verify, /platforms, /health   → unchanged
```

`/api/verify` alias is kept because divine-web calls it today. Everything
else about the legacy contract may change freely.

The two `/verified` routes are enabling infrastructure: no client consumes
them on day one (web/mobile migrate badge rendering at their own pace,
rollout step 6). They are a small amount of route code over a table that
exists anyway.

### Trust boundaries

Publish tokens are only touched by authenticated `/connections/*` routes and
the publisher/queue paths. Public verify/lookup routes read only the
`verifications` projection (pubkey, platform, identity, method, proof_url,
timestamps) — never `connections` token columns. Same worker, same access
discipline as today.

OAuth start on both domains requires keycast authentication (crossposter's
existing model). The verifier's unauthenticated `?pubkey=` start endpoint —
which lets anyone bind their OAuth account to someone else's pubkey — is
retired. The landing page's OAuth buttons use the keycast login the page
already implements. Signer-only (NIP-07/NIP-46) users without a keycast
session use proof-post verification; note this regresses Instagram, TikTok,
and YouTube verification for that group day one, accepted in exchange for
closing the badge-griefing vector.

### Platform notes

- **X, Instagram, TikTok, YouTube**: verified via OAuth connection. One set of
  provider apps and secrets; callback URLs for both domains registered on each.
- **TikTok**: crossposter's `user/info` fetch must add `username` to its
  fields (currently stores `display_name`, which is not the unique handle).
- **YouTube**: verification identity is the channel ID (`external_account_id`,
  `UC…`), not the channel title.
- **Instagram**: arrives with zero new provider work (crossposter's Meta app
  "divine-IG" is live). This is the answer to "what about instagram".
- **Bluesky**: proof-post verifier ported as-is; it reads AT Protocol
  identity-link records (`video.divine.identity.link`) first, so users who
  completed the old OAuth flow stay verified. New users verify by public
  proof post — the same norm as GitHub/Mastodon/Telegram/Discord. OAuth
  itself is deferred until Bluesky crossposting gives the token a job.
- **GitHub, Mastodon, Telegram, Discord**: proof-post verifiers ported as-is.
- **LinkedIn**: future addition via OIDC Quick Connect (PRD roadmap). Feasible
  in this architecture as another OAuth provider.
- **Facebook**: not planned — no usable proof-post API, OAuth identity value
  is weak (name-based).

## Rollout

1. Scaffold `divine-connections` repo from crossposter; port verifier surface.
2. Bind the **existing** crossposter D1 database (multi-worker binding; live
   connections carry over, no data migration) + new `verifications` migration.
3. Deploy worker; test on the default workers.dev hostname.
4. Move `verifier.divine.video` custom domain, then `crossposter.divine.video`.
   Queue consumer config moves with the new worker (queues allow one consumer).
5. Retire the two old workers.
6. divine-web/mobile migrate badge rendering to `/verified/:pubkey` at their
   own pace; unified "connect once → badge + crossposting" UX lands there.

Optional stopgap available before step 1: install crossposter's `TWITTER_*` /
`GOOGLE_*` secrets into the current verifier to kill today's 503s (15 min,
needs wrangler prod access). Skip if divine-connections ships fast enough.

## Testing

- Unit: verifications write paths (all three), reverse lookup, revocation on
  disconnect, `needs_reauth` leaving badges untouched, TikTok username
  mapping, YouTube channel-ID identity.
- Integration: full OAuth callback → connection + verification rows in one
  batch; proof-post success → row; disconnect → connection + preference +
  revocation in one batch.
- Route-level: host dispatch (verifier domain never reaches publisher paths),
  public contract shapes, rate limits.
- E2E against the real deployed worker on workers.dev before domain cutover:
  connect a test X account, confirm `/verified/:pubkey` serves it, disconnect,
  confirm it disappears.

## Resolved during design

- Merge vs service-binding between two services → merged (Rabble: "two halves
  of the same core").
- Fresh repo vs reuse crossposter repo → fresh repo `divine-connections`.
- Legacy migration engineering → explicitly out of scope (Rabble: "neither of
  these services are really live").

## Resolved during fresh-eyes review

- `verifications` table vs reading OAuth verifications from `connections` →
  table kept as the single badge-read projection (`connections.status`
  conflates token health with identity proof; two shapes merged at read time
  is worse than one), but revocation simplified to disconnect-only so no
  write sites leak into the queue consumer.
- KV success cache → cut; D1 is the success store, KV keeps only negative
  results, one namespace shared with rate limiting.
- Bluesky OAuth day one → deferred (DPoP/AT-Protocol shape mismatch, no
  publishing use yet; users stay covered via identity-link records +
  proof-post).
- Crosspost setup UI in this worker → out; divine-web remains the UI.
- Unauthenticated `?pubkey=` OAuth start → retired in favor of keycast auth
  on both domains (closes badge-griefing vector; signer-only regression for
  Instagram/TikTok/YouTube accepted day one).

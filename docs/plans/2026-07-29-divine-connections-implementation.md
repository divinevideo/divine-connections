# divine-connections Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the `divine-connections` worker: crossposter's publishing core plus the verifier's public verification surface, with verified state as durable queryable D1 data.

**Architecture:** One Cloudflare Worker (Hono 4) serving two hosts by dispatch: `verifier.divine.video` (public verify API + landing page) and `crossposter.divine.video` (publishing API). A new `verifications` D1 table is the single badge-read projection with exactly three atomic write sites (OAuth callback batch, explicit disconnect batch, proof-post success). D1 is the success store; one KV namespace holds only negative results, NIP-05 results, and rate-limit windows.

**Tech Stack:** Cloudflare Workers, Hono 4, D1 (shared `divine-crossposter` database), KV, Queues, Vitest 3 + `@cloudflare/vitest-pool-workers` (real miniflare D1; upstream HTTP stubbed at the `fetch` boundary only; no internal mocks).

**Spec:** `docs/plans/2026-07-28-divine-connections-design.md` (design + fresh-eyes review resolutions). Read it first.

**Working directory for all tasks:** `/Users/rabble/code/divine/divine-connections` (the scaffolded repo; scaffold is done before this plan starts). Source files referenced from the legacy verifier live at `/Users/rabble/code/divine/divine-identify-verification-service` — referenced below as `$VERIFIER`.

**Conventions for every task:**
- Every new or ported code file starts with a 2-line header comment, each line starting with `ABOUTME: `.
- D1 in tests is real (miniflare via `applyMigrations()` from `src/db/test-helpers.ts`). Upstream provider HTTP is stubbed with `vi.stubGlobal('fetch', ...)`. Never mock internal modules.
- Pubkeys are normalized to 64-hex lowercase before any storage or lookup. Never truncate Nostr IDs.
- Error shapes: ported `/verify` surface keeps the legacy verifier shapes (`{error: string}`, `VerifyResult`). New `/verified` routes use the crossposter shape (`errorResponse()` → `{error:{code,message}}`).
- Platform vocabulary: internally the merged platform set is `x | instagram | tiktok | youtube | bluesky | github | mastodon | telegram | discord`. The verify routes accept legacy `twitter` as an alias for `x` and normalize it immediately; `x` is what gets stored and returned.
- Run tests with `npx vitest run <path>` from the repo root. Full suite: `npm run test:once`. Typecheck: `npm run typecheck`.
- Commit after every task (the human approves the execution session up front; per-task commits are expected).

---

### Task 1: `verifications` D1 migration

**Files:**
- Create: `migrations/0004_verifications.sql`
- Test: `src/db/verifications.test.ts`

**Step 1: Write the failing test**

```ts
// ABOUTME: Tests for the verifications table migration and its D1 access helpers.
// ABOUTME: Uses real miniflare D1 via applyMigrations; no mocks.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, PUBKEY_A } from './test-helpers'

describe('verifications migration', () => {
  beforeEach(async () => {
    await applyMigrations()
  })

  it('creates the verifications table with the composite primary key', async () => {
    await env.DB.prepare(
      `INSERT INTO verifications (pubkey, platform, identity, method, verified_at)
       VALUES (?, 'x', 'alice', 'oauth', 1000)`,
    ).bind(PUBKEY_A).run()
    const row = await env.DB.prepare(
      `SELECT pubkey, platform, identity, method, revoked_at FROM verifications WHERE pubkey = ?`,
    ).bind(PUBKEY_A).first()
    expect(row).toMatchObject({ pubkey: PUBKEY_A, platform: 'x', identity: 'alice', method: 'oauth', revoked_at: null })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/verifications.test.ts`
Expected: FAIL with `no such table: verifications`

**Step 3: Write the migration**

```sql
-- ABOUTME: Durable store of verified pubkey<->platform-identity proofs (badge reads).
-- ABOUTME: Written atomically from the OAuth callback batch, the disconnect batch,
-- and proof-post verify success; revoked only on explicit disconnect.
CREATE TABLE verifications (
  pubkey TEXT NOT NULL,          -- 64-hex Divine pubkey
  platform TEXT NOT NULL,        -- x | instagram | tiktok | youtube | bluesky |
                                 -- github | mastodon | telegram | discord
  identity TEXT NOT NULL,        -- handle / username / channel id
  method TEXT NOT NULL,          -- 'oauth' | 'proof-post'
  proof_url TEXT,                -- proof post URL when method = 'proof-post'
  connection_id TEXT,            -- connections.id when method = 'oauth'
  verified_at INTEGER NOT NULL,
  revoked_at INTEGER,            -- set on explicit disconnect only
  PRIMARY KEY (pubkey, platform, identity)
);
CREATE INDEX idx_verifications_pubkey ON verifications(pubkey, revoked_at);
CREATE INDEX idx_verifications_identity ON verifications(platform, identity, revoked_at);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/verifications.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add migrations/0004_verifications.sql src/db/verifications.test.ts
git commit -m "feat(verified): add verifications D1 migration"
```

---

### Task 2: `src/db/verifications.ts` access helpers

**Files:**
- Create: `src/db/verifications.ts`
- Test: `src/db/verifications.test.ts` (extend)

**Step 1: Write the failing tests**

Cover: oauth upsert statement inserts a row; re-upsert on conflict clears `revoked_at` (reconnect un-revokes); proof-post upsert stores `proof_url` and null `connection_id`; revoke statement sets `revoked_at` only for the matching `connection_id`+`pubkey` and leaves other rows live; `listVerificationsByPubkey` returns only live rows ordered by platform; `findLiveVerification` matches identity case-insensitively and misses revoked rows; `findVerificationByIdentity` (reverse lookup) returns the row.

```ts
it('re-upsert on conflict clears revoked_at', async () => {
  await applyMigrations()
  const now = 1000
  await env.DB.batch([
    upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: now }),
  ])
  await env.DB.batch([
    revokeVerificationsForConnectionStatement(env.DB, { connectionId: 'conn_1', pubkey: PUBKEY_A, now: 2000 }),
  ])
  await env.DB.batch([
    upsertOauthVerificationStatement(env.DB, { pubkey: PUBKEY_A, platform: 'x', identity: 'alice', connectionId: 'conn_1', verifiedAt: 3000 }),
  ])
  const row = await findLiveVerification(env.DB, PUBKEY_A, 'x', 'ALICE')
  expect(row).toMatchObject({ connectionId: 'conn_1', verifiedAt: 3000, revokedAt: null })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/verifications.test.ts`
Expected: FAIL with `upsertOauthVerificationStatement is not defined` (import error)

**Step 3: Implement**

```ts
// ABOUTME: D1 access for the verifications table (durable badge store).
// ABOUTME: Upsert/revoke return prepared statements so callers can compose them
// into their existing db.batch writes; reads are plain async helpers.
import type { VerificationPlatform, VerificationRecord } from '../types'

export interface OauthVerificationInput {
  pubkey: string
  platform: VerificationPlatform
  identity: string
  connectionId: string
  verifiedAt: number
}

export interface ProofPostVerificationInput {
  pubkey: string
  platform: VerificationPlatform
  identity: string
  proofUrl: string | null
  verifiedAt: number
}

export function upsertOauthVerificationStatement(
  db: D1Database,
  input: OauthVerificationInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO verifications (pubkey, platform, identity, method, proof_url, connection_id, verified_at, revoked_at)
       VALUES (?, ?, ?, 'oauth', NULL, ?, ?, NULL)
       ON CONFLICT(pubkey, platform, identity) DO UPDATE SET
         method = excluded.method,
         proof_url = excluded.proof_url,
         connection_id = excluded.connection_id,
         verified_at = excluded.verified_at,
         revoked_at = NULL`,
    )
    .bind(input.pubkey, input.platform, input.identity, input.connectionId, input.verifiedAt)
}

export function upsertProofPostVerificationStatement(
  db: D1Database,
  input: ProofPostVerificationInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO verifications (pubkey, platform, identity, method, proof_url, connection_id, verified_at, revoked_at)
       VALUES (?, ?, ?, 'proof-post', ?, NULL, ?, NULL)
       ON CONFLICT(pubkey, platform, identity) DO UPDATE SET
         method = excluded.method,
         proof_url = excluded.proof_url,
         connection_id = NULL,
         verified_at = excluded.verified_at,
         revoked_at = NULL`,
    )
    .bind(input.pubkey, input.platform, input.identity, input.proofUrl, input.verifiedAt)
}

export function revokeVerificationsForConnectionStatement(
  db: D1Database,
  input: { connectionId: string; pubkey: string; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE verifications SET revoked_at = ?
       WHERE connection_id = ? AND pubkey = ? AND revoked_at IS NULL`,
    )
    .bind(input.now, input.connectionId, input.pubkey)
}

interface VerificationRow {
  pubkey: string
  platform: string
  identity: string
  method: string
  proof_url: string | null
  connection_id: string | null
  verified_at: number
  revoked_at: number | null
}

function toRecord(row: VerificationRow): VerificationRecord {
  return {
    pubkey: row.pubkey,
    platform: row.platform as VerificationPlatform,
    identity: row.identity,
    method: row.method as VerificationRecord['method'],
    proofUrl: row.proof_url,
    connectionId: row.connection_id,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at,
  }
}

export async function listVerificationsByPubkey(
  db: D1Database,
  pubkey: string,
): Promise<VerificationRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM verifications WHERE pubkey = ? AND revoked_at IS NULL
       ORDER BY platform ASC, identity ASC`,
    )
    .bind(pubkey)
    .all<VerificationRow>()
  return results.map(toRecord)
}

export async function findLiveVerification(
  db: D1Database,
  pubkey: string,
  platform: VerificationPlatform,
  identity: string,
): Promise<VerificationRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM verifications
       WHERE pubkey = ? AND platform = ? AND identity = ? COLLATE NOCASE AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(pubkey, platform, identity)
    .first<VerificationRow>()
  return row ? toRecord(row) : null
}

export async function findVerificationByIdentity(
  db: D1Database,
  platform: VerificationPlatform,
  identity: string,
): Promise<VerificationRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM verifications
       WHERE platform = ? AND identity = ? COLLATE NOCASE AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(platform, identity)
    .first<VerificationRow>()
  return row ? toRecord(row) : null
}
```

Add to `src/types.ts`:

```ts
export type VerificationPlatform =
  | 'x' | 'instagram' | 'tiktok' | 'youtube'
  | 'bluesky' | 'github' | 'mastodon' | 'telegram' | 'discord'

export interface VerificationRecord {
  pubkey: string
  platform: VerificationPlatform
  identity: string
  method: 'oauth' | 'proof-post'
  proofUrl: string | null
  connectionId: string | null
  verifiedAt: number
  revokedAt: number | null
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/verifications.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/verifications.ts src/db/verifications.test.ts src/types.ts
git commit -m "feat(verified): add verifications D1 access helpers"
```

---

### Task 3: TikTok adapter exposes `username`

**Files:**
- Modify: `src/platforms/tiktok.ts` (the `fetchAccount` implementation)
- Test: `src/platforms/tiktok.test.ts`

**Step 1: Write the failing test**

In the existing `fetchAccount` tests: stub the upstream `GET https://open.tiktokapis.com/v2/user/info/` response with `{data: {user: {display_name: 'Alice Shows', username: 'alice.shows'}}}` and assert (a) the request URL's `fields` param contains `username`, and (b) the returned `PlatformAccount.name === 'alice.shows'` with `display_name` preserved in `metadata`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/platforms/tiktok.test.ts`
Expected: FAIL — `name` is `Alice Shows` and `fields` lacks `username`

**Step 3: Implement the minimal change**

In `src/platforms/tiktok.ts` `fetchAccount`: add `username` to the `fields` query param; set account `name` from `user.username ?? user.display_name`; keep `display_name` in `metadata`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/platforms/tiktok.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/platforms/tiktok.ts src/platforms/tiktok.test.ts
git commit -m "fix(tiktok): expose username so verification identity is the unique handle"
```

---

### Task 4: OAuth callback batch writes the verification row

**Files:**
- Modify: `src/db/connections.ts` (`completeConnectionSetup`, ~line 92)
- Modify: `src/services/connections.ts` (`completeConnectionCallback`, ~line 269)
- Test: `src/db/connections.test.ts`, `src/services/connections.test.ts`

**Step 1: Write the failing tests**

- db-level: after `completeConnectionSetup(db, {connection, preference, attemptId, now, verificationIdentity: 'alice'})`, `findLiveVerification(db, connection.pubkey, connection.platform, 'alice')` returns a row with `method: 'oauth'` and `connectionId: connection.id`.
- service-level (existing callback test harness, fetch stubbed): a full X callback leaves a live `verifications` row whose identity equals the X username; a YouTube callback leaves identity equal to the `UC…` channel id (external_account_id), not the channel title.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/connections.test.ts src/services/connections.test.ts`
Expected: FAIL — `findLiveVerification` returns null (no 4th statement)

**Step 3: Implement**

In `src/services/connections.ts` add and export:

```ts
// Verification identity per platform: YouTube proves the channel (UC… id);
// the other OAuth providers prove the human handle stored as the account name.
export function verificationIdentityForConnection(connection: ConnectionRecord): string {
  return connection.platform === 'youtube'
    ? connection.externalAccountId
    : connection.externalAccountName
}
```

In `src/db/connections.ts` `completeConnectionSetup`: accept a new required field `verificationIdentity: string` in its input and append `upsertOauthVerificationStatement(db, {pubkey: connection.pubkey, platform: connection.platform, identity: verificationIdentity, connectionId: connection.id, verifiedAt: now})` as the fourth statement in the existing `db.batch` (after the oauth_attempts update — order within a batch does not matter for correctness; keep it last for readability).

In `src/services/connections.ts` `completeConnectionCallback`: pass `verificationIdentity: verificationIdentityForConnection(connection)` into the `completeConnectionSetup` call. Fix the other existing call sites/test fixtures to pass the new field (grep for `completeConnectionSetup`).

**Step 4: Run tests**

Run: `npx vitest run src/db/connections.test.ts src/services/connections.test.ts src/routes/connections.test.ts`
Expected: PASS (route-level callback tests must be updated to assert the verification row too — extend, don't weaken, existing assertions)

**Step 5: Commit**

```bash
git add src/db/connections.ts src/services/connections.ts src/db/connections.test.ts src/services/connections.test.ts src/routes/connections.test.ts
git commit -m "feat(verified): write oauth verification row inside connection setup batch"
```

---

### Task 5: Disconnect revokes in one atomic batch

**Files:**
- Modify: `src/services/connections.ts` (`disconnectOwnedConnection`, ~line 400)
- Test: `src/services/connections.test.ts`

**Step 1: Write the failing test**

Seed a connection (`conn_1`, PUBKEY_A, x) with a preference and a live verification row (`connectionId: 'conn_1'`). Call `disconnectOwnedConnection` (auth stubbed per existing harness). Assert afterwards, in one read each: connection status is `disconnected`; preference for (pubkey, platform) is `disabled` with null `connection_id`; verification row has `revoked_at` set. Also assert a *different* connection's verification row for the same pubkey is untouched.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/connections.test.ts`
Expected: FAIL — verification row still live after disconnect

**Step 3: Implement**

Replace the two sequential writes in `disconnectOwnedConnection` (`disconnectConnection(...)` then `disablePreferenceForConnection(...)`) with a single `db.batch` of three statements:

1. The same `UPDATE connections SET status='disconnected', updated_at=? WHERE id=? AND pubkey=?` (reuse/extract the existing statement from `src/db/connections.ts` — export a statement-returning variant if the current helper only runs eagerly).
2. The preference-disable write equivalent to today's behavior (`connection_id=NULL, mode='disabled', automatic_enabled_at=NULL, updated_at=?` for the connection's pubkey+platform — mirror what `setPreference` does in the disable path, including its upsert-on-conflict shape if the current code can create the row).
3. `revokeVerificationsForConnectionStatement(db, {connectionId, pubkey, now})`.

Keep the best-effort `adapter.revoke` call before the batch, errors swallowed, exactly as today. Do not touch `jobs` (unchanged behavior). `needs_reauth` paths in `src/services/publisher.ts` must remain untouched — badges must not flap on token failure; there is no test change there, and that is intentional.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/connections.test.ts src/routes/connections.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/connections.ts src/db/connections.ts src/services/connections.test.ts src/routes/connections.test.ts
git commit -m "feat(verified): revoke verifications atomically on explicit disconnect"
```

---

### Task 6: Port the proof-post verifier modules

**Files (copy from `$VERIFIER`, then adapt):**
- `$VERIFIER/src/platforms/base.ts` → `src/verify/base.ts`
- `$VERIFIER/src/platforms/github.ts` (+ `.test.ts`) → `src/verify/github.ts`
- `$VERIFIER/src/platforms/twitter.ts` → `src/verify/twitter.ts` (+ port no test — add one, below)
- `$VERIFIER/src/platforms/mastodon.ts` (+ `.test.ts`) → `src/verify/mastodon.ts`
- `$VERIFIER/src/platforms/telegram.ts` → `src/verify/telegram.ts`
- `$VERIFIER/src/platforms/discord.ts` (+ `.test.ts`) → `src/verify/discord.ts`
- `$VERIFIER/src/platforms/bluesky.ts` (+ `.test.ts`) → `src/verify/bluesky.ts`
- `$VERIFIER/src/platforms/youtube.ts` (+ `.test.ts`) → `src/verify/youtube.ts`
- `$VERIFIER/src/platforms/tiktok.ts` (+ `.test.ts`) → `src/verify/tiktok.ts`
- `$VERIFIER/src/atproto.ts` → `src/verify/atproto.ts`
- `$VERIFIER/src/identity-link.ts` (+ `.test.ts`) → `src/verify/identity-link.ts`
- `$VERIFIER/src/utils/npub.ts` (+ `.test.ts`) → `src/utils/npub.ts`
- `$VERIFIER/src/utils/validation.ts` (only `isValidProof`, `isValidIdentity`, `isPrivateHostname`, `validateNip05Name`, `isValidNpub` and their tests — do NOT copy `parsePlatform`-style helpers; the repo's own `src/utils/validation.ts` keeps its content) → `src/verify/validation.ts`
- Create: `src/verify/registry.ts`

Do **not** port anything under `$VERIFIER/src/oauth/` (all four OAuth handlers and Bluesky DPoP OAuth are retired/deferred by design) and do not port `$VERIFIER/src/platforms/registry.ts` (its env-plumbing is replaced below).

**Adaptations (applies to every ported file):**
1. Add the 2-line `ABOUTME: ` header to each file.
2. Fix imports: `./base` stays; `../utils/npub` for npub helpers; `./validation` for the ported validators; `./atproto` / `./identity-link` for the Bluesky pieces.
3. In `src/verify/registry.ts`, write the new factory:

```ts
// ABOUTME: Factory + platform info for the stateless proof-post verifiers.
// ABOUTME: Tokens come from Env; a platform without its token reports supported:false.
import type { Env } from '../types'
import { GitHubVerifier } from './github'
import { TwitterVerifier } from './twitter'
import { MastodonVerifier } from './mastodon'
import { TelegramVerifier } from './telegram'
import { DiscordVerifier } from './discord'
import { BlueskyVerifier } from './bluesky'
import { YouTubeVerifier } from './youtube'
import { TikTokVerifier } from './tiktok'
import type { PlatformVerifier } from './base'
import type { VerificationPlatform } from '../types'

export function getProofVerifier(platform: VerificationPlatform, env: Env): PlatformVerifier {
  switch (platform) {
    case 'github': return new GitHubVerifier(env.GITHUB_TOKEN)
    case 'x': return new TwitterVerifier()
    case 'mastodon': return new MastodonVerifier()
    case 'telegram': return new TelegramVerifier()
    case 'discord': return new DiscordVerifier(env.DISCORD_BOT_TOKEN, env.DISCORD_VERIFY_CHANNEL_ID)
    case 'bluesky': return new BlueskyVerifier()
    case 'youtube': return new YouTubeVerifier(env.YOUTUBE_API_KEY)
    case 'tiktok': return new TikTokVerifier()
    default: throw new Error(`no proof-post verifier for platform: ${platform}`)
  }
}
```

(`instagram` has no proof-post verifier — OAuth-only by design. The `default` arm is unreachable from routes because they validate the platform first.)

4. Keep the legacy `User-Agent: divine-identity-verification-service` strings as-is (they identify us to upstreams; renaming gains nothing).

**Tests:** the ported `*.test.ts` files run under this repo's vitest config unchanged except import fixes — they already stub `fetch` at the boundary. Add a `src/verify/twitter.test.ts` modeled on `mastodon.test.ts`: oEmbed returns `author_url` `https://x.com/alice` and html containing the npub → verified; wrong author → not verified; upstream 404 → not verified.

**Step: Run + commit**

Run: `npx vitest run src/verify src/utils/npub.test.ts`
Expected: PASS

```bash
git add src/verify src/utils/npub.ts src/utils/npub.test.ts
git commit -m "feat(verify): port stateless proof-post verifiers from identity service"
```

---

### Task 7: Negative-result KV cache + binding

**Files:**
- Create: `src/utils/cache.ts` (port of `$VERIFIER/src/utils/cache.ts`, success tier removed)
- Test: `src/utils/cache.test.ts` (port of `$VERIFIER/src/utils/cache.test.ts`, adjusted)
- Modify: `wrangler.toml`, `src/types.ts` (`Env`), `src/test-env.d.ts`

**Step 1: Write the failing test**

Port the cache-key shape tests (`v|platform|identity|proof|pubkey` with `|`→`||` escaping; `nip05|local@domain|pubkey`) and assert TTL selection: `failed` → 900, `platform_error` → 300. Assert there is no `verified` TTL export (compile-time: importing it fails — instead assert `getTtl({... type:'verified'})` throws).

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/cache.test.ts`
Expected: FAIL — module does not exist

**Step 3: Implement**

Port `$VERIFIER/src/utils/cache.ts` with these exact changes:
- `TTL_FAILED = 900`, `TTL_PLATFORM_ERROR = 300`. Delete `TTL_VERIFIED`; `getTtl` throws on `type: 'verified'` (D1 is the success store; KV must never hold successes).
- Keep `CachedResult`, `cacheKey`, `nip05CacheKey`, `getCached`, `putCached` shapes unchanged.
- Add ABOUTME header.

In `wrangler.toml` add (real namespace id filled in at scaffold/deploy time — see Task 16):

```toml
[[kv_namespaces]]
binding = "CACHE_KV"
id = "__CACHE_KV_ID__"
```

In `src/types.ts` `Env`: add `CACHE_KV: KVNamespace`, `GITHUB_TOKEN?: string`, `YOUTUBE_API_KEY?: string`, `DISCORD_BOT_TOKEN?: string`, `DISCORD_VERIFY_CHANNEL_ID?: string`. Mirror in `src/test-env.d.ts`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/cache.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/utils/cache.ts src/utils/cache.test.ts wrangler.toml src/types.ts src/test-env.d.ts
git commit -m "feat(verify): add negative-result KV cache (D1 owns successes)"
```

---

### Task 8: Rate limiter

**Files:**
- Create: `src/utils/rate-limit.ts` (verbatim port of `$VERIFIER/src/utils/rate-limit.ts` + ABOUTME)
- Test: `src/utils/rate-limit.test.ts`

**Step 1: Write the failing test**

The legacy repo has no test for this file; write one against the real miniflare KV (`env.CACHE_KV`): fixed window allows `limit` requests then rejects; a different id has its own window; keys expire (assert TTL 120 on the written key via a KV get with metadata, or simply assert key shape `rl:ip:1.2.3.4:<window>`).

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/rate-limit.test.ts`
Expected: FAIL — module does not exist

**Step 3: Implement**

Port `$VERIFIER/src/utils/rate-limit.ts` unchanged except: ABOUTME header; single KV binding (the legacy `RATE_LIMIT_KV` becomes `CACHE_KV` — the function already takes the namespace as a parameter, so call sites change, not the module); export `RATE_LIMITS = { ip: {prefix: 'rl:ip', limit: 60}, pubkey: {prefix: 'rl:pk', limit: 20}, platform: {prefix: 'rl:plat', limit: 30} }`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/rate-limit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/utils/rate-limit.ts src/utils/rate-limit.test.ts
git commit -m "feat(verify): port fixed-window rate limiter onto shared KV namespace"
```

---

### Task 9: `src/services/verify.ts` — the D1→KV→limit→upstream flow

**Files:**
- Create: `src/services/verify.ts`
- Test: `src/services/verify.test.ts`

**Step 1: Write the failing tests**

Against real miniflare D1+KV, `fetch` stubbed at the boundary:

1. D1 hit short-circuits: seed a live verification row; call `verifySingleClaim(env, {pubkey, platform:'github', identity:'alice', proof:'gistid'}, {ip:'1.1.1.1'})`; assert `verified:true, cached:true` and that the stubbed `fetch` was never called.
2. Legacy alias: same call with `platform:'twitter'` normalizes to `x` (row stored as `x` is found; result `platform` is `'x'`).
3. KV negative hit: `putCached` a `failed` result; assert `verified:false, cached:true`, no fetch, and the rate-limit counters were not incremented.
4. Full upstream success: no rows; stub a GitHub gist 200 whose owner/content match; assert `verified:true, cached:false`; assert a live D1 row now exists with `method:'proof-post'`, `proof_url` set to the claim's proof.
5. Failure caches negatively: stub gist 404; assert `verified:false`; second call returns `cached:true` without fetch.
6. Upstream exception → `platform_error` cached with 300s semantics (assert `verified:false` and a subsequent call is served from cache).
7. Rate limit ordering: seed the D1 hit; hammer 61 requests from one IP against the *cached* claim — all pass (cache doesn't consume quota); then clear D1/KV and the 61st uncached request returns `verified:false, error:'rate_limit_exceeded'` without fetch.
8. Bluesky proofless claim (`proof: ''`) reaches the Bluesky verifier (identity-link lookup); other platforms with empty proof return `verified:false` validation error without fetch.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/verify.test.ts`
Expected: FAIL — module does not exist

**Step 3: Implement**

```ts
// ABOUTME: Core verification flow: D1 success store -> KV negative cache ->
// ABOUTME: rate limits -> upstream proof fetch -> write D1 (success) / KV (failure).
import type { Env, VerificationPlatform } from '../types'
import { findLiveVerification, upsertProofPostVerificationStatement } from '../db/verifications'
import { getCached, putCached, cacheKey } from '../utils/cache'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'
import { getProofVerifier } from '../verify/registry'
import { isValidIdentity, isValidProof } from '../verify/validation'
import { hexToNpub } from '../utils/npub'
import type { VerificationMethod, VerificationProvenance } from '../verify/identity-link'

export interface VerifyClaim {
  pubkey: string
  platform: string   // accepts legacy 'twitter'; normalized to 'x'
  identity: string
  proof: string
}

export interface VerifyResult {
  platform: VerificationPlatform
  identity: string
  verified: boolean
  error?: string
  method?: VerificationMethod
  provenance?: VerificationProvenance
  checked_at: number
  cached: boolean
}

const PUBKEY_RE = /^[0-9a-f]{64}$/

export function normalizeVerifyPlatform(platform: string): VerificationPlatform | null {
  const p = platform.toLowerCase() === 'twitter' ? 'x' : platform.toLowerCase()
  switch (p) {
    case 'x': case 'instagram': case 'tiktok': case 'youtube':
    case 'bluesky': case 'github': case 'mastodon': case 'telegram': case 'discord':
      return p
    default:
      return null
  }
}

export async function verifySingleClaim(
  env: Env,
  claim: VerifyClaim,
  context: { ip: string },
): Promise<VerifyResult> {
  const now = Math.floor(Date.now() / 1000)
  const pubkey = claim.pubkey.toLowerCase()
  const platform = normalizeVerifyPlatform(claim.platform)
  const base = { identity: claim.identity, checked_at: now, cached: false }

  if (!platform) return { ...base, platform: 'x', verified: false, error: 'Unsupported platform' }
  const result = (partial: Partial<VerifyResult> & { verified: boolean }): VerifyResult =>
    ({ ...base, platform, ...partial })

  if (!PUBKEY_RE.test(pubkey)) return result({ verified: false, error: 'Invalid pubkey' })
  if (!isValidIdentity(claim.identity)) return result({ verified: false, error: 'Invalid identity' })
  const proofOptional = platform === 'bluesky'
  if (!proofOptional && !isValidProof(claim.proof)) return result({ verified: false, error: 'Invalid proof' })
  if (proofOptional && claim.proof && !isValidProof(claim.proof)) return result({ verified: false, error: 'Invalid proof' })

  // 1. Durable success store.
  const live = await findLiveVerification(env.DB, pubkey, platform, claim.identity)
  if (live) {
    return result({
      verified: true,
      method: live.method === 'oauth' ? 'oauth' : 'proof_post',
      checked_at: live.verifiedAt,
      cached: true,
    })
  }

  // 2. Negative cache (failures only; successes never live in KV).
  const key = cacheKey(platform, claim.identity, claim.proof, pubkey)
  const cached = await getCached(env.CACHE_KV, key)
  if (cached) {
    return result({
      verified: cached.verified,
      error: cached.error,
      method: cached.method,
      provenance: cached.provenance,
      checked_at: cached.checked_at,
      cached: true,
    })
  }

  // 3. Rate limits — after cache lookups so cached results don't consume quota.
  if (!await checkRateLimit(env.CACHE_KV, RATE_LIMITS.ip, context.ip)) {
    return result({ verified: false, error: 'rate_limit_exceeded' })
  }
  if (!await checkRateLimit(env.CACHE_KV, RATE_LIMITS.pubkey, pubkey)) {
    return result({ verified: false, error: 'rate_limit_exceeded' })
  }
  if (!await checkRateLimit(env.CACHE_KV, RATE_LIMITS.platform, platform)) {
    return result({ verified: false, error: 'rate_limit_exceeded' })
  }

  // 4. Upstream proof fetch.
  const npub = hexToNpub(pubkey)
  try {
    const verifier = getProofVerifier(platform, env)
    const outcome = await verifier.verify(claim.identity, claim.proof, npub)
    if (outcome.verified) {
      await env.DB.batch([
        upsertProofPostVerificationStatement(env.DB, {
          pubkey, platform, identity: claim.identity,
          proofUrl: claim.proof || null, verifiedAt: now,
        }),
      ])
      return result({ verified: true, method: outcome.method ?? 'proof_post', provenance: outcome.provenance })
    }
    await putCached(env.CACHE_KV, key, { verified: false, error: outcome.error, checked_at: now, type: 'failed' })
    return result({ verified: false, error: outcome.error })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'upstream error'
    await putCached(env.CACHE_KV, key, { verified: false, error: 'Platform verification unavailable', checked_at: now, type: 'platform_error' })
    console.error(JSON.stringify({ event: 'verify_upstream_error', platform, message }))
    return result({ verified: false, error: 'Platform verification unavailable' })
  }
}
```

Notes for the implementer:
- `getCached` returning a stored `verified:true` should be impossible (Task 7 removed the success tier); if it happens, treat as a miss and fall through — add that guard.
- `instagram` passes validation but `getProofVerifier` throws for it — catch arm returns `platform_error`. That is wrong UX; instead return `verified:false, error:'Instagram verification uses account connection, not proof posts'` *before* the upstream step. Add the guard + a test.

**Step 4: Run tests**

Run: `npx vitest run src/services/verify.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/verify.ts src/services/verify.test.ts
git commit -m "feat(verify): add D1-backed verification flow service"
```

---

### Task 10: Verify routes (`/verify`, `/verify/single`, `/api/verify`, `/verify/:platform/*`)

**Files:**
- Create: `src/routes/verify.ts`
- Test: `src/routes/verify.test.ts`
- Modify: `src/index.ts` (mount; `/api/verify` alias — final mount happens in Task 14, wire temporarily and clean up there)

**Step 1: Write the failing tests**

Port the behavioral contract from `$VERIFIER/src/routes/verify.ts` (read it first) as route tests against the Hono app:
- `POST /verify` with `{claims: [...]}` → 200 `{results: [...]}`; >10 claims → 400 `{error: ...}`; per-claim validation failure → 400 `{error:'Validation failed', details:[{index, error}]}` (match the legacy shape exactly).
- `POST /verify/single` flat body → single `VerifyResult`.
- `GET /verify/x/alice/1234567890?pubkey=<64hex>` → JSON result; `Accept: text/html` → the HTML result page; missing/invalid pubkey → 400.
- Verification failures are 200 with `verified:false`, never 4xx/5xx.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/verify.test.ts`
Expected: FAIL — routes not mounted / module missing

**Step 3: Implement**

Port `$VERIFIER/src/routes/verify.ts` (including the `renderVerifyHtml()` result page, verbatim) with these changes:
- Replace the legacy per-route `checkRateLimit(RATE_LIMIT_KV ...)` calls with nothing — limits now live inside `verifySingleClaim` (Task 9).
- Replace the legacy cache/D1 logic with calls to `verifySingleClaim(env, claim, {ip})`; `ip` from `cf-connecting-ip` header (fall back to `x-forwarded-for`).
- `/api/verify` alias: replicate the legacy rewrite (`c.req.path` → `/verify/single`, re-dispatch through `app.fetch`) in `src/index.ts`.
- Keep response shapes byte-compatible with the legacy verifier for these routes.
- ABOUTME header.

**Step 4: Run tests**

Run: `npx vitest run src/routes/verify.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/routes/verify.ts src/routes/verify.test.ts src/index.ts
git commit -m "feat(verify): add public verify routes with legacy-compatible contract"
```

---

### Task 11: `/verified` read API

**Files:**
- Create: `src/routes/verified.ts`
- Test: `src/routes/verified.test.ts`

**Step 1: Write the failing tests**

- `GET /verified/<64hex>` → 200 `{pubkey, verifications: [{platform, identity, method, proof_url, verified_at}]}`; unknown pubkey → 200 with empty `verifications` (not 404 — badge rendering must be cheap); bad pubkey → 400 `{error:{code:'invalid_pubkey', message}}`.
- `GET /verified?platform=x&identity=Alice` → 200 `{platform, identity, pubkey, method, verified_at}`; no live row → 404 `{error:{code:'not_found', ...}}`; missing params → 400 `{error:{code:'invalid_request', ...}}`.
- Revoked rows never appear in either response (seed, revoke, re-request).
- Response includes no token/connection columns — assert the exact key set of each verification object.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/verified.test.ts`
Expected: FAIL — module does not exist

**Step 3: Implement**

```ts
// ABOUTME: Public badge-read API over the verifications projection.
// ABOUTME: Reads only verifications columns; never touches connections token data.
import { Hono } from 'hono'
import type { Env } from '../types'
import { findVerificationByIdentity, listVerificationsByPubkey } from '../db/verifications'
import { normalizeVerifyPlatform } from '../services/verify'
import { errorResponse } from '../utils/http'
import { HttpError } from '../utils/http'

const PUBKEY_RE = /^[0-9a-f]{64}$/

function toBadge(row: Awaited<ReturnType<typeof listVerificationsByPubkey>>[number]) {
  return {
    platform: row.platform,
    identity: row.identity,
    method: row.method,
    proof_url: row.proofUrl,
    verified_at: row.verifiedAt,
  }
}

export const verified = new Hono<{ Bindings: Env }>()
  .get('/verified/:pubkey', async (c) => {
    const pubkey = c.req.param('pubkey').toLowerCase()
    if (!PUBKEY_RE.test(pubkey)) throw new HttpError(400, 'invalid_pubkey', 'pubkey must be 64 lowercase hex chars')
    const rows = await listVerificationsByPubkey(c.env.DB, pubkey)
    return c.json({ pubkey, verifications: rows.map(toBadge) })
  })
  .get('/verified', async (c) => {
    const platformParam = c.req.query('platform')
    const identity = c.req.query('identity')
    const platform = platformParam ? normalizeVerifyPlatform(platformParam) : null
    if (!platform || !identity) throw new HttpError(400, 'invalid_request', 'platform and identity are required')
    const row = await findVerificationByIdentity(c.env.DB, platform, identity)
    if (!row) throw new HttpError(404, 'not_found', 'no live verification for this platform identity')
    return c.json({ platform, identity: row.identity, pubkey: row.pubkey, method: row.method, verified_at: row.verifiedAt })
  })
```

Check how `HttpError` is actually defined/used in `src/utils/http.ts` and whether routes register an `onError`; match that pattern (the repo's routes wrap handlers in try/catch → `errorResponse()` — follow the repo pattern rather than throwing if that is what the codebase does). Route order matters: register `/verified` (query form) before `/verified/:pubkey` — verify Hono matches the static segment first; if not, mount the query route first explicitly.

**Step 4: Run tests**

Run: `npx vitest run src/routes/verified.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/routes/verified.ts src/routes/verified.test.ts
git commit -m "feat(verified): add badge read API (by pubkey + reverse lookup)"
```

---

### Task 12: NIP-05 route

**Files:**
- Create: `src/routes/nip05.ts` (port of `$VERIFIER/src/routes/nip05.ts`)
- Test: `src/routes/nip05.test.ts`

**Steps (TDD as usual):**

1. Port the route and its tests: `GET /nip05/verify?name=user@domain&pubkey=<64hex>` → fetches `https://{domain}/.well-known/nostr.json?name={local}` with `redirect:'manual'`; verified iff `names[local]` equals pubkey case-insensitively; SSRF guard via ported `isPrivateHostname`; route-level IP limit 60/min → 429 `{error:'Rate limit exceeded'}` (this route keeps route-level limiting like the legacy one).
2. Adapt: `RATE_LIMIT_KV`/`CACHE_KV` → `CACHE_KV`; cache via ported `src/utils/cache.ts` (`nip05CacheKey`, failed 900 / platform_error 300 — no success tier change here: NIP-05 has no D1 store, so keep caching successes with the legacy 24h TTL **as an explicit, documented exception**: add `TTL_NIP05_VERIFIED = 86400` in `src/utils/cache.ts` with a comment that D1 only stores platform verifications, not NIP-05 names).
3. Keep response shape `{name, domain, pubkey, verified, error?, checked_at, cached}`.

Run: `npx vitest run src/routes/nip05.test.ts`
Expected: PASS

```bash
git add src/routes/nip05.ts src/routes/nip05.test.ts src/utils/cache.ts
git commit -m "feat(verify): port NIP-05 verification route"
```

---

### Task 13: Verifier-shape `/platforms`

**Files:**
- Create: `src/verify/platforms-info.ts`
- Test: `src/verify/platforms-info.test.ts`

**Steps:**

1. Failing test: `getVerificationPlatformInfo(env)` returns the legacy `/platforms` JSON shape `{platforms: {<key>: {label, supported}}}` covering all nine platforms; `youtube.supported === false` when `YOUTUBE_API_KEY` is unset **and** no OAuth path exists — decision: with OAuth connections live, `youtube` is supported whenever the YouTube adapter is enabled (`ENABLE_YOUTUBE`), even without the API key; the key only gates *proof-post* verification. Encode exactly that: `supported` = OAuth-enabled OR proof-capable; add a `methods: ['oauth','proof_post']` array per platform so clients can tell. Keep legacy keys (`label`, `supported`) and add — don't remove.
2. Implement `src/verify/platforms-info.ts` using `getProviderSummaries(env)` from `src/platforms/registry.ts` for the OAuth-enabled flags.
3. Mount `GET /platforms` on the **verifier host only** (Task 14 wires hosts; for now export the handler).

Run: `npx vitest run src/verify/platforms-info.test.ts`
Expected: PASS

```bash
git add src/verify/platforms-info.ts src/verify/platforms-info.test.ts
git commit -m "feat(verify): add merged platform info for verifier surface"
```

---

### Task 14: Host dispatch

**Files:**
- Modify: `src/index.ts`
- Test: `src/index.test.ts` (extend), create `src/dispatch.test.ts` if cleaner

**Step 1: Write the failing tests**

Drive `app.request` / the exported `fetch` with `Host` headers:
- `verifier.divine.video`: serves landing `/`, `/health` (verifier shape `{status:'ok', ...}`), `/platforms` (verifier shape), `/verify*`, `/verified*`, `/nip05/verify`, `/api/verify`, `POST /connections/x/start` (keycast), `GET /connections/x/callback`, `GET /connections`, `DELETE /connections/x/:id`.
- `verifier.divine.video` does **not** reach publisher paths: `POST /videos/abc/crossposts` → 404; `GET /jobs/x` → 404; `/preferences` → 404; `/webhooks/instagram` → 404.
- `crossposter.divine.video`: everything the worker serves today, unchanged, including its own `/`, `/platforms`, `/health` shapes.
- Fallback host (`*.workers.dev`, `localhost`): union of both surfaces; on the three colliding paths (`/`, `/platforms`, `/health`) the **verifier** shape wins; crossposter's `/platforms?format=json` remains available at `/api/providers` (add this alias on the crossposter app — tiny route addition with its own test).

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — single app today, no dispatch

**Step 3: Implement**

Restructure `src/index.ts` into three Hono apps plus dispatch:

```ts
// ABOUTME: Worker entry: host-based dispatch between the verifier public surface
// ABOUTME: and the crossposter publishing API over one shared core; plus queue
// and scheduled handlers.
const crossposterApp = new Hono<{ Bindings: Env }>()
// ... existing mounts unchanged: health, platforms, connections, preferences, crossposts, webhooks
crossposterApp.route('/', connections)   // etc, exactly as today
crossposterApp.get('/api/providers', ...) // JSON alias of /platforms?format=json

const verifierApp = new Hono<{ Bindings: Env }>()
verifierApp.route('/', landing)      // Task 15; until then a placeholder 200
verifierApp.route('/', verifyRoutes)
verifierApp.route('/', verified)
verifierApp.route('/', nip05)
verifierApp.get('/platforms', platformsInfoHandler)
verifierApp.get('/health', (c) => c.json({ status: 'ok', service: 'divine-connections', timestamp: ... }))
verifierApp.route('/', connections)  // keycast-authed connect/disconnect on both domains

const fallbackApp = new Hono<{ Bindings: Env }>()
fallbackApp.route('/', verifierApp)   // verifier wins /, /platforms, /health
fallbackApp.route('/', crossposterApp)

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const host = new URL(request.url).hostname
    if (host === 'verifier.divine.video') return verifierApp.fetch(request, env, ctx)
    if (host === 'crossposter.divine.video') return crossposterApp.fetch(request, env, ctx)
    return fallbackApp.fetch(request, env, ctx)
  },
  queue: ...,      // unchanged from today
  scheduled: ...,  // unchanged from today
}
```

The `/api/verify` alias from Task 10 mounts on `verifierApp`. Keep CORS permissive (`origin: '*'`) on the verifier surface only, matching the legacy verifier; the crossposter surface keeps its current behavior.

**Step 4: Run tests**

Run: `npm run test:once`
Expected: PASS (full suite green — dispatch touches everything)

**Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: host-based dispatch between verifier and crossposter surfaces"
```

---

### Task 15: Landing page + embed bridge

**Files:**
- Create: `src/routes/landing.ts` (the verifier landing page as an exported HTML string + GET `/` handler)
- Create: `src/embed-bridge.ts` (verbatim port of `$VERIFIER/src/embed-bridge.ts` + test)
- Test: `src/routes/landing.test.ts`, port `$VERIFIER/src/embed-bridge.test.ts` and `$VERIFIER/src/kind-migration.test.ts`

**Steps:**

1. Port `src/embed-bridge.ts` and its test verbatim (+ ABOUTME). No behavior change.
2. Copy the landing HTML template from `$VERIFIER/src/index.ts` (the giant inline template, ~lines 81–2504) into `src/routes/landing.ts` as `export function renderLandingPage(env: Env): string` (+ ABOUTME), mounting `GET /` on the verifier app. Port the `kind-migration.test.ts` assertions (kind 10011, manage, revoke wiring) and the footer privacy/terms link test.
3. Make these exact adaptations inside the copied HTML/JS (each gets a test assertion in `landing.test.ts`):
   - **Quick Connect buttons**: replace `GET /auth/:platform/start?pubkey=…&return_url=…` with `POST /connections/:platform/start` (`Authorization: Bearer <keycast token>`, body `{returnUrl: location.origin + '/'}`) → redirect to the returned `authorizationUrl`. Platforms offered: **x, instagram, tiktok, youtube**. Require the keycast session; if absent, prompt keycast login (the page already implements it — keep its `client_id`/localStorage key unchanged). Bluesky's OAuth button is removed; Bluesky stays in the proof-post form.
   - **Manage section**: replace `GET /auth/:platform/status` calls with `GET /verified/:pubkey`; replace `POST /auth/oauth/revoke` with `DELETE /connections/:platform/:connection_id` for `method:'oauth'` rows (list connections via keycast-authed `GET /connections` to map platform→connection_id). For `method:'proof-post'` rows show no revoke button (day-one revocation is disconnect-only; note in the UI copy).
   - Remove the `POST /auth/nostr/login` NIP-98 login path from the page JS (keycast OAuth login already covers it).
   - Proof-post form + batch lookup + kind 10011 publish + embed auto-connect: unchanged.
4. Tests: `landing.test.ts` asserts the page contains `/connections/` start wiring, contains no `/auth/twitter/start` (etc.) strings, still contains `kind 10011` publish wiring and the embed-bridge script; embed-bridge and kind-migration ported tests pass as-is.

Run: `npx vitest run src/routes/landing.test.ts src/embed-bridge.test.ts src/kind-migration.test.ts`
Expected: PASS

```bash
git add src/routes/landing.ts src/routes/landing.test.ts src/embed-bridge.ts src/embed-bridge.test.ts src/kind-migration.test.ts
git commit -m "feat(landing): port self-service verification page onto connections OAuth"
```

---

### Task 16: Deployment config + CI

**Files:**
- Modify: `wrangler.toml`, `.github/workflows/ci-deploy.yml`, `README.md`

**Steps:**

1. `wrangler.toml` final shape (verify each line):
   - `name = "divine-connections"`, `main = "src/index.ts"`, compat date unchanged.
   - D1 `DB` binding → **same** `database_name`/`database_id` as divine-crossposter (multi-worker binding; no data migration).
   - `CACHE_KV` binding with the real namespace id (created at scaffold: `npx wrangler kv namespace create divine-connections-cache`; if no CF auth in this environment, leave `__CACHE_KV_ID__` placeholder + README instruction and flag to Rabble).
   - Vars: existing crossposter vars + `DISCORD_VERIFY_CHANNEL_ID = "1484771306179133582"`.
   - Custom-domain `routes`: **absent** (domains move at cutover — rollout step 4). Keep a comment with the two hostnames and a `TODO(#2)` marker.
   - `[[queues.consumers]]` and `[triggers] crons`: **absent/commented** with the same `TODO(#2)` marker (one consumer per queue; double-cron against the shared D1 would double-fire ops alerts). Producers stay bound.
2. CI: copy of crossposter's `ci-deploy.yml` with smoke tests adjusted for the fallback host: `/health` contains `"status":"ok"`, `/verified/<64hex-of-zeros>` returns `{"pubkey":...,"verifications":[]}`, `/platforms` returns verifier shape, `/api/providers` returns instagram+x. Keep the `npx wrangler d1 migrations apply divine-crossposter --remote` step (shared DB; migration 0004 lands there).
3. README: new repo name; secrets list gains `GITHUB_TOKEN`, `YOUTUBE_API_KEY`, `DISCORD_BOT_TOKEN`; document the two hostnames, the cutover TODOs, and that Bluesky OAuth is deliberately deferred (link the tracking issue once the GitHub repo exists).
4. Typecheck + full suite green.

Run: `npm run typecheck && npm run test:once`
Expected: PASS

```bash
git add wrangler.toml .github/workflows/ci-deploy.yml README.md
git commit -m "chore: configure divine-connections deployment and CI"
```

---

### Task 17: E2E on workers.dev (real accounts, real APIs)

No mocks — this is the real deployed worker.

1. `npx wrangler deploy` (needs Cloudflare auth — Rabble runs this or provides a token).
2. On `https://divine-connections.<subdomain>.workers.dev`:
   - Keycast login + `POST /connections/x/start` with a real test X account → complete OAuth → `GET /verified/<test pubkey>` shows `{platform:'x', method:'oauth'}`.
   - `GET /verified?platform=x&identity=<handle>` reverse-finds the pubkey.
   - `DELETE /connections/x/<id>` → row disappears from `/verified/:pubkey`.
   - `POST /verify/single` with a real public GitHub gist containing the test npub → `verified:true`; second call → `cached:true`; row visible in `/verified/:pubkey` with `method:'proof-post'`.
   - `POST /verify/single` for a gist that 404s → `verified:false`; immediate retry → `cached:true` (negative cache), no second upstream hit (observe via `wrangler tail`).
   - `GET /nip05/verify?name=<real>@<real domain>&pubkey=…`.
3. Record results in the PR description (manual test plan per repo PR guardrails).

```bash
git commit -m "test: document workers.dev e2e results" --allow-empty
```

---

## Explicitly out of scope (do not build)

- Bluesky OAuth (deferred; tracking issue filed when the GitHub repo exists).
- Proof-post recheck cron; user-facing proof-post revoke.
- `/auth/*` legacy routes (twitter/youtube/tiktok/bluesky handlers, nostr login, oauth revoke, status) — all retired.
- Crosspost setup UI in this worker; LinkedIn; Facebook.
- Domain cutover, queue-consumer move, cron re-enable, old-worker retirement (rollout steps 4–5; the `TODO(#2)` markers).

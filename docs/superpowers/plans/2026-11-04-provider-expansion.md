# Video Provider Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver YouTube visibility/processing, compliant TikTok manual posting, and Snapchat Spotlight/public Story publishing without enabling unverified providers.

**Architecture:** Extend existing adapters and shared authenticated routes, job snapshots, preferences and durable diagnostics. Use additive platform-specific side tables; freeze options before queue dispatch. Execute provider slices sequentially because they share core interfaces and UI.

**Tech Stack:** TypeScript, Cloudflare Workers/D1/Queues, Hono, Vitest Workers pool.

**Spec:** docs/superpowers/specs/2026-11-04-video-provider-expansion-design.md (maintainer approved in session).

## Global Constraints

- Preserve historical divine-crossposter Worker, encryption key, shared D1 and verifier-host publishing isolation.
- Nothing publishes merely because an account is connected; providers remain disabled until credentials/access and authorized real tests are verified.
- Add side tables; do not drop or alter shared legacy tables.
- Synthetic identities only in tests. No credential values or customer diagnostics in git/GitHub.
- Preserve duplicate-delivery and post-dispatch ambiguity protection; a processing ID alone is not success.
- Snapchat destinations are Spotlight and public Stories; no silent destination/audience changes.
- TikTok supportsAutomatic=false; explicit per-post privacy/consent and exact confirmed caption are mandatory.
- Preserve pending PR #49 repairs; base branch includes the PR #50 source-text fix, not a replacement implementation.

## Review Focus

1. A user removes TikTok attribution: stored/published caption exactly matches consent, with no attribution reinserted.
2. Preference changes or duplicate submissions during queue delay cannot alter an existing job's audience or destination.
3. Upload accepted but processing fails or privacy differs: durable status remains accurate and no duplicate upload occurs.
4. Legacy TikTok automatic preferences/API clients must not bypass the new manual consent requirements.
5. A provider returns HTTP 200 with missing IDs, malformed/nested error or arbitrary upload URLs: fail safely without leaking credentials or replaying ambiguous posts.

### Task 1: YouTube visibility and processing

**Files:** src/platforms/youtube.ts and tests; src/types.ts; src/platforms/adapter.ts; src/db/jobs.ts and preferences.ts/tests; migrations/0009_youtube_options.sql; src/services/crossposts.ts, connections.ts, publisher.ts and tests; src/routes/preferences.ts, crossposts.ts, health.ts and tests; README.md.

**Interfaces:** Add optional `youtubePrivacyStatus` ('private'|'unlisted'|'public'|null) to preferences, jobs and publish input; optional `youtubeTitle` on jobs/publish input. Manual crossposts accept an unknown youtubePrivacyStatus validated before job creation. Saved preference or configured default applies when absent; job options are immutable. Preserve existing updatePreference call sites by adding an optional final options argument or compatible equivalent. Persist options transactionally with jobs. Adapter polling consumes a known external video ID from sanitized provider checkpoint.

- [x] Write failing regression tests for private/unlisted/public preference round trips; manual override/saved automatic snapshots; duplicate retains original; invalid/unselected-platform values rejected; legacy configured fallback.
- [x] Run affected tests and inspect expected failures.
- [x] Implement additive option storage, API/UI controls and source-derived Unicode-safe YouTube title. Preserve complete source description within limits; title excludes attribution.
- [x] Write failing adapter/publisher tests for processing→posted, rejected/failed processing, missing ID, privacy mismatch and interruption after dispatch.
- [x] Implement processing polling, canonical destination links, sanitized ID checkpoints and dispatch ambiguity fence. Never reupload an ambiguous or accepted known upload. UI distinguishes uploaded privately from public publication.
- [x] Run affected tests, npm run test:once, npm run typecheck, git diff --check. Expected: all pass; no provider enabled or real posts sent.
- [x] Commit, report exact verification and limitations, then independent task review.

### Task 2: TikTok manual consent and controls

**Files:** src/platforms/tiktok.ts/tests; new src/services/tiktok-posting.ts/tests and src/routes/tiktok.ts/tests; src/index.ts; src/types.ts; src/platforms/adapter.ts, registry.ts/tests; migrations/0010_tiktok_options.sql; src/db/jobs.ts/tests; src/services/crossposts.ts, connections.ts, publisher.ts and tests; src/routes/crossposts.ts, health.ts and tests; README.md.

**Interfaces:** Typed `TikTokPostOptions` job/publish input includes privacyLevel, allowComment/allowDuet/allowStitch booleans, brandOrganic/brandContent booleans, confirmedCaption string, explicit musicUsageConfirmed true, verified duration and creator-info confirmation data as required. Authenticated GET `/connections/tiktok/creator-info` returns safe current creator info only for the caller's connection. Manual job body accepts `tiktokPostOptions`; require and server-validate using fresh creator_info/source duration. Any new source duration data is derived from validated event metadata, never trusted client input. Missing authoritative duration fails eligibility, not silent guessing.

- [x] Write failing tests for owner isolation, latest creator info, duration/limit errors, explicit valid privacy, interaction restrictions, disclosure/consent validation and missing options.
- [x] Write failing tests rejecting automatic TikTok preferences and excluding legacy automatic preferences from all dispatch paths.
- [x] Run focused tests; inspect failures.
- [x] Implement preview/confirmation UI with editable Divine text, no default privacy, unchecked interactions, commercial disclosures and exact provider-required consent. Disable submit until complete; safe text rendering for provider/user values.
- [x] Snapshot exact confirmed caption/options; never re-add attribution or truncate consented caption after confirmation (reject excessive length instead). Wire creator API, routes, options and adapter. Preserve processing polling; reject empty publish IDs and HTTP-200 provider errors.
- [x] Add regression asserting removal of all preset attribution survives enqueue/publish unchanged; duplicate submission does not mutate a job. Ensure required controls are enforced API-side.
- [x] Run affected tests, full suite, typecheck and diff check. Expected: pass, supportsAutomatic=false, provider remains disabled.
- [x] Commit/report, then independent task review.

### Task 3: Snapchat OAuth, profiles and both destinations

**Files:** new src/platforms/snapchat.ts/tests and platform-specific helpers as needed; src/types.ts; src/utils/validation.ts/tests; src/platforms/registry.ts/tests and adapter.ts; migrations/0011_snapchat_options.sql; src/db/jobs.ts, preferences.ts/tests; src/services/connections.ts, crossposts.ts, publisher.ts/tests; routes/preferences.ts, crossposts.ts, health.ts, connections.ts and tests; src/config.ts; src/routes/platform-matrix.ts where relevant; README.md and rollout checklist.

**Interfaces:** Platform union adds 'snapchat'. Optional `snapchatDestination` ('spotlight'|'story'|null) on preferences/jobs/publish input; saved default is spotlight, explicit per-post override frozen in job. Env adds ENABLE_SNAPCHAT, SNAPCHAT_CLIENT_ID, SNAPCHAT_CLIENT_SECRET and any separately documented approval/readiness flag needed. Use current Snap OAuth/Public Profile contracts verified from primary docs. Account ID is a confirmed authorized public-profile ID; expose authenticated eligible-profile selection if multiple, without choosing a profile silently. Connection/profile selection must preserve encrypted token ownership and single account/destination job semantics.

- [x] Verify current Snap OAuth scopes, profile discovery/authorization, media encryption/upload, destination and processing endpoints from primary docs. Record contracts and safe setup checklist; no secrets or app activation.
- [x] Write failing tests for OAuth/refresh/missing fields, profile selection/ownership, disabled setup readiness, both destination options and immutable snapshots/duplicate behavior.
- [x] Implement adapter/registry/core and authenticated profile-selection UX with explicit confirmation. Keep credentials/app access missing states actionable, never pretend Login Kit is publishing access.
- [x] Write failing API-contract tests for media encryption/container/chunks/finalize and destination publish; nested 200 errors, limits, invalid upload URLs, permission loss, polling completion/failure and ambiguous dispatch without replay.
- [x] Implement bounded upload and resumable/provider checkpoints; apply caption only to supported fields. Validate authoritative media duration/dimensions/size per destination and fail actionably on missing/invalid eligibility. Do not transcode or add text overlays. No arbitrary response URL receives access tokens.
- [x] Wire both destination settings/manual override/default and automatic opt-in; render statuses and links accurately. Add migration, API docs, readiness and rollout instructions.
- [x] Run affected tests/full suite/typecheck/diff check. Expected: all pass, no Snapchat enablement or real post.
- [x] Commit/report, then independent task review.

### Task 4: Integration, delivery and rollout handback

**Files:** README.md; docs/provider-rollout.md; docs/cutover-secrets.md; approved spec status; scripts/install-publishing-secrets.sh and mocked tests; scripts/check-production-health.sh and tests (or equivalent focused helper); package.json; .github/workflows/ci.yml and production-health.yml; src/utils/errors.ts/tests; src/services/publisher.ts/tests; src/routes/health.ts/tests as needed. Preserve existing workflow permissions, conditions and deployment targets.

**Setup evidence:** Read the controller's ignored task-4-setup-notes.md before implementing. It contains verified CLI behavior, current setup dependencies and privacy boundaries. Copy only safe technical substance into tracked docs.

- [ ] Recheck origin/main and PR49/50 heads. Integrate pending PR49 owning branch into this feature (or updated main if landed), preserving its original commits and human README contribution; PR50 already integrated. Do not push either owning branch or merge default. Resolve additive migration ordering and preserve IG/X behavior and exact TikTok consent.
- [ ] Write failing regression for HTTP402 on pure status polling of an accepted external post: retain known ID/processing and bounded polls, then truthful unknown/manual reconciliation; never republish. Preserve pre-dispatch billing terminal handling and Snapchat media_ready outward POST fences. Implement scoped fix. Assess stale IG default-destination save UI: a safe Off downgrade must be visible after save rather than falsely showing Automatic.
- [ ] Verify primary YouTube error contract and write failing publisher regression for quotaExceeded HTTP403 preserving connected credentials. Implement narrow reason classification/accurate quota diagnostics while retaining true authorization handling; distinguish uploadLimitExceeded without inventing retry times.
- [ ] Write meaningful mocked secure-helper tests, then implement a selected-provider-only installer for youtube/tiktok/snapchat. Collect the complete credential pair using hidden prompts before any write; serialize only those two fields to a single pinned Wrangler secret bulk --name divine-crossposter call via JSON stdin. No secrets in argv/output/files/history; no encryption/IG/X/Discord changes, null/delete values, enablement or deployment. Tests must be incapable of writing real Cloudflare secrets even with cached local OAuth (explicit mock runner plus invalid credential environment), using synthetic credentials only. Add separate test:provider-setup command and CI step without changing test:once argument forwarding.
- [ ] Write failure-output tests for production probe HTTP/release/readiness/provider-state checks and implement safe stage-specific summaries. Output only allowlisted hosts/provider names/state values; no raw response/user data/tokens. Preserve notification mechanism, deployment conditions and workflow permissions.
- [ ] Document current safe OAuth setup (API key does not grant publishing), scopes/callbacks/access/approval gates, historical preserved Worker, native client limitations and external owner dependencies without sensitive resource IDs. Correct historical cutover banner; mark spec approved in session. Acceptance deployment, if needed later, requires separate Worker/host/D1/key and registered test callback; do not provision or activate here.
- [ ] Run focused regressions, full suite, helper/probe tests, typecheck and diff check. Commit and report exact evidence/limits; independent task review. Flags remain disabled; no credential writes or live publications.

**Controller-owned final delivery (after task review):**
- [ ] Fresh adversarial whole-branch review against approved spec, one fix wave and scoped re-review for Important/Critical findings.
- [ ] Rewrite final PR53 title/body for complete scope and preserved contributor provenance; commit/push own branch, mark ready, request mapped reviewers once, publish verified independent review. Inspect latest required/relevant CI. No default-branch merge.
- [ ] Hand back concrete source outcome and separately identify external activation gates; do not fabricate live acceptance. Preserve private ignored evidence before worktree cleanup.

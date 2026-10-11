# Instagram Destinations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver the approved saved Story / Reel / Reel + feed choice with a per-video override.
**Architecture:** Add destination-only side tables without altering shared tables. Snapshot the selected destination atomically with job creation and pass it to the Instagram adapter; retain legacy behavior when absent.
**Tech Stack:** TypeScript, Hono, D1, workerd/Vitest, hosted JavaScript.
**Spec:** docs/superpowers/specs/2026-10-11-instagram-destinations-design.md

## Global Constraints

- `instagramDestination: "story" | "reel" | "reel_feed"` is additive and optional on writes.
- No existing shared tables are altered; no new OAuth scopes or transcoding.
- Duplicate crossposts retain their original destination. Polling never creates a replacement container.
- Native app UI is a separate integration; document its additive API contract here.

## Review Focus

- Mode-only updates and reconnects must retain a saved destination.
- Duplicate requests with different destinations must keep the first job's selection.
- Old jobs and absent preferences must preserve existing publishing requests.
- Invalid destination/platform combinations must fail before mutation.
- UI rerenders must retain unsent per-video choices; existing jobs show their immutable destination.

### Task 1: Persist preferences and immutable job destinations

Files: src/types.ts, src/db/preferences.ts, src/db/jobs.ts, migrations/0007_instagram_destinations.sql, src/services/connections.ts, src/services/crossposts.ts, src/routes/preferences.ts, src/routes/crossposts.ts, src/utils/validation.ts, corresponding tests.
Interfaces: optional InstagramDestination writes; nullable destination reads on Instagram preferences and all jobs; createOrGetJob batches job and option insertion.
- [x] Add failing real-D1 tests for saved selection, omitted-field preservation, manual override, automatic default, immutable duplicate, and invalid requests.
- [x] Run focused tests and confirm failures reflect missing selection handling.
- [x] Implement side tables, validation, atomic writes and selection precedence. Join option data on job reads, including claims.
- [x] Run focused tests and typecheck; commit.

### Task 2: Publish the selected format

Files: src/platforms/adapter.ts, src/platforms/instagram.ts, src/services/publisher.ts, src/platforms/providers.test.ts, src/services/publisher.test.ts.
Interfaces: PublishInput.instagramDestination; immutable job selection supplied by publisher.
- [x] Test Story omits caption/feed, Reel sets false, Reel + feed sets true, legacy omits feed, and malformed IDs fail.
- [x] Confirm failures, implement mappings and ID checks, verify processing resume remains unchanged.
- [x] Run provider and publisher tests; commit.

### Task 3: Hosted controls and integration documentation

Files: src/routes/health.ts, src/routes/health.test.ts, README.md.
Interfaces: labelled default and per-video selectors; request field from selected control; status labels reflect stored jobs.
- [x] Test rendered selectors, eligibility/Story messaging and request payloads.
- [x] Add controls with persisted per-video draft selections; explain Story limitations and Reel + feed behavior.
- [x] Document API examples and native integration. Run full suite and typecheck, inspect changes and CI; commit.

## Verification record

Implementation and local verification completed inline. Typecheck and all 615 tests passed, including real-D1 concurrent insertion and transaction rollback. Browser preview confirmed saved Story with a per-video Reel + feed override. Independent review found stale untouched defaults and old-account job matching; both were reproduced and fixed with failing-then-passing tests.

Ruling: retain provider-side Story duration/encoding validation because the source snapshot has no verified media metadata. Cost: an unsupported video reports a provider rejection after submission rather than being rejected before queueing.

Live OAuth setup, actual external post placement, production migration/deployment and native mobile controls remain outside this local verification. TikTok creator-control work remains a rollout prerequisite documented in README; this branch fixes its token validation and terminal polling failures only.

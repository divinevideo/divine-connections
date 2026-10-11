# Instagram destination choices

Status: design direction approved; written specification awaiting Rabble's review.

## Outcome

A creator chooses Story, Reel, or Reel + feed when crossposting an original Divine video. Save a default for automatic crossposting and allow a manual per-video override. The user approved these three choices on 2026-10-11. Existing opt-in, ownership, and duplicate-post protections continue to apply.

## User experience

Add an Instagram destination selector beside the existing posting-mode selector in the crossposter setup page. Label the choices “Story”, “Reel”, and “Reel + feed”. Explain that feed placement is a Reel shared to the feed; Stories expire after 24 hours and do not carry the video's caption or a clickable link sticker. Do not imply guaranteed algorithmic placement.

The manual video action displays the effective destination before posting and permits changing it for that video without changing the saved default. One destination per crosspost: simultaneously posting a Story and Reel is outside this change. New explicit choices default to Reel; existing preferences with no destination remain on their existing behavior until the creator saves a choice.

Keep unsupported-account errors actionable. Use Instagram Login's professional-account requirements; do not infer restrictions for this login flow from documentation that only covers Facebook Login. Provider eligibility or media rejection must not silently fall back to another destination.

## API and storage

Use `instagramDestination: "story" | "reel" | "reel_feed"` as an optional additive field on `PUT /preferences/instagram` and returned preference summaries. Omitting the field preserves the stored destination. An explicit destination is rejected on other platform preference routes. Invalid values return HTTP 400 before writes.

Manual `POST /videos/:event_id/crossposts` accepts optional `instagramDestination` when `platforms` includes `instagram`. Resolve destination from the explicit override, then saved preference, then legacy behavior. Automatic creation always uses the saved preference. Do not permit an override to bypass connection, ownership, video eligibility, or opt-in checks.

The repository prohibits altering existing shared tables. Add two small tables through a new migration:

- `instagram_preferences`: `pubkey` primary key, checked destination text, `updated_at`.
- `instagram_job_options`: `job_id` primary key referencing `jobs(id)` with cascading deletion, checked destination text.

Write job options atomically with job insertion, before queue dispatch. A duplicate request returns the existing job and its original destination; it never changes a pending or published job's destination or causes an additional post. Store no row for legacy jobs. Preference changes affect only subsequently created jobs. Connection refresh/reconnection and mode-only updates preserve the saved destination.

Include `instagramDestination` in authenticated job responses (null for legacy jobs). Read the immutable job option during publishing and pass it to the adapter. API docs and mobile integration instructions document the additive contract; this change builds the hosted crossposter UI and backend, with native mobile UI integration a separate repo change.

## Publishing

Keep the current Instagram Login host and permissions. Map explicit choices as follows:

| Choice | Container parameters |
| --- | --- |
| Story | `media_type=STORIES`, `video_url`; omit `caption` and `share_to_feed` |
| Reel | `media_type=REELS`, `share_to_feed=false`, video and caption |
| Reel + feed | `media_type=REELS`, `share_to_feed=true`, video and caption |
| Legacy / absent | Current `REELS` request, no explicit `share_to_feed` |

The destination is fixed at container creation. Resume processing by container ID without creating another container or consulting updated preferences. Validate container and published-media IDs before reporting success. Keep permalink lookup best-effort after successful publication. Provider account/media failures are surfaced; no automatic destination substitution.

Story media must meet Meta's documented limits (3–60 seconds, at most 100 MB and supported video encoding). Use available trusted media metadata for preflight validation, and let Meta enforce constraints that cannot be established without adding a transcoder. Do not truncate or transcode in this worker.

## Tests and acceptance

Use real workerd/D1 tests with only upstream HTTP stubbed. Verify all three request mappings; preference persistence across mode-only updates and reconnects; manual override versus saved default; automatic selection; unauthorized and invalid requests; transactional job/options insertion; duplicate submission with a different destination; legacy fallback; queued-job immutability; and polling without another container. Test the rendered UI controls and effective selection, plus typecheck and the full suite.

Live verification requires an authorized professional Instagram account and an explicitly selected test video. Inspect resulting Story/Reel placement before claiming production support. A mocked adapter test does not establish provider approval or a successful live post.

## Sources

- Current code: `src/platforms/instagram.ts`, `src/services/connections.ts`, `src/services/crossposts.ts`, `src/services/publisher.ts`, `src/routes/health.ts`, and the shared D1 migrations.
- Meta content publishing: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/
- Meta media endpoint and Story limits: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
- Meta feed placement example: https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-15c537cd-a773-4b40-a87c-27829e49a439

Sources checked 2026-10-11. No new OAuth scopes, separate service, watermarking, or client-side provider credentials are introduced.

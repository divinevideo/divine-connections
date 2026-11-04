# YouTube, TikTok and Snapchat publishing

Status: proposed implementation design; awaiting maintainer approval.

## Intent and agreed scope

Creators can send their own Divine videos and original post text to YouTube,
TikTok, and Snapchat through the existing opt-in crossposter. Snapchat offers
both Spotlight and public Stories, as selected by the maintainer. The existing
Off/manual/automatic model remains available only where the provider supports
that workflow. Nothing publishes merely because an account is connected.

Success means a creator can connect, select a supported destination and audience,
preview and confirm a manual post, and receive an accurate durable result with
a destination link when available. Rollout requires an authorized real upload
and verification of its destination, visibility, caption, and terminal status.
Mocked API success is insufficient to declare production readiness.

## Existing work and verified gaps

The active service is divine-connections, deployed as the historical Cloudflare
Worker divine-crossposter. Preserve that Worker, its token-encryption key,
shared D1, queue and existing accounts. Do not create another publishing service.

YouTube and TikTok already have OAuth, refresh, account lookup, publishing and
adapter tests. Both are disabled in configuration. A credential-name inventory
on 2026-11-04 found neither Google nor TikTok credentials on the production
crossposter; the legacy verifier has TikTok credential names. Cloudflare cannot
return existing secret values. Credential presence does not prove permissions
or approval. Never copy credentials through chat or a tracked file.

YouTube setup is tracked in divine-identify-verification-service issue #87,
assigned to mbradley. That issue documents missing Google credentials. Matt's
TikTok PR #14 tested sandbox identity OAuth. Production approval issue #39 is
open; the existing review submission requests profile access and explicitly
describes no posting. Content Posting approval is therefore unverified and must
be checked separately. No Snapchat developer-app setup or approval was found
in the company sources searched; absence of records is not proof none exists.

## Approaches

Extend the current server-side OAuth/adapters/jobs service. This is the proposed
approach because the requested feature extends existing crossposting and retains
its saved preferences and durable diagnostics. Reuse an existing approved Divine
app where its owner and provider permit publishing; otherwise create the needed
app in a team-owned account with a named owner.

A native share-sheet integration would let creators finish inside each platform,
but requires separate mobile work and does not provide this service's automatic
publishing or durable publication result. It is a future alternative if a provider
rejects server-side access, not a silent substitute for this implementation.

A third-party publishing broker would introduce another dependency and permission
boundary while existing adapters already cover two providers. It is not proposed.

## YouTube

Reuse the resumable-upload adapter and encrypted OAuth token lifecycle. Configure
a team-owned Google web OAuth client, enable YouTube Data API, and register the
exact production callback /connections/youtube/callback under the crossposter
origin. Request youtube.upload and youtube.readonly; a proof-verification API
key does not grant uploads. Check consent-screen/testing restrictions and any
current provider review requirements directly before rollout.

Add creator-visible visibility selection (private, unlisted, public) to settings
and manual confirmation, defaulting to private. Freeze that selection in each job;
manual choice overrides the saved default and automatic posts use that default.
Existing jobs retain their original configured behavior. Preserve the complete
Divine description within platform limits and derive a valid short title from
source metadata; avoid cutting an emoji in half or using attribution as the title.
Do not promise Shorts classification merely because upload succeeded.

An accepted upload is not necessarily a playable published video. Poll processing
and verify effective privacy; distinguish processing, private upload and public
publication in status/copy. Persist the upload ID before any next request and
preserve the existing ambiguity safeguards to prevent duplicate uploads.

## TikTok

First confirm the production app, owner, approved scopes and Content Posting
review status. Add the crossposter callback to the app and verify ownership of
the actual media domain/prefix used for PULL_FROM_URL. Existing verifier Login
Kit approval does not imply video.publish approval.

Manual Direct Post is the initial supported flow. Fetch current creator_info for
the confirmation screen. Show the destination account, video preview, editable
caption initialized from Divine text, duration eligibility and provider-returned
privacy options. Require explicit privacy selection with no preselected value.
Expose comment, duet and stitch controls, initially unchecked and disabled when
the provider forbids them. Provide commercial-content disclosures and required
music/branded-content consent before submitting. Revalidate eligibility at submit;
if settings have changed, require fresh confirmation rather than altering consent.

Persist the confirmed options and caption in an additive job-options record.
Reject missing/invalid options in the API as well as the UI. Query and poll
provider status; provider errors inside successful HTTP responses are failures,
and a publish ID alone is not evidence of completion. Respect private/test-only
limitations until approval is verified. Remove the current hardcoded SELF_ONLY
choice and permissive interaction flags from the public publishing path.

Advertise supportsAutomatic=false and reject automatic TikTok preferences/jobs
server-side. This is a proposed engineering decision: the existing unattended
flow cannot supply the required per-post choices and consent. Do not silently
turn saved automatic preferences into uploads. Draft export using video.upload
is a separate future workflow, not a successful Direct Post fallback.

## Snapchat

Add Snapchat to the platform registry, OAuth/account lifecycle, provider status,
UI, preferences, job validation and publisher adapters. Use the Public Profile
API with verified app allowlisting and authorized public-profile access. Do not
advertise private/friends Stories or assume Login Kit provides publishing rights.

Offer an eligible public-profile selector if the account can publish to multiple
profiles. The creator must confirm the selected profile. Store its stable provider
ID with the connection, and require reconnection/reselection after permission loss.

The destination options are Spotlight and public Story. Proposed default is
Spotlight, visibly selected and editable; manual choice overrides the saved default.
Store the chosen destination with each job before dispatch. A duplicate submission
must retain the original destination and must not create a second publication.
Changing the preference affects future jobs only. Automatic posts use the saved
profile/destination and explicit automatic opt-in.

Implement the documented encrypted media-container, chunk-upload and finalization
flow followed by destination-specific posting and status verification. Validate
current duration, aspect ratio, file size and caption constraints for the selected
destination. Reject unsupported media with an actionable message; no implicit
transcoding or destination switching. Apply source text to fields supported by
that destination; do not promise text overlays on Stories or silently invent them.

Persist resumable media/publish state and verify request_status and nested errors.
Retries resume a known upload or poll a known post. Never retry an ambiguous
publication by blindly creating another. If public-profile access is unavailable,
keep Snapchat visibly unavailable with a specific setup/review reason.

## Shared reliability, data and consent

Use additive migrations/side tables; do not alter or drop the shared legacy
connection/job tables. Keep platform-specific choices in typed, validated job
snapshots and preferences. Maintain ownership checks, encrypted tokens, exact
OAuth redirect matching and verifier-host publishing isolation.

Use existing operation_diagnostics, provider readiness, scheduler monitoring and
Buzz alert delivery. Distinguish credentials missing, review/access pending,
reauthorization, media rejection, throttling, processing timeout and billing blocks.
Do not report success for accepted-but-unfinished media or silently narrow audience.
All provider secrets and user tokens stay out of diagnostics, PRs and fixtures.

Original-text fallback is being delivered in PR #50 and billing/setup repairs in
PR #49. Recheck their state before implementation; integrate via their owning
branches or merge normally rather than overwriting pending work. Existing external
posts are never edited, replayed or deleted by this rollout.

## Delivery and validation

1. Inventory provider apps and named owners, then prepare secure credential setup
   and review collateral; record verified approval status without secret values.
2. Deliver YouTube visibility/processing changes and staging/production setup.
3. Deliver TikTok manual controls, API validation and automatic-post rejection.
4. Deliver Snapchat connection, profile/destination choices and publishing state.
5. Run authorized end-to-end acceptance per provider before enabling it broadly.

Each slice has regression tests for options, ownership, OAuth/provider failures,
status transitions, duplicate delivery and ambiguity. Add provider-contract fixtures
with synthetic identities only. Run affected tests, full suite/typecheck as
appropriate, fresh independent review and required CI. Request mapped reviewers;
respect actual GitHub-enforced approval before merge/deploy.

Actual publishing needs a maintainer-selected account/video and explicit consent
for that platform/destination. Prior authorization to publish on Instagram or X
does not authorize new YouTube/TikTok/Snapchat posts. Do not purchase API access,
accept new commercial terms, rotate shared credentials or message team members
without the corresponding authorization.

## External dependencies and non-goals

Google/TikTok/Snap approval and secure credential access are external dependencies,
not implementation completion claims. No follow discovery, new mobile integration,
content import, third-party account reposting, video transcoding, or cross-platform
metrics dashboard is included. Engineers may settle internal schema, module and
polling details after measuring current API limits; changes to user-visible scope
return to the maintainer.

## Sources

- https://github.com/divinevideo/divine-identify-verification-service/issues/87
- https://github.com/divinevideo/divine-identify-verification-service/pull/14
- https://github.com/divinevideo/divine-identify-verification-service/issues/39
- https://github.com/divinevideo/divine-identify-verification-service/blob/main/docs/tiktok-review-submission.md
- https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- https://developers.tiktok.com/docs/en/content-sharing-guidelines
- https://developers.snap.com/marketing-api/Public-Profile-API/GetStarted
- https://developers.snap.com/marketing-api/Public-Profile-API/ProfileAssetManagement

Internal company-search evidence informed the setup investigation, not customer
fixtures: Brain D6309049FC048701AF1B8C905D and 46FEEE582F4CAE1A5E64209B9B.

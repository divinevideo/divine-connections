# Snapchat rollout checklist

Status: disabled; no credentials, app access, or live posting were changed by this
implementation. The requirements below need explicit maintainer authorization
where they modify external settings or publish content.

1. Identify a team-owned Business Manager OAuth app and named operator. Confirm
   Public Profile API allowlisting and content-management access with Snap. The
   OAuth scope reference calls `snapchat-profile-api` read access even though
   the Public Profile guide documents content management; resolve the app's
   actual publishing entitlement with Snap. Do not infer it from Login Kit,
   data-sharing access, or a successful profile read.
2. Securely install client credentials and register the exact crossposter callback
   documented in README. Use the canonical `/login/oauth2/access_token` endpoint
   for code and refresh; the Public Profile getting-started page has an inconsistent
   `/token` example. Record app owner/approval evidence without secret values.
3. Apply additive migration 0011 through the normal release workflow. Keep both
   checked-in flags false. Confirm readiness distinguishes missing credentials,
   pending Public Profile access, and deliberately disabled configuration.
4. In an authorized isolated environment, connect a synthetic/test owner. Confirm
   token encryption and refresh, explicit profile selection, organization profile
   pagination, permission loss, and inability to use another Divine owner's
   connection. Profile discovery requires an own public profile and optionally
   lists profiles in that profile's organization; broader organization discovery
   is not implemented. Read access is not a per-profile publishing entitlement.
5. Obtain explicit consent naming the account, original video, and destination.
   Test both Spotlight and public Story, including source-link retention, original
   caption prefix, dimensions/duration, 16 MiB cap and real upload/finalize behavior.
   The English locale assumption (`en_US`) must fit the rollout audience.
6. Verify Spotlight actually becomes LIVE and its returned ID identifies the
   intended content. Check profile placement in Snapchat; the API does not
   guarantee placement on the Public Profile. The API supplies no public permalink; add a verified permalink mapping
   only after validating it with the authorized account. Story acceptance is not
   completion: verify the fresh snap's link/readback and actual 24-hour placement.
   Neither destination currently generates a public permalink.
7. Exercise a lost POST response and interrupted Worker. Confirm no second visible
   post, durable ambiguous status, and manual reconciliation. Partial media chunks
   are not resumed across invocations; only finalized media and submitted posts
   are resumed. Failed prepublication chunks may leave an expiring media container.
8. Inspect safe operation diagnostics and aggregate Snapchat health. Test alert
   delivery using an authorized test sink. Never paste raw provider bodies, source
   identity, tokens, keys, IVs or upload paths into public artifacts.
9. Confirm hosted selectors, explicit profile confirmation, manual cancellation,
   immutable job choices, automatic opt-in, disabled UI, and old verification host isolation.
   Exercise two tabs selecting different profiles: stale manual consent must return
   409, and reselection during refresh or before dispatch must produce no publication.
   A denial from old credentials must not invalidate a winning reconnect.
   Inspect required CI and independent review before an authorized rollout change.

## Verified primary references (2026-11-05)

- OAuth app, scope and code/refresh endpoints:
  https://developers.snap.com/marketing-api/Ads-API/authentication
- Own profile and organization-authorized profile discovery:
  https://developers.snap.com/marketing-api/Public-Profile-API/Profiles
- AES-256-CBC encryption, media containers, multipart ADD/FINALIZE, public Stories,
  Spotlight posting and status/readback:
  https://developers.snap.com/marketing-api/Public-Profile-API/ProfileAssetManagement
- Allowlisting and Public Profile setup:
  https://developers.snap.com/marketing-api/Public-Profile-API/GetStarted

No Ads media endpoint or Snap Kit sharing endpoint is used for publication.

# Publishing provider setup and rollout

The maintainer approved the YouTube, TikTok and Snapchat source implementation
in session. Production activation and real provider acceptance remain separate.
All three `ENABLE_*` flags remain false; Snapchat's Public Profile approval flag
also remains false. Connecting an account never opts a creator into publishing.

## Preserve the publishing service

Deploy this repository onto the historical Worker `divine-crossposter`, preserving
its existing token-encryption key, shared D1, queue and cron ownership. Do not
create a replacement publishing Worker against the production database, rotate
`TOKEN_ENCRYPTION_KEY`, or alter/drop shared legacy tables. The new option tables
are additive: migrations 0007/0008 retain Instagram and reliability repairs;
0009/0010/0011 add YouTube, TikTok and Snapchat snapshots in order.

The configured hosts are `https://crossposter.divine.video` and
`https://verify.divine.video`. The second only redirects to the separate verifier
service at `https://verifier.divine.video` and serves no publishing routes.
Historical rollout notes are not current release verification. Do not infer a
service outage or change security settings from a client's blocked HTTP probe.

## Credentials and provider access

A provider owner must supply and verify the complete OAuth credential pair,
registered callback, scopes and publishing access. Cloudflare secret values are
write-only. Secret-name presence or successful installation does not prove OAuth
works or establish approval. Never put values in chat, source, tickets or logs.

After `npm ci`, an authorized operator can run one of these from a private terminal:

```bash
bash scripts/install-publishing-secrets.sh youtube
bash scripts/install-publishing-secrets.sh tiktok
bash scripts/install-publishing-secrets.sh snapchat
```

The helper collects both hidden values before writing, aborts on missing input,
and sends exactly the selected pair as JSON stdin to one pinned Wrangler bulk
request targeting `divine-crossposter`. It does not enable a provider or deploy.
It does not touch encryption, Instagram, X or Discord credentials. Use the
provider-specific helper instead of the historical broad secret installer.
Bulk success only establishes that the write was accepted; do not assume that
an interrupted request made no change or print its payload while investigating.

| Provider | Complete pair | Registered callback | Requested scopes and external gates |
| --- | --- | --- | --- |
| YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `https://crossposter.divine.video/connections/youtube/callback` | `https://www.googleapis.com/auth/youtube.upload` and `https://www.googleapis.com/auth/youtube.readonly`; YouTube Data API enabled, valid web OAuth client, consent configuration/test users, any required verification/audit, channel upload access and quota. |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `https://crossposter.divine.video/connections/tiktok/callback` | `user.info.basic,user.info.profile,video.publish`; approved Content Posting API Direct Post access, configured Login Kit callback and verified source-media domain. |
| Snapchat | `SNAPCHAT_CLIENT_ID`, `SNAPCHAT_CLIENT_SECRET` | `https://crossposter.divine.video/connections/snapchat/callback` | `snapchat-profile-api`; Public Profile API publishing approval and authorization for the explicitly confirmed profile. Login Kit alone does not grant publishing access. |

An existing Google project and API-key metadata have been verified separately;
that does not verify a usable publishing OAuth client, consent setup or approval.
An API key cannot authorize uploads.
Operators must verify current credentials/access privately; this document records
no private resource identifiers or credential values.

YouTube snapshots private/unlisted/public visibility and confirms readback;
private uploads are not public posts, and YouTube decides Shorts classification.
Its documented `quotaExceeded` HTTP403 is a quota failure, not rejected login.
`uploadLimitExceeded` HTTP400 is a channel upload limit. Neither supplies a
confirmed retry/reset time; neither invalidates a valid connection. Confirm the
quota/channel limit before another manually authorized upload.

TikTok always advertises `supportsAutomatic=false`. Every post requires fresh
creator info, explicit privacy, interaction/disclosure choices and required
consent. The caption sent is the exact confirmed text, including deliberately
empty text; no attribution may be reinserted after confirmation.

Snapchat destinations are Spotlight and public Stories. Confirm the authorized
Public Profile and selected destination; never substitute a destination or
audience. Spotlight descriptions support text, while Stories do not support a
matching text-caption field. See [Snapchat media and rollout limits](snapchat-rollout.md).

## Acceptance before activation

1. Provider/account owners verify app access, callback registration, scopes,
   source-media/domain requirements and quota. Install the selected complete pair
   only when authorized. Credential installation does not authorize activation.
2. Use an explicitly authorized real test on the intended account and destination.
   Confirm ownership, preview, exact caption, visibility and durable terminal
   readback. An upload/processing ID alone is not success. Repeated deliveries
   must never create another external post.
3. If acceptance requires a separate deployment, an operator must provision a
   separate test Worker and host, separate D1 and a separate test encryption key,
   then register that host's exact provider callback. Never point another Worker
   with a different key at shared production D1. This source change provisions
   nothing. Test enablement/approval flags do not authorize production flags.
4. Verify website flows and each intended consumer. This Worker serves no
   verification, so connecting Snapchat here produces no verified badge; any
   Snapchat verification belongs to the separate verifier service and must be
   integrated and tested there.
5. Only after credentials/access and an authorized real test are verified may an
   operator separately approve production activation. Inspect the deployed release,
   readiness and provider observations. Mocked CI is not live acceptance.

Accepted external posts whose pure status checks encounter billing HTTP402 retain
their checkpoint and bounded polling. If checks remain blocked, the result becomes
unknown and requires manual reconciliation at the provider; never repost it to
recover status. A definite billing failure before dispatch is terminal. Snapchat's
media-ready continuation performs an outward POST and retains its dispatch fence.
No automatic credit-top-up recovery or blocked-post replay is implemented.

## Source verification and operations

`npm run test:provider-setup` runs the real helper with a mandatory inert mock
runner, invalid credentials and an isolated home; it cannot use cached Wrangler
OAuth. Its synthetic inputs never reach Cloudflare. It also tests production
probe failures for HTTP, release, readiness and provider states without printing
responses, user data or tokens. The scheduled workflow uses the same probe and
preserves its existing failure-notification webhook. Unknown observation is not
proof of failure or live acceptance; enabled degraded providers fail the probe.

Official references: [YouTube errors](https://developers.google.com/youtube/data/reference/rest/v3/errors),
[YouTube uploads](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert),
[TikTok controls](https://developers.tiktok.com/doc/content-sharing-guidelines),
[Snapchat Public Profile API](https://developers.snap.com/api/marketing-api/Public-Profile-API/Introduction).

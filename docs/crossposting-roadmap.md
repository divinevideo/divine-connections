# Expanding crossposting to link-friendly platforms

Handoff brief, 2026-08-08. Task 1 is done and deployed (#40); tasks 2 onward
are open.

## CRITICAL: correct repo

The crossposter lives in **`divine-connections`**, NOT `divine-crossposter`.

`divine-connections` deploys over the Cloudflare worker still *named*
`divine-crossposter` — deliberately, to inherit secrets attached to that worker
name that cannot be read back (see `cutover-secrets.md`). The
`divine-crossposter` repo is superseded: its code no longer serves traffic, and
deploying from it would overwrite the live product.

## Why this work matters

Acquisition is Divine's measured bottleneck: new viewers fell 83% between May
and August. Viewer-to-creator conversion is 8-10% against ~1% typical, so every
acquired viewer is worth roughly 10x — which makes distribution the
highest-leverage thing we can build.

But the platforms currently supported are the ones structurally hostile to us:

- **TikTok, Instagram and YouTube penalise third-party watermarks** (Instagram
  states it will not recommend Reels carrying another app's watermark; YouTube
  treats them as non-original) *and* make outbound links useless in captions.
  Both defences are deliberate. They do not want to be top-of-funnel for a
  competitor.
- **Do NOT add watermarking.** It gets content suppressed on exactly the
  platforms where it would be applied. Crossposting to those platforms is worth
  keeping as a *creator retention* feature — creators reaching their existing
  audience — but it is not an acquisition channel and should not be treated as
  one.

The platforms worth adding are the ones where **links still work**.

## Current state

`src/platforms/` has adapters for `tiktok.ts`, `x.ts`, `instagram.ts` and
`youtube.ts` behind `src/platforms/adapter.ts`. Jobs are queued via D1
(`src/db/jobs.ts`) with a `caption` field. Cloudflare Worker, TypeScript/Hono,
D1 and Queues.

## Task 1 — attribution (DONE, #40)

Every adapter passed through whatever caption it was handed, with no
attribution anywhere in the crosspost path: a vine landed on TikTok as a nice
video with no creator handle, no Divine reference, and no way back.

Captions now carry the creator handle and a link to the specific video, applied
server-side at job creation so it cannot be omitted. See
`src/services/attribution.ts`. Overridable via
`CROSSPOST_ATTRIBUTION_TEMPLATE`; empty string disables it.

## Task 2 — add link-friendly platforms

Ordered by fit. Each should implement the existing adapter interface
(`publishVideo({ accessToken, videoUrl, caption })`) and the OAuth plus
token-refresh pattern the current four use.

1. **Bluesky / ATProto** — links and video work, and the culture is actively
   sympathetic to open protocols. **Check `divine-sky` and `rsky` first.**
   Divine already runs ATProto infrastructure (`divine-atbridge`,
   `divine-handle-gateway`, a PDS at `pds.divine.video`). There may be
   substantial reuse rather than a fresh integration. Note this repo already
   has `src/verify/bluesky.ts` and `src/verify/atproto.ts` for identity
   verification against the public AppView.
2. **Mastodon / fediverse** — `divine-activity-pub` already projects Divine
   accounts as `@user@divine.video` actors that Mastodon and Pixelfed can
   follow. Coordinate rather than duplicate. Mastodon is multi-instance, so
   OAuth is per-instance and the flow needs an instance picker.
3. **Tumblr** — strongest cultural fit of any platform on this list. GIF and
   loop native, nostalgia-heavy, user base skews the same 30-40 as Divine's
   creators. OAuth 1.0a, which is more annoying than the rest — budget for it.
4. **Reddit** — large, right demographic, native video *and* working links,
   existing communities around Vine nostalgia. Needs subreddit selection and
   per-subreddit rules handling; that UX is the hard part, not the API.
5. **Pinterest** — consistently underrated for outbound traffic, video pins
   work, demographic fits.
6. **Discord** — webhook-based rather than OAuth-per-user, so a different
   shape. Lower priority, but embeds autoplay and it is where friend groups
   actually share things.

## Constraints

- Marketing campaign lands **2026-08-18**; invite gating is removed
  **2026-08-20**. Expect two traffic peaks, the second larger and ungated.
  Ship new platforms behind flags, disableable without a redeploy.
- Respect per-platform rate limits and quota. A campaign-scale spike of
  crossposts could trip app-level API limits and get the Divine app
  rate-limited or suspended on a partner platform. Queue and back off.
- Token refresh and `needs-reauth` states already exist client-side — the
  mobile l10n carries the full state machine: queued / uploading / processing /
  posted / failed / skipped / needs-reconnecting. Match those states.

## Related work, not in this repo

Crossposting is currently hidden and non-native in `divine-mobile`. It is fully
built but not surfaced, and is not offered at the moment of publishing, which
is where intent is highest. That is a `divine-mobile` task.

## Open questions raised against this brief

- **Attribution shape may want to vary by platform.** On Bluesky, Mastodon and
  Tumblr the link is a real, clickable, unpenalised link and could be more
  prominent; on TikTok and Instagram it is inert text and the current trailing
  placement is right. `buildCrosspostCaption` already takes the platform, so
  this is cheap to do — it is a product call, not a technical one.
- **X connect has never worked** and is unrelated to this brief, but blocks
  crossposting to X entirely. It needs X developer portal configuration; see
  the notes in `cutover-secrets.md` for what is missing elsewhere.

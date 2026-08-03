# Finishing the merge: where every secret currently lives

The merge moved the **code** into `divine-connections` but none of the
**configuration**. Every credential still sits on one of the two workers the
merge is supposed to retire, which is why the merged worker serves a crippled
version of the product: Discord and YouTube report unsupported, Quick Connect
renders empty and is omitted, and every user is pushed down the manual
proof-post path.

## Inventory, as of the last check

| secret | lives on | `divine-connections` | unlocks |
|---|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | crossposter | missing | **all** OAuth account linking, crossposting |
| `TWITTER_CLIENT_ID` | crossposter | missing | X Quick Connect |
| `TWITTER_CLIENT_SECRET` | crossposter | missing | X Quick Connect |
| `INSTAGRAM_CLIENT_SECRET` | crossposter | missing | Instagram Quick Connect |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | crossposter | missing | Instagram webhooks |
| `DISCORD_BOT_TOKEN` | legacy verifier | missing | Discord proof verification |
| `TIKTOK_CLIENT_KEY` | legacy verifier | missing | TikTok Quick Connect |
| `TIKTOK_CLIENT_SECRET` | legacy verifier | missing | TikTok Quick Connect |
| `OAUTH_REDIRECT_BASE` | legacy verifier | set as a var | OAuth callbacks |
| `YOUTUBE_API_KEY` | nowhere | missing | YouTube proof verification |
| `GOOGLE_CLIENT_ID` / `_SECRET` | nowhere | missing | YouTube Quick Connect |

`GITHUB_TOKEN` is deliberately absent: GitHub verification reads the gist CDN
and needs no credential.

## Cloudflare secrets cannot be copied

They are write-only — there is no API that reads a secret back, so they cannot
be moved worker-to-worker by any script. Every value has to come from its
source or from wherever it was saved.

Where each one comes from:

- `TWITTER_CLIENT_*` — X developer portal, the OAuth 2.0 app
- `INSTAGRAM_CLIENT_SECRET` — Meta app dashboard (the Instagram business login
  product, app id `1495112838545237`, already set as a var)
- `TIKTOK_CLIENT_*` — TikTok developer portal, Login Kit
- `DISCORD_BOT_TOKEN` — Discord developer portal. Nobody holds a copy, so this
  one must be **reset** there and the new value installed on both workers.
- `YOUTUBE_API_KEY`, `GOOGLE_CLIENT_*` — Google Cloud console. Never configured
  anywhere, so YouTube is new work rather than a migration.

## `TOKEN_ENCRYPTION_KEY` is the one that needs a decision

It exists **only inside the crossposter worker**. It is not derivable and not
readable. Both workers bind the same D1 (`divine-crossposter`), and the
`connections` table stores `encrypted_access_token` / `encrypted_refresh_token`.

- **If you still have the value**, install it unchanged. Both workers keep
  working against the shared database during the transition.
- **If you do not**, generate a fresh one — but only in the same window as
  retiring the crossposter worker, because two workers holding different keys
  against one database is a split brain. The cost is that existing connections
  must be re-linked. The live table currently holds **1 row**, so that cost is
  one reconnection.

Generating a fresh key:

```bash
openssl rand -base64 48
```

A mismatched key does **not** fail at deploy time. It fails later, at token
refresh, and reads like the platform revoked access.

## Order of operations

1. Install the secrets below on `divine-connections`.
2. Confirm with `npm run test:e2e` — the capability and Quick Connect
   assertions name the exact missing secret and go green as each lands.
3. Move `verifier.divine.video` onto `divine-connections`. Do **not** do this
   before `DISCORD_BOT_TOKEN` is installed, or Discord verification regresses
   for anyone using that hostname.
4. Move `crossposter.divine.video`, enable the queue consumer and the cron in
   `wrangler.toml`, and disable both on the crossposter worker. A queue allows
   exactly one consumer, so these must happen together.
5. Retire the two legacy workers.

Steps 3–5 are issue #2. None of them are safe until step 1 is done.

## Installing

`scripts/install-connections-secrets.sh` prompts for each value and installs
it, skipping anything you leave blank, so it can be run repeatedly as values
turn up. Run it in your own terminal — never paste a secret into an agent
session or a shell that logs history.

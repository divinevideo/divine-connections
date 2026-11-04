# Crossposter secrets: what the worker reads and where each comes from

This repo deploys onto the Cloudflare worker named `divine-crossposter`, so it
uses the secrets attached to that worker name (the header of `wrangler.toml`
explains why). This file lists every secret the code reads and where its value
comes from. It does not record which ones are installed today; run
`npx wrangler secret list` for that.

Identity verification, and any secret it needs, is not part of this worker for
now. It runs in the verifier service at `verifier.divine.video`
(`divinevideo/divine-identify-verification-service`); see
divinevideo/divine-connections#2.

## Inventory

| secret | needed for | where the value comes from |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | **all** OAuth connections and crossposting | the key already installed on the worker, if there is one; it cannot be read back. See below |
| `TWITTER_CLIENT_ID` / `_SECRET` | connecting X | X developer portal, the OAuth 2.0 app |
| `INSTAGRAM_CLIENT_SECRET` | connecting Instagram | Meta app dashboard (the Instagram business login product, app id `1495112838545237`, already set as a var) |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | Meta's webhook subscription check on `/webhooks/instagram` | a value you choose and also enter in the Meta webhook settings |
| `TIKTOK_CLIENT_KEY` / `_SECRET` | connecting TikTok | TikTok developer portal, Login Kit |
| `GOOGLE_CLIENT_ID` / `_SECRET` | connecting YouTube | Google Cloud console, a web application OAuth client |
| `OPS_ALERT_WEBHOOK_URL` | watchdog alerts; the CI deploy refuses to run without it | the ops alert receiver |
| `OPS_OPERATOR_PUBKEYS` | the operator view at `/operations`; the CI deploy refuses to run without it | comma-separated 64-character hex pubkeys of the operators |

`OAUTH_REDIRECT_BASE` and `INSTAGRAM_CLIENT_ID` are plain vars in
`wrangler.toml`, not secrets. A provider shows as enabled only when its
`ENABLE_*` var is `true` and its credentials are set.

## Cloudflare secrets cannot be copied

They are write-only. No API reads a secret back, so no script can move one
from worker to worker. Every value has to come from its source or from
wherever it was saved.

## `TOKEN_ENCRYPTION_KEY` needs care

It is not derivable, and once installed it cannot be read back. The
`connections` table in D1 (`divine-crossposter`) stores
`encrypted_access_token` and `encrypted_refresh_token`, and this key decrypts
them.

- **Keep it.** Leave it alone when installing other secrets; the install script
  skips any value you leave blank.
- **If it is ever replaced**, every existing connection must be re-linked,
  because the stored tokens can no longer be decrypted.

Generating a key, only when one is truly needed:

```bash
openssl rand -base64 48
```

A mismatched key does **not** fail at deploy time. It fails later, at token
refresh, and reads like the platform revoked access.

## Installing

`scripts/install-connections-secrets.sh` prompts for `TOKEN_ENCRYPTION_KEY`
and the X, Instagram and TikTok secrets and installs each one, skipping
anything you leave blank, so it can be run repeatedly as values turn up.
Install the others with `npx wrangler secret put <NAME>`. Run either in your
own terminal, and never paste a secret into an agent session or a shell that
logs history.

After installing, check `https://crossposter.divine.video/platforms`: each
provider reports whether its flag and credentials are both set.

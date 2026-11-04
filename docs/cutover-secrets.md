# Preserve existing credentials during provider setup

The merged source targets the historical Worker `divine-crossposter`. Its
existing `TOKEN_ENCRYPTION_KEY`, encrypted connections, shared D1 and existing
Instagram/X credentials must be preserved. The former cross-worker secret-copy
and key-replacement instructions are obsolete. Cloudflare secrets are write-only;
there is no safe script that reads and copies them from another Worker.

For YouTube, TikTok or Snapchat, follow [provider setup and activation gates](provider-rollout.md).
Use `scripts/install-publishing-secrets.sh` for exactly one selected complete
OAuth pair. Do not use the old broad `scripts/install-connections-secrets.sh`
for this work: it requests unrelated secrets and reflects the former cutover.
Never generate or replace the production encryption key as part of provider setup.

An API key does not authorize YouTube publishing. OAuth client configuration,
provider approvals, callbacks and an authorized real acceptance test remain
external owner dependencies. Installing credentials neither enables a provider
nor authorizes a deployment or live post. The legacy verifier hostname cutover
is separate and must preserve its own verification dependencies.

A controlled acceptance deployment, if later authorized, needs a separate
Worker/host, separate D1, separate test key and registered provider callbacks.
Two Workers with different encryption keys must never share production D1.

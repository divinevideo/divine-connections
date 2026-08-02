# End-to-end suite

These tests talk to a **real deployment over the real network**, and that
deployment talks to the **real platform APIs**. Nothing here is stubbed. The
in-worker suite (`npm run test:once`) already covers logic against miniflare
with upstream HTTP stubbed at the `fetch` boundary; this suite exists to answer
a different question — *does the thing we actually shipped work?*

```bash
npm run test:e2e                                    # against the workers.dev deployment
E2E_BASE_URL=http://localhost:8787 npm run test:e2e # against `npm run dev`
```

## What it covers without any setup

- **Reachability** — `/health`, `/`, and JSON content negotiation.
- **Cache correctness** — the landing page revalidates and answers `304`, so a
  tester cannot silently run last week's build.
- **Capability drift** — `/platforms` reports what this deployment can *actually*
  do, which depends on the secrets installed on it rather than on the code. This
  is where "we shipped the feature but never installed the token" shows up.
- **Forgery refusal** — real calls to GitHub proving that a gist owned by
  someone else, or one without the claimant's npub, is refused. Plus the
  regression net for the Discord invite forgery (#20).
- **Input rejection** — malformed pubkeys, unknown platforms, injection-shaped
  identities, oversized batches.
- **No write-on-failure** — after every refused claim above, the badge API still
  reports nothing for that pubkey.

## The happy path needs a real proof post

`verify-proof.e2e.ts` verifies that a genuine proof post produces a genuine
stored verification. That requires content that a real account holder published
containing their own npub — the exact human step the product asks users to take.
It cannot be manufactured from inside a test without testing our own stub, so
those tests skip unless you supply the fixture.

Create it once (a secret gist is unlisted, but the API reads it the same way):

```bash
NPUB=<your npub>            # the npub for the pubkey below
echo "Verifying my Nostr identity: $NPUB" > proof.txt
gh gist create --desc "Nostr identity proof" proof.txt
# note the gist id from the returned URL
```

Then run:

```bash
export E2E_PROOF_PUBKEY=<64-char hex pubkey matching that npub>
export E2E_PROOF_GITHUB_USER=<the github login that owns the gist>
export E2E_PROOF_GITHUB_GIST=<gist id>
npm run test:e2e
```

## This writes to production

The worker binds the live `divine-crossposter` D1 database and there is no
staging environment (see issue #2). A successful run of the happy path stores a
**real verification** for the pubkey and GitHub account you supply, and there is
no user-facing revoke yet (issue #4).

Use your own account and your own key. The refusal tests are safe by
construction — they only assert that nothing was stored, and they use a pubkey
that belongs to nobody.

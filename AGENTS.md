# Repository Guidelines

Agent on duty: **GRAVE DIGGER**. Human in charge: **Big Rabble** (a.k.a. Rabble).

## Divine Context And Brain

Before broad product, architecture, protocol, cross-repo, service-boundary, or pull-request authoring, review, or modification work, read the shared Divine context primer.

Resolve the context directory and clone it there if it is missing:

```bash
CONTEXT_DIR="${DIVINE_CONTEXT_ROOT:-../divine-context}"
[ -e "$CONTEXT_DIR/.git" ] || gh repo clone divinevideo/divine-context "$CONTEXT_DIR"
```

Use that value as `<context-dir>` below.

The `divine-context` repo is private, so cloning requires GitHub access. If clone, network, or auth fails, continue from the local repo docs and avoid cross-repo assumptions.

Before updating an existing context checkout, verify it is clean and on its default branch. If it is clean and on the default branch, update it with `git -C <context-dir> pull --ff-only`. If it is dirty, on another branch, cannot fast-forward, or network/auth fails, leave it untouched and say the context may be stale.

Read `<context-dir>/AGENT_CONTEXT.md` and follow its instructions. If unavailable, continue from the local repo docs and avoid cross-repo assumptions.

Before working on a pull request, follow `<context-dir>/PR_REVIEW.md` and use `<context-dir>/PR_REVIEW_TEAMS.md` to request the normal team and check takeover authority. Ordinary review remains open to any eligible Divine human. Before modifying a pull-request branch, enforce the mapping and every takeover gate; if the mapping cannot be read, feedback-only review may continue but automated takeover must stop. Request and verify required human review automatically when tooling permits. If the runbook is unavailable, leave the pull request open and report the blocker.

If a Divine Brain search or ask tool is available, you may use it for company memory. Treat it as optional and credentialed: tool names vary by client, and work must continue when Brain is unavailable. When Brain results influence work, cite the returned document ids. Never commit Brain credentials or expose Brain-derived sensitive content in public PRs, issues, branch names, commit messages, code comments, logs, screenshots, release notes, or externally shared agent transcripts.

## What This Service Is

One Cloudflare Worker owning Divine users' relationships to external platform accounts: OAuth connection, identity verification (badges), and opt-in video crossposting. Design and implementation plan live in `docs/plans/`.

- `verifier.divine.video` → public verification API + self-service landing page
- `crossposter.divine.video` → publishing API

Host-based dispatch in `src/index.ts` separates the two surfaces; publishing paths (jobs, preferences, webhooks) must never be reachable from the verifier host.

## Project Structure & Module Organization

- Worker source and co-located tests live in `src/`: `platforms/` (OAuth+publish adapters), `verify/` (stateless proof-post verifiers), `services/` (state machines), `routes/` (Hono routers), `db/` (D1 access), `utils/`.
- D1 migrations in `migrations/`. The D1 binding is shared with the legacy crossposter worker — never drop or alter existing tables.
- Product and rollout context lives in `docs/plans/` and `README.md`.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run dev`: start the worker locally with Wrangler.
- `npm test`: interactive Vitest suite; `npm run test:once`: CI mode.
- `npm run typecheck`: `tsc --noEmit`.
- Deploys run through CI on merge to `main` (see `.github/workflows/ci-deploy.yml`); `npm run deploy` is for non-production only.

## Coding Style & Naming Conventions

- TypeScript throughout, Hono 4 routers, explicit request/response/error shapes.
- Tests run in the real workerd pool (`@cloudflare/vitest-pool-workers`) with real miniflare D1/KV. Stub upstream provider HTTP at the `fetch` boundary only; never mock internal modules.
- All code files start with a 2-line `ABOUTME: ` comment.
- Keep PRs tightly scoped. Temporary or transitional code must include `TODO(#issue):` with the tracking issue.

## Pull Request Guardrails

- PR titles must use Conventional Commit format: `type(scope): summary` or `type: summary`.
- Set the correct PR title when opening the PR. Do not rely on fixing it afterward.
- PR descriptions must include a short summary, motivation, linked issue, and manual test plan.
- Behavior changes to verification or publishing logic should include representative request or response examples when that helps reviewers validate the change.

## Security & Sensitive Information

- Do not commit secrets, API tokens, platform credentials, or private user data. Use Wrangler secrets for anything sensitive.
- Publish tokens are only touched by authenticated `/connections/*` routes and the publisher/queue paths. Public verify/lookup routes read only the `verifications` projection — never `connections` token columns.
- Public issues, PRs, branch names, screenshots, and descriptions must not mention corporate partners, customers, brands, campaign names, or other sensitive external identities unless a maintainer explicitly approves it. Use generic descriptors instead.

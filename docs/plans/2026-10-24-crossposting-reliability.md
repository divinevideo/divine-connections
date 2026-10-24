# Crossposting reliability

Approved scope: durable explanations for connection and publishing failures, an authenticated operations view, observed provider health, automatic alerts, safe recovery, and one deployment owner. No new opt-in or publishing authorization is implied.

## Design

Add a sidecar diagnostics table; preserve shared legacy tables. Keep a support reference, operation, stage, outcome, timestamp, release, and allowlisted provider diagnostics for 30 days. Store no tokens, authorization codes, raw response bodies, email addresses, IP addresses, or user identifiers in diagnostics. Ownership checks join existing attempt/job records. Capture the callback URI and non-secret client ID in OAuth state metadata at start, reuse the callback, and fail explicitly when client configuration changes.

The operations API requires an authenticated pubkey on an explicit operator allowlist. The HTML operations shell contains no data; it fetches the protected API using a supplied session token held only in memory. Public health exposes only aggregate status, not attempt identifiers or provider error messages. Provider health reflects recent completed attempts; abandonment is excluded, silence is unknown, and configured is distinct from healthy.

The scheduled worker detects repeated OAuth failures and publishing problems without a live log session. Persist alert delivery state and cooldown; failed delivery remains retryable. Keep the existing dispatch fence and ambiguity checks: never replay an uncertain external publish. Persist diagnostics at provider boundaries without allowing diagnostic-storage failure after publishing to cause a duplicate.

CI must fail when deployment credentials or required notification configuration are missing. Record the commit in the health endpoint, verify it after deployment, and retire the legacy deploy workflow in a separate PR. Persistent Workers logs may be enabled only without invocation logs containing callback query strings. Actual OAuth success still requires a consenting test-account login; an HTTP health probe cannot prove it.

## Implementation and verification

1. Add durable diagnostic storage and redaction tests using real D1.
2. Integrate OAuth start/callback context, publish failure records, support references.
3. Add protected operations API/page, public provider health, health-driven alerts and retention.
4. Test ownership boundaries, redaction, config drift, alert failure/retry/cooldown, and dispatch safety.
5. Add deployment provenance and fail-closed CI; retire legacy production deploy.
6. Run typecheck and full suite, independently review, commit/push/open PRs and inspect checks.

Deployment requires the normal platform review and merge workflow. Operator allowlist, alert webhook, deployment credential availability, and a controlled test-account acceptance check are rollout prerequisites; do not claim production is repaired from local tests.

## Operator runbook

- Configure `OPS_OPERATOR_PUBKEYS` with comma-separated full hexadecimal operator public keys. Empty or malformed entries grant no access. Use existing NIP-98 or Keycast authentication for `/operations/data`; the hosted `/operations` page accepts an operator session token without saving it.
- Configure the Worker's `OPS_ALERT_WEBHOOK_URL`; its recipient must accept JSON POSTs. The worker persists last successful and failed deliveries and sends no user identifiers or provider messages in alerts. Repeated provider incidents have a one-hour cooldown; failed delivery is retried on the next scheduled run. Existing queue alerts retain their existing delivery behavior.
- Visit `/operations`, inspect configuration, per-provider connection/publishing state, recent failures, and alert delivery timestamps. Filter by the support reference returned from a failed callback. `/support/:reference` is authenticated and owner-scoped, returning stages rather than private provider messages.
- Provider health covers the last 24 hours. At least three distinct failed operations, exceeding successful operations, means degraded. One success with fewer than three failures is observed healthy, not a guarantee. No completed observations means unknown. Denials and abandoned authorizations do not count as provider failures. A successful retry resolves that job's earlier failure for the health calculation.
- Diagnose Instagram by looking at `stage`, `diagnostic.endpoint` (`code_exchange` versus `long_lived_exchange`), provider code/subcode, and redacted message. The `authorization_started` record includes the exact callback and public client ID. Inspect the corresponding Meta application registration if the provider reports a mismatch; never rotate or guess credentials to silence an error.
- Before rollout, ensure Connections CI has deployment account/token credentials, configure the operator allowlist and alert recipient, and retire the legacy deployment workflow. Apply migration 0008 before the new Worker. Recent historical outcomes are imported, but missing provider details cannot be recovered.
- After merge/deploy, verify the release SHA on both public hosts, operator authorization, a failed synthetic callback's durable record, and a one-shot alert delivery. Use a consenting professional Instagram test account to complete authorization and explicitly authorized test publishing. Do not treat a health response as evidence that OAuth or publishing works.
- Rollback can redeploy the previous Connections release; the new sidecar tables are additive. Never restore the retired repository as deployment owner. Keep diagnostics for 30 days; scheduled cleanup removes older rows.

## External documentation

Workers Logs supports disabling invocation logs while retaining application logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/. This avoids automatic callback URL logging. Durable D1 diagnostics remain the operator source of truth.

The external `Production health` workflow runs every 15 minutes and checks both deployed releases, readiness, and observed provider degradation. `/readiness` fails when the scheduler has not completed successfully within five minutes, the database cannot be read, or required alert/operator configuration is absent. This is separate from the liveness endpoint and does not prove an external provider login succeeds. GitHub scheduling/delivery can itself be delayed; its run history is the independent evidence source.

Runtime operations configuration must be installed as Worker secrets named `OPS_ALERT_WEBHOOK_URL` and `OPS_OPERATOR_PUBKEYS` for the deployment preflight. The GitHub notification webhook is a separate repository/environment secret. Deployment deliberately fails before migrations if these prerequisites are absent. Reconnect-required connections alert independently of token expiry; provider health also records jobs stopped for reauthorization.

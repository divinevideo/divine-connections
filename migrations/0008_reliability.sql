-- Durable, bounded diagnostics separate from legacy shared tables.
CREATE TABLE operation_diagnostics (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  platform TEXT NOT NULL,
  operation TEXT NOT NULL,
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL,
  provider_status INTEGER,
  diagnostic_json TEXT NOT NULL,
  release TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX diagnostics_recent ON operation_diagnostics(created_at);
CREATE INDEX diagnostics_reference ON operation_diagnostics(reference, created_at);
CREATE TABLE reliability_alerts (
  alert_key TEXT PRIMARY KEY,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_delivered_at INTEGER,
  last_error_at INTEGER
);

-- Preserve recent known outcomes, explicitly marking missing historical details.
INSERT INTO operation_diagnostics
 SELECT 'legacy-oauth:' || id,id,platform,'connect',status,
 CASE WHEN status='connected' THEN 'succeeded' ELSE 'failed' END,
 provider_status,'{"note":"Historical provider details were not retained"}','unknown',updated_at
 FROM oauth_attempts WHERE updated_at >= unixepoch()-2592000
 AND status IN ('connected','token_exchange_failed','account_lookup_failed','callback_failed','storage_failed');
INSERT INTO operation_diagnostics
 SELECT 'legacy-job:' || id,id,platform,'publish',status,
 CASE WHEN status='posted' THEN 'succeeded' ELSE 'failed' END,
 NULL,'{"note":"Historical provider details were not retained"}','unknown',updated_at
 FROM jobs WHERE updated_at >= unixepoch()-2592000 AND status IN ('posted','failed','needs_reauth');
CREATE TABLE reliability_monitor (
  id INTEGER PRIMARY KEY CHECK(id=1),
  checked_at INTEGER NOT NULL
);

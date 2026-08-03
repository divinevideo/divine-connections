-- Connections made before the connection-to-verification write existed never
-- produced a verification row. A live, connected OAuth account already proves
-- the person controls it (that is the whole point of Quick Connect), so the
-- verifier was asking people to publish a proof post for an account this same
-- service had already verified.
--
-- Mirrors verificationIdentityForConnection(): YouTube proves the channel id,
-- every other provider proves the human handle stored as the account name.
-- Mirrors verificationIdentityKey(): lowercased except for YouTube, whose
-- channel ids are case-sensitive.
--
-- INSERT OR IGNORE against the unique index on (pubkey, platform, identity_key)
-- makes this safe to re-run, and stops it clobbering a verification the user
-- has since established by other means.
--
-- ASCII only: the test harness passes migration text through a ByteString
-- conversion that rejects characters above 255.
INSERT OR IGNORE INTO verifications (
  pubkey, platform, identity, identity_key, method, proof_url, connection_id, verified_at, revoked_at
)
SELECT
  c.pubkey,
  c.platform,
  CASE WHEN c.platform = 'youtube' THEN c.external_account_id ELSE c.external_account_name END,
  CASE WHEN c.platform = 'youtube' THEN c.external_account_id ELSE lower(c.external_account_name) END,
  'oauth',
  NULL,
  c.id,
  c.created_at,
  NULL
FROM connections c
WHERE c.status = 'connected'
  AND CASE WHEN c.platform = 'youtube' THEN c.external_account_id ELSE c.external_account_name END IS NOT NULL
  AND trim(CASE WHEN c.platform = 'youtube' THEN c.external_account_id ELSE c.external_account_name END) <> '';

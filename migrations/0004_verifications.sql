-- ABOUTME: Durable store of verified pubkey<->platform-identity proofs (badge reads).
-- ABOUTME: Written atomically from the OAuth callback batch, the disconnect batch,
-- and proof-post verify success; revoked only on explicit disconnect.
CREATE TABLE verifications (
  pubkey TEXT NOT NULL,          -- 64-hex Divine pubkey
  platform TEXT NOT NULL,        -- x | instagram | tiktok | youtube | bluesky |
                                 -- github | mastodon | telegram | discord
  identity TEXT NOT NULL,        -- handle / username / channel id
  method TEXT NOT NULL,          -- 'oauth' | 'proof-post'
  proof_url TEXT,                -- proof post URL when method = 'proof-post'
  connection_id TEXT,            -- connections.id when method = 'oauth'
  verified_at INTEGER NOT NULL,
  revoked_at INTEGER,            -- set on explicit disconnect only
  PRIMARY KEY (pubkey, platform, identity)
);
CREATE INDEX idx_verifications_pubkey ON verifications(pubkey, revoked_at);
CREATE INDEX idx_verifications_identity ON verifications(platform, identity, revoked_at);

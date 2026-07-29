-- ABOUTME: Adds identity_key, the normalized match key for verification identities,
-- ABOUTME: so writes dedupe on exactly the same value that reads match on.
--
-- 0004 gave the table a case-sensitive primary key on (pubkey, platform, identity)
-- while the read helpers matched with COLLATE NOCASE. That split meant 'Alice' and
-- 'alice' stored two rows but read back as one arbitrary row, and a case-insensitive
-- reverse lookup could resolve a YouTube channel id to a different channel's pubkey.
--
-- identity_key is lower(identity) for handle platforms and the verbatim identity for
-- youtube, whose channel ids (UC…) are case-significant. identity keeps its original
-- casing for display.

ALTER TABLE verifications ADD COLUMN identity_key TEXT NOT NULL DEFAULT '';

UPDATE verifications
SET identity_key = CASE WHEN platform = 'youtube' THEN identity ELSE lower(identity) END;

-- Collapse any case-variant duplicates 0004 allowed, newest insert wins, so the
-- unique index below can be created. A no-op on a table with no such duplicates.
DELETE FROM verifications
WHERE rowid NOT IN (SELECT max(rowid) FROM verifications GROUP BY pubkey, platform, identity_key);

CREATE UNIQUE INDEX idx_verifications_identity_key
  ON verifications(pubkey, platform, identity_key);

CREATE INDEX idx_verifications_reverse_key
  ON verifications(platform, identity_key, revoked_at);

-- Replaced by idx_verifications_reverse_key; no reader matches on raw identity.
DROP INDEX IF EXISTS idx_verifications_identity;

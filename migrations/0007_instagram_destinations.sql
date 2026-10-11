-- ABOUTME: Stores creator-selected Instagram formats without altering shared tables.
-- ABOUTME: Job choices are immutable snapshots; absent rows retain legacy behavior.
CREATE TABLE instagram_preferences (
  pubkey TEXT PRIMARY KEY,
  destination TEXT NOT NULL CHECK (destination IN ('story', 'reel', 'reel_feed')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE instagram_job_options (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('story', 'reel', 'reel_feed'))
);

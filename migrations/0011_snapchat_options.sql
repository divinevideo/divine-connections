-- Snapchat preferences and immutable source eligibility snapshots, additive only.
CREATE TABLE snapchat_preferences (
  pubkey TEXT PRIMARY KEY,
  destination TEXT NOT NULL CHECK(destination IN ('spotlight', 'story')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE snapchat_job_options (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  destination TEXT NOT NULL CHECK(destination IN ('spotlight', 'story')),
  source_media_json TEXT NOT NULL
);

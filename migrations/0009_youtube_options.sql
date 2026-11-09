-- ABOUTME: Stores YouTube visibility defaults and immutable upload options additively.
-- ABOUTME: Absent rows preserve configured behavior for historical jobs.
CREATE TABLE youtube_preferences (
  pubkey TEXT PRIMARY KEY,
  privacy_status TEXT NOT NULL CHECK (privacy_status IN ('private', 'unlisted', 'public')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE youtube_job_options (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  privacy_status TEXT NOT NULL CHECK (privacy_status IN ('private', 'unlisted', 'public')),
  title TEXT
);

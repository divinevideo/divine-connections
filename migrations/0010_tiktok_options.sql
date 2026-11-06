-- Immutable, explicitly confirmed manual TikTok options; shared legacy tables stay unchanged.
CREATE TABLE tiktok_job_options (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  options_json TEXT NOT NULL
);

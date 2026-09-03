CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  neurons_used INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings(key, value, encrypted) VALUES
  ('ai.enabled', 'false', 0),
  ('ai.model', '@cf/meta/llama-3.1-8b-instruct-fp8-fast', 0);

CREATE TABLE IF NOT EXISTS wechat_oauth_states (
  state TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  order_no TEXT NOT NULL REFERENCES orders(order_no) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wechat_oauth_expires ON wechat_oauth_states(expires_at);

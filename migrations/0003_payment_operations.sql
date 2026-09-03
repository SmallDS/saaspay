ALTER TABLE orders ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN alipay_last_checked_at TEXT;

CREATE TABLE IF NOT EXISTS payment_refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  reason TEXT NOT NULL DEFAULT '',
  out_request_no TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','success','failed')),
  alipay_refund_no TEXT,
  alipay_trade_no TEXT,
  response_code TEXT,
  response_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_order ON payment_refunds(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_status ON payment_refunds(status, updated_at DESC);
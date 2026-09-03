ALTER TABLE orders ADD COLUMN checkout_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_checkout_request_id
  ON orders(checkout_request_id)
  WHERE checkout_request_id IS NOT NULL;
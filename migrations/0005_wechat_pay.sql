ALTER TABLE orders ADD COLUMN payment_provider TEXT NOT NULL DEFAULT 'alipay';
ALTER TABLE orders ADD COLUMN transaction_id TEXT;
ALTER TABLE payment_refunds ADD COLUMN provider TEXT NOT NULL DEFAULT 'alipay';

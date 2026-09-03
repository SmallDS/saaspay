PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
  seo_title TEXT,
  seo_description TEXT,
  draft_json TEXT NOT NULL DEFAULT '{"content":[],"root":{}}',
  published_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(page_id, version)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  original_amount_cents INTEGER,
  billing_label TEXT NOT NULL DEFAULT '一次性',
  highlighted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','closed','refunded')),
  alipay_trade_no TEXT,
  buyer_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  paid_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_plan ON orders(plan_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  order_id TEXT,
  request_url TEXT NOT NULL,
  request_body TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_event ON webhook_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_created ON webhook_deliveries(created_at DESC);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  public_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings(key, value, encrypted) VALUES
  ('site.name', 'SaaS Store', 0),
  ('site.tagline', '简单、可靠的 SaaS 产品展示与购买系统', 0),
  ('site.primary_domain', '', 0),
  ('payment.alipay.enabled', 'false', 0),
  ('payment.alipay.app_id', '', 0),
  ('payment.alipay.gateway', 'https://openapi.alipay.com/gateway.do', 0),
  ('payment.alipay.seller_id', '', 0),
  ('webhook.enabled', 'false', 0),
  ('webhook.url', '', 0),
  ('webhook.events', '["order.paid","order.refunded"]', 0);

INSERT OR IGNORE INTO pages(id, title, slug, status, seo_title, seo_description, draft_json, published_json, published_at)
VALUES (
  'page_home',
  '首页',
  'home',
  'published',
  'SaaS Store',
  '展示产品、管理套餐并通过支付宝电脑网站支付完成购买',
  '{"content":[{"type":"Hero","props":{"id":"hero","eyebrow":"SaaS Product","title":"你的 SaaS，应该更容易被购买","description":"展示功能、管理套餐、支付宝收款，并在支付成功后通过 Webhook 联动业务系统。","buttonText":"查看套餐","buttonHref":"#pricing"}},{"type":"Features","props":{"id":"features","title":"核心能力","items":"可视化编辑展示页面\n产品与套餐统一管理\n支付宝电脑网站支付\n支付完成自动触发 Webhook"}},{"type":"Pricing","props":{"id":"pricing","title":"选择适合你的套餐","description":"价格来自后台统一配置，页面不重复保存金额。"}}],"root":{}}',
  '{"content":[{"type":"Hero","props":{"id":"hero","eyebrow":"SaaS Product","title":"你的 SaaS，应该更容易被购买","description":"展示功能、管理套餐、支付宝收款，并在支付成功后通过 Webhook 联动业务系统。","buttonText":"查看套餐","buttonHref":"#pricing"}},{"type":"Features","props":{"id":"features","title":"核心能力","items":"可视化编辑展示页面\n产品与套餐统一管理\n支付宝电脑网站支付\n支付完成自动触发 Webhook"}},{"type":"Pricing","props":{"id":"pricing","title":"选择适合你的套餐","description":"价格来自后台统一配置，页面不重复保存金额。"}}],"root":{}}',
  CURRENT_TIMESTAMP
);

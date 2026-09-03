ALTER TABLE pages ADD COLUMN seo_keywords TEXT NOT NULL DEFAULT '';
ALTER TABLE pages ADD COLUMN noindex INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page_versions ADD COLUMN seo_keywords TEXT;
ALTER TABLE page_versions ADD COLUMN noindex INTEGER;

INSERT OR IGNORE INTO settings(key, value, encrypted) VALUES
  ('site.seo', '{"keywords":"","default_og_image":"","robots_allow":true}', 0),
  ('site.legal', '{"icp_no":"","copyright":""}', 0),
  ('site.custom_code', '{"head_html":"","body_html":""}', 0);

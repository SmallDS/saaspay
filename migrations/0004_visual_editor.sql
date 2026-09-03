-- Visual editor settings, page metadata, and version snapshots
ALTER TABLE pages ADD COLUMN og_image TEXT;
ALTER TABLE page_versions ADD COLUMN title TEXT;
ALTER TABLE page_versions ADD COLUMN slug TEXT;
ALTER TABLE page_versions ADD COLUMN seo_title TEXT;
ALTER TABLE page_versions ADD COLUMN seo_description TEXT;
ALTER TABLE page_versions ADD COLUMN og_image TEXT;

INSERT OR IGNORE INTO settings(key, value, encrypted) VALUES
  ('site.theme', '{"primary_color":"#3159ca","accent_color":"#172033","surface_color":"#ffffff","page_background":"#f6f8fb","text_color":"#172033","muted_color":"#667085","font_family":"Inter, ui-sans-serif, system-ui, sans-serif","radius":"16px","container_width":"1120px"}', 0),
  ('site.header', '{"enabled":true,"show_nav":true,"links":[{"label":"套餐","href":"#pricing"},{"label":"管理后台","href":"/admin"}],"cta_text":"","cta_href":""}', 0),
  ('site.footer', '{"enabled":true,"tagline":"","links":[]}', 0);
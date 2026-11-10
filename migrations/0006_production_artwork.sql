CREATE TABLE designer_order_files_new (
  id TEXT PRIMARY KEY,
  order_item_id TEXT NOT NULL,
  asset_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('plan', 'preview', 'view-png', 'production-png', 'original-upload', 'summary-pdf', 'archive')),
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_item_id) REFERENCES designer_order_items(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES shop_assets(id) ON DELETE CASCADE
);
INSERT INTO designer_order_files_new SELECT * FROM designer_order_files;
DROP TABLE designer_order_files;
ALTER TABLE designer_order_files_new RENAME TO designer_order_files;
CREATE INDEX designer_order_files_item_id ON designer_order_files(order_item_id);

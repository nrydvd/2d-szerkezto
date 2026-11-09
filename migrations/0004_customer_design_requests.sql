CREATE TABLE designer_orders (
  id TEXT PRIMARY KEY,
  shopify_order_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE designer_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  shopify_line_item_id TEXT,
  shopify_product_id TEXT,
  shopify_variant_id TEXT,
  designer_product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  design_json TEXT NOT NULL CHECK (json_valid(design_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES designer_orders(id) ON DELETE CASCADE
);

CREATE TABLE designer_order_files (
  id TEXT PRIMARY KEY,
  order_item_id TEXT NOT NULL,
  asset_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('plan', 'preview', 'view-png', 'original-upload', 'summary-pdf', 'archive')),
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_item_id) REFERENCES designer_order_items(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES shop_assets(id) ON DELETE CASCADE
);

CREATE INDEX designer_order_items_order_id ON designer_order_items(order_id);
CREATE INDEX designer_order_files_item_id ON designer_order_files(order_item_id);

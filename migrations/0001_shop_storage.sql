CREATE TABLE IF NOT EXISTS shop_state (
  state_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shop_assets (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('public', 'admin', 'customer-artwork')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_upload_windows (
  ip_hash TEXT NOT NULL,
  hour_window TEXT NOT NULL,
  upload_count INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, hour_window)
);

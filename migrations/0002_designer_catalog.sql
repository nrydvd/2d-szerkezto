CREATE TABLE designer_products (
  product_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  configuration TEXT NOT NULL CHECK (json_valid(configuration)),
  shopify_product_gid TEXT,
  shopify_sync_status TEXT NOT NULL DEFAULT 'not_synced',
  shopify_last_synced_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE designer_materials (
  product_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_huf INTEGER NOT NULL,
  configuration TEXT NOT NULL CHECK (json_valid(configuration)),
  shopify_variant_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(shopify_variant_ids)),
  PRIMARY KEY (product_id, material_id),
  FOREIGN KEY (product_id) REFERENCES designer_products(product_id) ON DELETE CASCADE
);

CREATE TRIGGER designer_catalog_insert AFTER INSERT ON shop_state
WHEN NEW.state_key = 'designerProducts'
BEGIN
  DELETE FROM designer_materials;
  DELETE FROM designer_products;
  INSERT INTO designer_products (product_id, profile_id, slug, name, active, configuration, shopify_product_gid, shopify_sync_status, shopify_last_synced_at)
  SELECT json_extract(value, '$.profile.productId'), json_extract(value, '$.profile.id'),
    COALESCE(json_extract(value, '$.slug'), CASE json_extract(value, '$.profile.productId')
      WHEN 'womens-pouch' THEN 'noi-neszeszer' ELSE json_extract(value, '$.profile.productId') END),
    json_extract(value, '$.profile.name'), json_extract(value, '$.active'), value,
    json_extract(value, '$.shopify.productGid'), COALESCE(json_extract(value, '$.shopify.syncStatus'), 'not_synced'),
    json_extract(value, '$.shopify.lastSyncedAt')
  FROM json_each(NEW.payload);
  INSERT INTO designer_materials (product_id, material_id, name, price_huf, configuration, shopify_variant_ids)
  SELECT json_extract(p.value, '$.profile.productId'), json_extract(m.value, '$.id'),
    json_extract(m.value, '$.name'), json_extract(m.value, '$.priceHuf'), m.value,
    COALESCE(json_extract(m.value, '$.shopifyVariantIds'), '[]')
  FROM json_each(NEW.payload) p, json_each(p.value, '$.materials') m;
END;

CREATE TRIGGER designer_catalog_update AFTER UPDATE OF payload ON shop_state
WHEN NEW.state_key = 'designerProducts'
BEGIN
  DELETE FROM designer_materials;
  DELETE FROM designer_products;
  INSERT INTO designer_products (product_id, profile_id, slug, name, active, configuration, shopify_product_gid, shopify_sync_status, shopify_last_synced_at)
  SELECT json_extract(value, '$.profile.productId'), json_extract(value, '$.profile.id'),
    COALESCE(json_extract(value, '$.slug'), CASE json_extract(value, '$.profile.productId')
      WHEN 'womens-pouch' THEN 'noi-neszeszer' ELSE json_extract(value, '$.profile.productId') END),
    json_extract(value, '$.profile.name'), json_extract(value, '$.active'), value,
    json_extract(value, '$.shopify.productGid'), COALESCE(json_extract(value, '$.shopify.syncStatus'), 'not_synced'),
    json_extract(value, '$.shopify.lastSyncedAt')
  FROM json_each(NEW.payload);
  INSERT INTO designer_materials (product_id, material_id, name, price_huf, configuration, shopify_variant_ids)
  SELECT json_extract(p.value, '$.profile.productId'), json_extract(m.value, '$.id'),
    json_extract(m.value, '$.name'), json_extract(m.value, '$.priceHuf'), m.value,
    COALESCE(json_extract(m.value, '$.shopifyVariantIds'), '[]')
  FROM json_each(NEW.payload) p, json_each(p.value, '$.materials') m;
END;

CREATE TRIGGER designer_catalog_delete AFTER DELETE ON shop_state
WHEN OLD.state_key = 'designerProducts'
BEGIN
  DELETE FROM designer_materials;
  DELETE FROM designer_products;
END;

-- Re-index any previously persisted catalog without changing its JSON or revision.
UPDATE shop_state SET payload = payload WHERE state_key = 'designerProducts';

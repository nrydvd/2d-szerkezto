DROP TRIGGER designer_catalog_insert;
DROP TRIGGER designer_catalog_update;
DROP TRIGGER designer_catalog_delete;

ALTER TABLE designer_materials RENAME TO designer_materials_previous;

CREATE TABLE designer_materials (
  product_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_huf INTEGER,
  configuration TEXT NOT NULL CHECK (json_valid(configuration)),
  shopify_variant_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(shopify_variant_ids)),
  PRIMARY KEY (product_id, material_id),
  FOREIGN KEY (product_id) REFERENCES designer_products(product_id) ON DELETE CASCADE
);

INSERT INTO designer_materials (product_id, material_id, name, price_huf, configuration, shopify_variant_ids)
SELECT product_id, material_id, name, price_huf, configuration, shopify_variant_ids
FROM designer_materials_previous;

DROP TABLE designer_materials_previous;

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
    COALESCE(json_extract(value, '$.shopifyProductId'), json_extract(value, '$.shopify.productGid')),
    COALESCE(json_extract(value, '$.shopify.syncStatus'), 'not_synced'),
    json_extract(value, '$.shopify.lastSyncedAt')
  FROM json_each(NEW.payload);
  INSERT INTO designer_materials (product_id, material_id, name, price_huf, configuration, shopify_variant_ids)
  SELECT json_extract(p.value, '$.profile.productId'), json_extract(m.value, '$.id'),
    json_extract(m.value, '$.name'), json_extract(m.value, '$.priceHuf'), m.value,
    CASE WHEN json_extract(m.value, '$.shopifyVariantId') IS NOT NULL
      THEN json_array(json_extract(m.value, '$.shopifyVariantId'))
      ELSE COALESCE(json_extract(m.value, '$.shopifyVariantIds'), '[]') END
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
    COALESCE(json_extract(value, '$.shopifyProductId'), json_extract(value, '$.shopify.productGid')),
    COALESCE(json_extract(value, '$.shopify.syncStatus'), 'not_synced'),
    json_extract(value, '$.shopify.lastSyncedAt')
  FROM json_each(NEW.payload);
  INSERT INTO designer_materials (product_id, material_id, name, price_huf, configuration, shopify_variant_ids)
  SELECT json_extract(p.value, '$.profile.productId'), json_extract(m.value, '$.id'),
    json_extract(m.value, '$.name'), json_extract(m.value, '$.priceHuf'), m.value,
    CASE WHEN json_extract(m.value, '$.shopifyVariantId') IS NOT NULL
      THEN json_array(json_extract(m.value, '$.shopifyVariantId'))
      ELSE COALESCE(json_extract(m.value, '$.shopifyVariantIds'), '[]') END
  FROM json_each(NEW.payload) p, json_each(p.value, '$.materials') m;
END;

CREATE TRIGGER designer_catalog_delete AFTER DELETE ON shop_state
WHEN OLD.state_key = 'designerProducts'
BEGIN
  DELETE FROM designer_materials;
  DELETE FROM designer_products;
END;

-- Rebuild the index without changing the catalog JSON or stable identities.
UPDATE shop_state SET payload = payload WHERE state_key = 'designerProducts';

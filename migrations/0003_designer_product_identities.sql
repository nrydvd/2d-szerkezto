CREATE TABLE designer_product_identities (
  product_uuid TEXT PRIMARY KEY NOT NULL CHECK (
    length(product_uuid) = 36 AND
    product_uuid NOT GLOB '*[^0-9a-f-]*' AND
    substr(product_uuid, 9, 1) = '-' AND substr(product_uuid, 14, 1) = '-' AND
    substr(product_uuid, 19, 1) = '-' AND substr(product_uuid, 24, 1) = '-' AND
    length(replace(product_uuid, '-', '')) = 32 AND
    substr(product_uuid, 15, 1) = '4' AND substr(product_uuid, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  legacy_product_id TEXT NOT NULL UNIQUE CHECK (length(legacy_product_id) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO designer_product_identities (product_uuid, legacy_product_id)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))), product_id
FROM designer_products;

CREATE TRIGGER designer_product_identity_insert AFTER INSERT ON designer_products
WHEN NOT EXISTS (
  SELECT 1 FROM designer_product_identities WHERE legacy_product_id = NEW.product_id
)
BEGIN
  INSERT INTO designer_product_identities (product_uuid, legacy_product_id)
  VALUES (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2, 3) || '-' ||
    hex(randomblob(6))), NEW.product_id);
END;

CREATE TRIGGER designer_product_identity_no_update BEFORE UPDATE ON designer_product_identities
BEGIN
  SELECT RAISE(ABORT, 'Designer product identities cannot be changed');
END;

CREATE TRIGGER designer_product_identity_no_replace BEFORE INSERT ON designer_product_identities
WHEN EXISTS (
  SELECT 1 FROM designer_product_identities
  WHERE product_uuid = NEW.product_uuid OR legacy_product_id = NEW.legacy_product_id
)
BEGIN
  SELECT RAISE(ABORT, 'Designer product identities cannot be replaced');
END;

CREATE TRIGGER designer_product_identity_no_delete BEFORE DELETE ON designer_product_identities
BEGIN
  SELECT RAISE(ABORT, 'Designer product identities cannot be deleted');
END;

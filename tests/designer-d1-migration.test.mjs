import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pouchProfile } from "../src/designer-prototype/profile.ts";
import { MATERIALS } from "../src/designer-prototype/materials.ts";
import { validateDesignerCatalog } from "../functions/_shared/designer-catalog.js";

const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const products = () => [{
  profile: structuredClone(pouchProfile),
  active: true,
  materials: MATERIALS.map((item, index) => ({ ...structuredClone(item), priceHuf: index ? 5990 : 5490 })),
}];

test("D1 migration preserves existing catalog and transactionally indexes updates", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migration("0001_shop_storage.sql"));
    const original = JSON.stringify(products());
    db.prepare("INSERT INTO shop_state (state_key, payload) VALUES (?, ?)").run("designerProducts", original);
    db.exec(migration("0002_designer_catalog.sql"));
    assert.equal(db.prepare("SELECT payload FROM shop_state").get().payload, original);
    assert.deepEqual({ ...db.prepare("SELECT product_id, slug, active FROM designer_products").get() },
      { product_id: "womens-pouch", slug: "noi-neszeszer", active: 1 });
    assert.deepEqual(db.prepare("SELECT price_huf FROM designer_materials ORDER BY price_huf").all().map((row) => row.price_huf), [5490, 5990]);
    const changed = products();
    const draft = structuredClone(changed[0]);
    draft.profile.id = "new-profile";
    draft.profile.productId = "new-product";
    draft.slug = "uj-termek";
    draft.active = false;
    draft.materials.forEach((material) => { material.layoutId = draft.profile.id; });
    changed.push(draft);
    assert.equal(validateDesignerCatalog(changed), null);
    const payload = JSON.stringify(changed);
    assert.equal(db.prepare("UPDATE shop_state SET payload = ? WHERE state_key = ? AND payload = ?").run(payload, "designerProducts", original).changes, 1);
    assert.equal(db.prepare("UPDATE shop_state SET payload = ? WHERE state_key = ? AND payload = ?").run(original, "designerProducts", original).changes, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM designer_products").get().count, 2);
    assert.throws(() => db.prepare("UPDATE shop_state SET payload = ? WHERE state_key = ?").run(JSON.stringify([changed[0], changed[0]]), "designerProducts"));
    assert.equal(db.prepare("SELECT payload FROM shop_state").get().payload, payload);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM designer_products").get().count, 2);
  } finally { db.close(); }
});

test("product identity migration preserves legacy catalogs and assigns durable UUIDs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(migration("0001_shop_storage.sql"));
    db.exec(migration("0002_designer_catalog.sql"));
    const original = JSON.stringify(products());
    db.prepare("INSERT INTO shop_state (state_key, payload) VALUES (?, ?)").run("designerProducts", original);
    db.exec(migration("0003_designer_product_identities.sql"));

    const lookup = (id) => db.prepare(
      "SELECT product_uuid, legacy_product_id, created_at FROM designer_product_identities WHERE legacy_product_id = ?",
    ).get(id);
    const first = lookup("womens-pouch");
    assert.match(first.product_uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(first.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(db.prepare("SELECT payload FROM shop_state WHERE state_key = 'designerProducts'").get().payload, original);
    assert.deepEqual(db.prepare("SELECT price_huf FROM designer_materials ORDER BY price_huf").all().map((row) => row.price_huf), [5490, 5990]);

    const changed = products();
    changed[0].profile.name = "Átnevezett termék";
    changed[0].materials[0].priceHuf = 7000;
    const second = structuredClone(changed[0]);
    second.profile.productId = "new-product";
    second.profile.id = "new-profile";
    second.slug = "new-product";
    second.materials.forEach((material) => { material.layoutId = second.profile.id; });
    changed.push(second);
    db.prepare("UPDATE shop_state SET payload = ? WHERE state_key = ?").run(JSON.stringify(changed), "designerProducts");
    assert.equal(lookup("womens-pouch").product_uuid, first.product_uuid);
    const secondIdentity = lookup("new-product");
    assert.match(secondIdentity.product_uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(secondIdentity.product_uuid, first.product_uuid);

    assert.throws(() => db.prepare("UPDATE designer_product_identities SET product_uuid = ? WHERE legacy_product_id = ?")
      .run(secondIdentity.product_uuid, "womens-pouch"), /cannot be changed/);
    assert.throws(() => db.prepare("DELETE FROM designer_product_identities WHERE legacy_product_id = ?")
      .run("womens-pouch"), /cannot be deleted/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO designer_product_identities (product_uuid, legacy_product_id) VALUES (?, ?)")
      .run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "womens-pouch"), /cannot be replaced/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO designer_product_identities (product_uuid, legacy_product_id) VALUES (?, ?)")
      .run(first.product_uuid, "different-product"), /cannot be replaced/);
    assert.throws(() => db.prepare("INSERT INTO designer_product_identities (product_uuid, legacy_product_id) VALUES (?, ?)")
      .run("not-a-uuid", "invalid"), /CHECK constraint/);

    db.prepare("UPDATE shop_state SET payload = ? WHERE state_key = ?").run(JSON.stringify([second]), "designerProducts");
    assert.equal(lookup("womens-pouch").product_uuid, first.product_uuid);
    db.prepare("UPDATE shop_state SET payload = ? WHERE state_key = ?").run(JSON.stringify(changed), "designerProducts");
    assert.equal(lookup("womens-pouch").product_uuid, first.product_uuid);
    assert.equal(lookup("new-product").product_uuid, secondIdentity.product_uuid);
    const beforeInvalid = db.prepare("SELECT payload FROM shop_state WHERE state_key = 'designerProducts'").get().payload;
    assert.throws(() => db.prepare("UPDATE shop_state SET payload = ? WHERE state_key = ?")
      .run(JSON.stringify([changed[0], changed[0]]), "designerProducts"));
    assert.equal(db.prepare("SELECT payload FROM shop_state WHERE state_key = 'designerProducts'").get().payload, beforeInvalid);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM designer_product_identities").get().count, 2);
  } finally { db.close(); }
});

test("identity migration supports an initially empty catalog and its first save", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migration("0001_shop_storage.sql"));
    db.exec(migration("0002_designer_catalog.sql"));
    db.exec(migration("0003_designer_product_identities.sql"));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM designer_product_identities").get().count, 0);
    db.prepare("INSERT OR IGNORE INTO shop_state (state_key, payload) VALUES (?, ?)")
      .run("designerProducts", JSON.stringify(products()));
    assert.match(db.prepare("SELECT product_uuid FROM designer_product_identities WHERE legacy_product_id = ?")
      .get("womens-pouch").product_uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { db.close(); }
});

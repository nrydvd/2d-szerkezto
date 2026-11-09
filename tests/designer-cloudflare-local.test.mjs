import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { onRequestGet as publicGet } from "../functions/api/designer-products.js";
import { onRequestGet as adminGet, onRequestPut as adminPut } from "../functions/api/admin/designer-products.js";
import { onRequestPost as uploadAsset } from "../functions/api/admin/assets.js";
import { onRequestDelete as deleteAsset, onRequestGet as getAsset } from "../functions/api/assets/[assetId].js";
import { onRequestGet as listRequests, onRequestPost as createRequest } from "../functions/api/designer-requests.js";
import { onRequestGet as getRequestFile } from "../functions/api/admin/designer-requests/files/[fileId].js";
import { pouchProfile } from "../src/designer-prototype/profile.ts";
import { MATERIALS } from "../src/designer-prototype/materials.ts";

test("authenticated admin saves products and uploads through real local D1 and R2", async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-11-06", d1Databases: ["SHOP_DB"], r2Buckets: ["SHOP_ASSETS"],
  }));
  const originalFetch = globalThis.fetch;
  try {
    const db = await runtime.getD1Database("SHOP_DB");
    const bucket = await runtime.getR2Bucket("SHOP_ASSETS");
    for (const name of ["0001_shop_storage.sql", "0002_designer_catalog.sql", "0004_customer_design_requests.sql"]) {
      const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replace(/^--.*$/gm, "");
      const statements = sql.match(/CREATE TRIGGER[\s\S]*?\nEND;|CREATE TABLE[\s\S]*?\n\);|CREATE INDEX[^;]*;|UPDATE shop_state[^;]*;/g);
      assert.ok(statements?.length);
      for (const statement of statements) await db.prepare(statement).run();
    }
    const keypair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...await crypto.subtle.exportKey("jwk", keypair.publicKey), kid: "local-key", alg: "RS256" };
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", kid: "local-key" })}.${encode({ iss: "https://local-test.example", aud: ["local-audience"], exp: Date.now() / 1000 + 300 })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keypair.privateKey, new TextEncoder().encode(unsigned));
    const token = `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
    globalThis.fetch = async (url, ...rest) => String(url) === "https://local-test.example/cdn-cgi/access/certs"
      ? Response.json({ keys: [jwk] }) : originalFetch(url, ...rest);
    const env = { SHOP_DB: db, SHOP_ASSETS: bucket, CF_ACCESS_TEAM_DOMAIN: "local-test.example", CF_ACCESS_AUD: "local-audience" };
    const headers = { Origin: "https://shop.example", "Cf-Access-Jwt-Assertion": token };
    const adminUrl = "https://shop.example/api/admin/designer-products";
    assert.equal((await adminGet({ request: new Request(adminUrl), env })).status, 401);
    const imageBytes = readFileSync(new URL("../public/images/masks/noi-neszeszer/fabric-color-mask.png", import.meta.url));
    const form = new FormData();
    form.set("file", new File([imageBytes], "mask.png", { type: "image/png" }));
    const upload = await uploadAsset({ request: new Request("https://shop.example/api/admin/assets", { method: "POST", headers, body: form }), env });
    assert.equal(upload.status, 200);
    const assetId = (await upload.json()).id;
    const returned = await getAsset({ request: new Request(`https://shop.example/api/assets/${assetId}`), env, params: { assetId } });
    assert.equal(returned.status, 200);
    assert.deepEqual(Buffer.from(await returned.arrayBuffer()), imageBytes);
    const product = { profile: structuredClone(pouchProfile), active: true, materials: MATERIALS.map((m, i) => ({ ...structuredClone(m), priceHuf: i ? 5990 : 5490 })) };
    const second = structuredClone(product);
    second.profile.id = "test-profile";
    second.profile.productId = "test-product";
    second.profile.name = "Teszttermék";
    second.slug = "teszttermek";
    second.profile.fabricMask = `/api/assets/${assetId}`;
    second.materials.forEach((m) => { m.layoutId = second.profile.id; m.preview.colorMaskUrl = second.profile.fabricMask; });
    const put = (list, revision) => adminPut({ request: new Request(adminUrl, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ products: list, revision }) }), env });
    const saved = await put([product, second], null);
    assert.equal(saved.status, 200);
    const revision = (await saved.json()).revision;
    assert.equal((await put([product], null)).status, 409);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM designer_products").first()).n, 2);
    const identitySql = readFileSync(new URL("../migrations/0003_designer_product_identities.sql", import.meta.url), "utf8");
    const identityStatements = identitySql.match(
      /CREATE TRIGGER[\s\S]*?\nEND;|CREATE TABLE[\s\S]*?\n\);|INSERT INTO designer_product_identities[\s\S]*?FROM designer_products;/g,
    );
    assert.equal(identityStatements?.length, 6);
    await db.batch(identityStatements.map((statement) => db.prepare(statement)));
    const identity = await db.prepare("SELECT product_uuid FROM designer_product_identities WHERE legacy_product_id = ?")
      .bind("womens-pouch").first();
    assert.match(identity.product_uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    second.active = false;
    const third = structuredClone(second);
    third.profile.id = "third-profile";
    third.profile.productId = "third-product";
    third.slug = "third-product";
    third.profile.fabricMask = pouchProfile.fabricMask;
    third.materials.forEach((m) => { m.layoutId = third.profile.id; m.preview.colorMaskUrl = third.profile.fabricMask; });
    assert.equal((await put([product, second, third], revision)).status, 200);
    assert.equal((await db.prepare("SELECT product_uuid FROM designer_product_identities WHERE legacy_product_id = ?")
      .bind("womens-pouch").first()).product_uuid, identity.product_uuid);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM designer_product_identities").first()).n, 3);
    assert.deepEqual((await (await publicGet({ env })).json()).products.map((p) => p.profile.productId), ["womens-pouch"]);
    assert.equal((await deleteAsset({
      request: new Request(`https://shop.example/api/assets/${assetId}`, { method: "DELETE", headers }),
      env, params: { assetId },
    })).status, 409);
    const currentRevision = (await (await adminGet({ request: new Request(adminUrl, { headers }), env })).json()).revision;
    assert.equal((await put([product, third], currentRevision)).status, 200);
    const failingAssets = { delete: async () => { throw new Error("R2 unavailable"); } };
    const failedDelete = await deleteAsset({
      request: new Request(`https://shop.example/api/assets/${assetId}`, { method: "DELETE", headers }),
      env: { ...env, SHOP_ASSETS: failingAssets }, params: { assetId },
    });
    assert.equal(failedDelete.status, 500);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM shop_assets WHERE id = ?").bind(assetId).first()).n, 1);
    assert.equal((await getAsset({ request: new Request(`https://shop.example/api/assets/${assetId}`), env, params: { assetId } })).status, 200);
    assert.equal((await deleteAsset({
      request: new Request(`https://shop.example/api/assets/${assetId}`, { method: "DELETE", headers }),
      env, params: { assetId },
    })).status, 204);
    assert.equal((await getAsset({ request: new Request(`https://shop.example/api/assets/${assetId}`), env, params: { assetId } })).status, 404);

    const makePlan = (item) => {
      const keys = item.profile.views ? Object.keys(item.profile.views) : ["front"];
      const views = Object.fromEntries(keys.map((key) => {
        const canvas = item.profile.views?.[key]?.canvas ?? item.profile.canvas;
        return [key, {
          format: "roli-2d-design", version: 1, profileId: item.profile.id, productId: item.profile.productId,
          canvas: { ...canvas }, area: { x: 0, y: 0, ...canvas },
          materialId: item.materials[0].id, layers: [],
        }];
      }));
      return {
        format: "roli-2d-design", version: 2, profileId: item.profile.id,
        productId: item.profile.productId, activeView: "front", views,
      };
    };
    const submitPlan = async (item, slug, origin = "https://shop.example", clientIp = "198.51.100.45") => {
      const form = new FormData();
      form.set("productSlug", slug);
      const plan = makePlan(item);
      const requestFiles = [
        ["plan", "terv.json", "application/json", JSON.stringify(plan)],
        ...Object.keys(plan.views).map((key, index) => [
          index ? "view-png" : "preview", `${key}.png`, "image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        ]),
        ["summary-pdf", "osszefoglalo.pdf", "application/pdf", "%PDF-1.4"],
        ["archive", "csomag.zip", "application/zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
      ];
      for (const [role, name, type, content] of requestFiles) {
        form.append("files", new File([content], name, { type }), name);
        form.append("roles", role);
      }
      return createRequest({ request: new Request("https://shop.example/api/designer-requests", {
        method: "POST", headers: {
          Origin: origin, ...(clientIp ? { "CF-Connecting-IP": clientIp } : {}),
        }, body: form,
      }), env });
    };
    assert.equal((await submitPlan(product, "noi-neszeszer", "https://evil.example")).status, 403);
    assert.equal((await submitPlan(product, "noi-neszeszer", "https://shop.example", null)).status, 429);
    assert.equal((await submitPlan(product, "noi-neszeszer")).status, 200);
    const separateProduct = structuredClone(product);
    separateProduct.profile.id = "separate-profile";
    separateProduct.profile.productId = "separate-product";
    separateProduct.profile.name = "Külön termék";
    separateProduct.slug = "kulon-termek";
    separateProduct.materials.forEach((material) => { material.layoutId = separateProduct.profile.id; });
    const photo = { id: "front-reference", url: separateProduct.profile.photo, name: "Elölnézet", width: 1254, height: 1254 };
    separateProduct.profile.views = {
      front: {
        photos: [photo], referencePhotoId: photo.id, photo: photo.url, canvas: { ...separateProduct.profile.canvas },
        fabricMask: separateProduct.profile.fabricMask, surfaceMask: separateProduct.profile.surfaceMask, protectMasks: [],
      },
      back: {
        photos: [{ ...photo, id: "back-reference", name: "Hátulnézet" }], referencePhotoId: "back-reference",
        photo: photo.url, canvas: { ...separateProduct.profile.canvas },
        fabricMask: separateProduct.profile.surfaceMask, surfaceMask: separateProduct.profile.fabricMask, protectMasks: [],
      },
    };
    const latestRevision = (await (await adminGet({ request: new Request(adminUrl, { headers }), env })).json()).revision;
    assert.equal((await put([product, separateProduct], latestRevision)).status, 200);
    assert.equal((await submitPlan(separateProduct, "kulon-termek")).status, 200);
    assert.equal((await listRequests({ request: new Request("https://shop.example/api/designer-requests"), env })).status, 401);
    const requestsResponse = await listRequests({
      request: new Request("https://shop.example/api/designer-requests", { headers }), env,
    });
    assert.equal(requestsResponse.status, 200);
    const orders = (await requestsResponse.json()).orders;
    assert.equal(orders.length, 2);
    assert.deepEqual(new Set(orders.map((order) => order.items[0].productName)), new Set(["Női neszeszer", "Külön termék"]));
    const multiViewItem = orders.find((order) => order.items[0].productName === "Külön termék").items[0];
    assert.deepEqual(Object.keys(multiViewItem.design.views), ["front", "back"]);
    assert.equal(multiViewItem.files.filter((file) => file.role === "view-png").length, 1);
    assert.equal(multiViewItem.files.filter((file) => file.role === "archive").length, 1);
    assert.ok(orders.every((order) => order.shopifyOrderId === null));
    const storedPreview = orders[0].items[0].files.find((file) => file.role === "preview");
    assert.ok(storedPreview);
    assert.equal((await getRequestFile({
      request: new Request(`https://shop.example/api/admin/designer-requests/files/${storedPreview.id}`),
      env, params: { fileId: storedPreview.id },
    })).status, 401);
    const protectedFile = await getRequestFile({
      request: new Request(`https://shop.example/api/admin/designer-requests/files/${storedPreview.id}`, { headers }),
      env, params: { fileId: storedPreview.id },
    });
    assert.equal(protectedFile.status, 200);
    assert.equal(protectedFile.headers.get("cache-control"), "private, no-store");
    const storedAsset = await db.prepare(
      "SELECT asset_id FROM designer_order_files WHERE id = ?",
    ).bind(storedPreview.id).first();
    assert.equal((await getAsset({
      request: new Request(`https://shop.example/api/assets/${storedAsset.asset_id}`), env,
      params: { assetId: storedAsset.asset_id },
    })).status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  }
});

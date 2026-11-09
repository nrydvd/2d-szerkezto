import assert from "node:assert/strict";
import test from "node:test";
import { designerProductSlug, validateDesignerCatalog } from "../functions/_shared/designer-catalog.js";
import { onRequestGet as publicGet } from "../functions/api/designer-products.js";
import { onRequestGet as publicProductGet } from "../functions/api/designer-products/[slug].js";
import { onRequestPost as validateDesign } from "../functions/api/designer-designs/validate.js";
import { onRequestGet as adminGet, onRequestPut as adminPut } from "../functions/api/admin/designer-products.js";
import { onRequestPost as uploadAsset } from "../functions/api/admin/assets.js";
import { onRequestDelete as deleteAsset, onRequestGet as getAsset } from "../functions/api/assets/[assetId].js";
import { pouchProfile } from "../src/designer-prototype/profile.ts";
import { MATERIALS } from "../src/designer-prototype/materials.ts";
import { onRequestGet as editorRoute } from "../functions/szerkeszto/[slug].js";
import { onRequestGet as adminRoute } from "../functions/termekek/[slug].js";

const products = () => [{
  profile: structuredClone(pouchProfile), active: true,
  materials: MATERIALS.map((m, i) => ({ ...structuredClone(m), priceHuf: i ? 5990 : 5490 })),
}];

test("catalog validates profiles, visibility, prices and material bindings", () => {
  const list = products();
  assert.equal(validateDesignerCatalog(list), null);
  const second = structuredClone(list[0]);
  second.profile.id = "test-profile";
  second.profile.productId = "test-product";
  second.materials = second.materials.map((m) => ({ ...m, layoutId: second.profile.id }));
  list.push(second);
  assert.equal(validateDesignerCatalog(list), null);
  second.materials[0].priceHuf = -1;
  assert.match(validateDesignerCatalog(list), /anyag/);
  second.materials[0].priceHuf = 1;
  second.profile.surfaceMask = "";
  assert.match(validateDesignerCatalog(list), /maszk/);
  second.active = false;
  second.materials.forEach((m) => { m.preview.surfaceMaskUrl = ""; });
  assert.equal(validateDesignerCatalog(list), null);
  second.profile.productId = "womens-pouch";
  assert.match(validateDesignerCatalog(list), /egyedi/);
});

test("catalog keeps optional product photos, independent protect masks, internal notes and editor settings", () => {
  const list = products();
  const product = list[0];
  product.profile.photos = [{ id: "reference", url: product.profile.photo, name: "Referencia" }];
  product.profile.protectMasks = [{ id: "zipper", label: "Cipzár", url: product.profile.fabricMask }];
  product.profile.areas = { color: "Textil", pattern: "Előlap", protect: "Cipzár" };
  product.description = "Rövid adminleírás";
  product.editorSettings = { customText: true, maxTextLength: 40, imageUpload: false, maxUploadBytes: 2 * 1024 * 1024, enabled2d: true };
  assert.equal(validateDesignerCatalog(list), null);
  product.profile.photos[0].url = "/external/photo.png";
  assert.match(validateDesignerCatalog(list), /referenciafotó/);
  product.profile.photos[0].url = product.profile.photo;
  product.profile.protectMasks[0].label = "";
  assert.match(validateDesignerCatalog(list), /védőmaszk/);
  product.profile.protectMasks[0].label = "Cipzár";
  product.editorSettings.maxTextLength = 201;
  assert.match(validateDesignerCatalog(list), /beállításai/);
  product.editorSettings.maxTextLength = 40;
  product.editorSettings.enabled2d = false;
  assert.match(validateDesignerCatalog(list), /nem aktiválható/);
  product.editorSettings.enabled2d = true;
  assert.equal(validateDesignerCatalog(list), null);
});

test("catalog validates independent per-view references, masks, geometry, and optional Shopify pricing links", () => {
  const list = products();
  const product = list[0];
  const view = (id, photo, width, height, fabricMask, surfaceMask) => ({
    photos: [{ id, url: photo, name: `${id}.png`, width, height }],
    referencePhotoId: id, photo, canvas: { width, height }, fabricMask, surfaceMask,
    protectMasks: [{ id: `${id}-zipper`, label: "Cipzár", url: fabricMask }],
  });
  const front = view("front", product.profile.photo, 1254, 1254, product.profile.fabricMask, product.profile.surfaceMask);
  const back = view("back", "/images/products/noi-neszeszer-back.png", 900, 1200,
    "/images/masks/noi-neszeszer/back-color.png", "/images/masks/noi-neszeszer/back-pattern.png");
  product.profile.views = { front, back };
  product.materials.forEach((material) => { delete material.priceHuf; });
  assert.equal(validateDesignerCatalog(list), null);
  back.protectMasks.push({ id: "front-only", label: "Elülső cipzár", url: product.profile.fabricMask });
  assert.equal(validateDesignerCatalog(list), null);
  back.referencePhotoId = "front";
  assert.match(validateDesignerCatalog(list), /nézetek/);
  back.referencePhotoId = "back";
  back.canvas.width = 901;
  assert.match(validateDesignerCatalog(list), /képméretével/);
  back.canvas.width = 900;
  product.shopifyProductId = "";
  assert.match(validateDesignerCatalog(list), /Shopify-termékazonosító/);
  delete product.shopifyProductId;
  product.materials[0].shopifyVariantId = "variant-test";
  assert.match(validateDesignerCatalog(list), /Shopify-termékazonosító/);
});

test("legacy and new slugs are unique and do not change product identity", () => {
  const list = products();
  assert.equal(designerProductSlug(list[0]), "noi-neszeszer");
  const other = structuredClone(list[0]);
  other.profile.id = "other-profile";
  other.profile.productId = "other-product";
  other.materials.forEach((m) => { m.layoutId = other.profile.id; });
  other.slug = "hobo-taska";
  list.push(other);
  assert.equal(validateDesignerCatalog(list), null);
  other.slug = "noi-neszeszer";
  assert.match(validateDesignerCatalog(list), /URL-azonosítója/);
  other.slug = "../invalid";
  assert.match(validateDesignerCatalog(list), /URL-azonosítója/);
});

test("saved designs are server-checked against the selected active product", async () => {
  const list = products();
  let payload = JSON.stringify(list);
  const env = {
    SHOP_ASSETS: {},
    SHOP_DB: { prepare() { return { bind() { return { async first() { return { payload }; } }; } }; } },
  };
  const design = {
    format: "roli-2d-design", version: 1, profileId: list[0].profile.id,
    productId: list[0].profile.productId, canvas: list[0].profile.canvas,
    area: { x: 0, y: 0, ...list[0].profile.canvas }, materialId: list[0].materials[0].id, layers: [],
  };
  const post = (slug, plan) => validateDesign({
    request: new Request("https://designer.example/api/designer-designs/validate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, design: plan }),
    }),
    env,
  });
  assert.equal((await post("noi-neszeszer", design)).status, 200);
  const frontView = {
    photos: [{ id: "front", url: list[0].profile.photo, name: "Elöl", width: 1254, height: 1254 }],
    referencePhotoId: "front", photo: list[0].profile.photo, canvas: { width: 1254, height: 1254 },
    fabricMask: list[0].profile.fabricMask, surfaceMask: list[0].profile.surfaceMask, protectMasks: [],
  };
  const backView = {
    photos: [{ id: "back", url: "/images/products/noi-neszeszer-back.png", name: "Hátul", width: 900, height: 1200 }],
    referencePhotoId: "back", photo: "/images/products/noi-neszeszer-back.png", canvas: { width: 900, height: 1200 },
    fabricMask: "/images/masks/noi-neszeszer/back-color.png",
    surfaceMask: "/images/masks/noi-neszeszer/back-pattern.png", protectMasks: [],
  };
  list[0].profile.views = { front: frontView, back: backView };
  const backDesign = { ...design, canvas: backView.canvas, area: { x: 0, y: 0, ...backView.canvas } };
  const collection = {
    format: "roli-2d-design", version: 2, profileId: list[0].profile.id,
    productId: list[0].profile.productId, activeView: "back", views: { front: design, back: backDesign },
  };
  payload = JSON.stringify(list);
  assert.equal((await post("noi-neszeszer", collection)).status, 200);
  assert.equal((await post("noi-neszeszer", { ...collection, views: { front: design } })).status, 400);
  assert.equal((await post("noi-neszeszer", { ...collection, views: { front: design, back: { ...backDesign, canvas: { width: 901, height: 1200 } } } })).status, 400);
  assert.equal((await post("other-product", design)).status, 404);
  assert.equal((await post("noi-neszeszer", { ...design, productId: "other-product" })).status, 400);
  assert.equal((await post("noi-neszeszer", { ...design, materialId: "other-material" })).status, 400);
  list[0].active = false;
  payload = JSON.stringify(list);
  assert.equal((await post("noi-neszeszer", design)).status, 404);
});

test("product slug API returns only the requested active product", async () => {
  const list = products();
  const second = structuredClone(list[0]);
  second.profile.id = "hobo-profile";
  second.profile.productId = "hobo-product";
  second.profile.name = "Hobo táska";
  second.slug = "hobo-taska";
  second.materials = second.materials.map((material) => ({ ...material, layoutId: second.profile.id }));
  list.push(second);
  const env = {
    SHOP_ASSETS: {},
    SHOP_DB: { prepare() { return { bind() { return { async first() { return { payload: JSON.stringify(list) }; } }; } }; } },
  };
  const response = await publicProductGet({ env, params: { slug: "hobo-taska" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).product.profile.productId, "hobo-product");
  assert.equal((await publicProductGet({ env, params: { slug: "missing" } })).status, 404);
});

test("Cloudflare deep links serve their own app entry and skip non-slug assets", async () => {
  for (const [handler, path] of [[editorRoute, "szerkeszto"], [adminRoute, "termekek"]]) {
    let forwarded = "";
    const env = { ASSETS: { async fetch(request) { forwarded = new URL(request.url).pathname; return new Response("app"); } } };
    const next = () => new Response("next");
    const request = new Request(`https://shop.example/${path}/hobo-taska`);
    const response = await handler({ request, env, params: { slug: "hobo-taska" }, next });
    assert.equal(await response.text(), "app");
    assert.equal(forwarded, `/${path}/`);
    const other = await handler({ request, env, params: { slug: "index.html" }, next });
    assert.equal(await other.text(), "next");
  }
});

test("D1 API protects admin access and exposes only active products", async () => {
  const originalFetch = globalThis.fetch;
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "test-key", alg: "RS256" };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", kid: "test-key" })}.${encode({ iss: "https://team.example", aud: ["audience"], exp: Date.now() / 1000 + 300 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned));
  const token = `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  let payload = null;
  const assets = new Map();
  const objects = new Map();
  const env = {
    CF_ACCESS_TEAM_DOMAIN: "team.example", CF_ACCESS_AUD: "audience",
    SHOP_ASSETS: {
      async put(id, bytes) { objects.set(id, bytes); },
      async get(id) { return objects.has(id) ? { body: objects.get(id) } : null; },
      async delete(id) { objects.delete(id); },
    },
    SHOP_DB: { prepare(sql) { return { bind(...args) { return {
      async first() {
        if (sql.startsWith("SELECT purpose") || sql.startsWith("SELECT content_type") ||
            sql.startsWith("SELECT id, purpose") || sql.startsWith("SELECT id, file_name")) return assets.get(args[0]) ?? null;
        if (sql.startsWith("DELETE FROM shop_assets")) {
          if (payload?.includes(args[1])) return null;
          assets.delete(args[0]);
          return { id: args[0] };
        }
        if (sql.startsWith("INSERT OR IGNORE")) {
          if (payload !== null) return null;
          payload = args[1];
          return { state_key: args[0] };
        }
        if (sql.startsWith("UPDATE shop_state")) {
          if (payload !== args[2]) return null;
          payload = args[0];
          return { state_key: args[1] };
        }
        return payload === null ? null : { payload };
      },
      async run() {
        if (sql.includes("INSERT INTO shop_assets")) {
          assets.set(args[0], {
            file_name: args[1], content_type: args[2], byte_length: args[3], purpose: args[4], created_at: args[5],
          });
        } else if (sql.startsWith("INSERT")) {
          if (payload !== null) return { meta: { changes: 0 } };
          payload = args[1];
        } else {
          if (payload !== args[2]) return { meta: { changes: 0 } };
          payload = args[0];
        }
        return { meta: { changes: 1 } };
      },
    }; } }; } },
  };
  globalThis.fetch = async () => Response.json({ keys: [jwk] });
  try {
    const url = "https://shop.example/api/admin/designer-products";
    assert.equal((await adminGet({ request: new Request(url), env })).status, 401);
    const request = (body, origin = "https://shop.example") => new Request(url, {
      method: "PUT", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" }, body,
    });
    const unauthenticatedMutations = [
      products(),
      products().map((product) => ({ ...product, profile: { ...product.profile, name: "Jogosulatlan módosítás" } })),
      [],
    ];
    for (const updatedProducts of unauthenticatedMutations) {
      assert.equal((await adminPut({ request: new Request(url, {
        method: "PUT", headers: { Origin: "https://shop.example", "Content-Type": "application/json" },
        body: JSON.stringify({ products: updatedProducts, revision: null }),
      }), env })).status, 401);
    }
    const list = products();
    const draft = structuredClone(list[0]);
    draft.active = false;
    draft.profile.id = "draft-profile";
    draft.profile.productId = "draft-product";
    draft.materials = draft.materials.map((m) => ({ ...m, layoutId: draft.profile.id }));
    list.push(draft);
    assert.equal((await adminPut({ request: request(JSON.stringify({ products: list, revision: null }), "https://evil.example"), env })).status, 403);
    assert.equal((await adminPut({ request: request("{"), env })).status, 400);
    const saved = await adminPut({ request: request(JSON.stringify({ products: list, revision: null })), env });
    assert.equal(saved.status, 200);
    const savedRevision = (await saved.json()).revision;
    assert.equal(JSON.parse(payload).length, 2);
    const admin = await adminGet({ request: new Request(url, { headers: { "Cf-Access-Jwt-Assertion": token } }), env });
    assert.equal((await admin.json()).products.length, 2);
    const publicResponse = await publicGet({ env });
    assert.deepEqual((await publicResponse.json()).products.map((p) => p.profile.productId), ["womens-pouch"]);
    assert.equal((await adminPut({ request: request(JSON.stringify({ products: list, revision: null })), env })).status, 409);
    assert.equal((await adminPut({ request: request(JSON.stringify({ products: [{ ...list[0], materials: [] }], revision: savedRevision })), env })).status, 400);
    assert.equal((await adminPut({ request: request(JSON.stringify({ products: list, revision: savedRevision })), env })).status, 200);
    const deleted = await adminPut({ request: request(JSON.stringify({ products: list.slice(0, 1), revision: savedRevision })), env });
    assert.equal(deleted.status, 200);
    assert.equal(JSON.parse(payload).length, 1);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "mask.png", { type: "image/png" }));
    const unauthenticatedForm = new FormData();
    unauthenticatedForm.set("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "mask.png", { type: "image/png" }));
    assert.equal((await uploadAsset({ request: new Request("https://shop.example/api/admin/assets", {
      method: "POST", headers: { Origin: "https://shop.example" }, body: unauthenticatedForm,
    }), env })).status, 401);
    const upload = await uploadAsset({ request: new Request("https://shop.example/api/admin/assets", {
      method: "POST", headers: { Origin: "https://shop.example", "Cf-Access-Jwt-Assertion": token }, body: form,
    }), env });
    assert.equal(upload.status, 200);
    const assetId = (await upload.json()).id;
    assert.equal(objects.has(assetId), true);
    const imageResponse = await getAsset({ request: new Request(`https://shop.example/api/assets/${assetId}`), env, params: { assetId } });
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get("content-type"), "image/png");
    const imageProducts = products();
    imageProducts[0].profile.photo = `/api/assets/${assetId}`;
    imageProducts[0].materials.forEach((m) => { m.preview.photoUrl = imageProducts[0].profile.photo; });
    const currentRevision = (await (await adminGet({ request: new Request(url, { headers: { "Cf-Access-Jwt-Assertion": token } }), env })).json()).revision;
    assert.equal((await adminPut({ request: request(JSON.stringify({ products: imageProducts, revision: currentRevision })), env })).status, 200);
    const deleteRequest = (origin = "https://shop.example", authenticated = true) => new Request(`https://shop.example/api/assets/${assetId}`, {
      method: "DELETE", headers: { Origin: origin, ...(authenticated ? { "Cf-Access-Jwt-Assertion": token } : {}) },
    });
    assert.equal((await deleteAsset({ request: deleteRequest("https://shop.example", false), env, params: { assetId } })).status, 401);
    assert.equal((await deleteAsset({ request: deleteRequest("https://evil.example"), env, params: { assetId } })).status, 403);
    assert.equal((await deleteAsset({ request: deleteRequest(), env, params: { assetId } })).status, 409);
    imageProducts[0].profile.photo = pouchProfile.photo;
    imageProducts[0].materials.forEach((m) => { m.preview.photoUrl = pouchProfile.photo; });
    const detachedRevision = (await (await adminGet({ request: new Request(url, { headers: { "Cf-Access-Jwt-Assertion": token } }), env })).json()).revision;
    assert.equal((await adminPut({ request: request(JSON.stringify({ products: imageProducts, revision: detachedRevision })), env })).status, 200);
    assert.equal((await deleteAsset({ request: deleteRequest(), env, params: { assetId } })).status, 204);
    assert.equal(objects.has(assetId), false);
  } finally { globalThis.fetch = originalFetch; }
});

import { configured, errorResponse, hasAdminAccess, json, sameOrigin } from "../../_shared/http.js";
import { validateDesignerCatalog } from "../../_shared/designer-catalog.js";

async function revision(payload) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function onRequestGet({ request, env }) {
  if (!configured(env)) return errorResponse("A központi terméktár nincs konfigurálva.", 503);
  if (!await hasAdminAccess(request, env)) return errorResponse("Az adminisztrációhoz belépés szükséges.", 401);
  try {
    const row = await env.SHOP_DB.prepare("SELECT payload FROM shop_state WHERE state_key = ?").bind("designerProducts").first();
    const products = row ? JSON.parse(row.payload) : null;
    if (products && validateDesignerCatalog(products)) throw new Error("Érvénytelen termékkatalógus.");
    return json({ products, revision: row ? await revision(row.payload) : null });
  } catch (error) {
    console.error("A tervező adminadatainak betöltése sikertelen.", error);
    return errorResponse("A termékkatalógus nem tölthető be.", 500);
  }
}

export async function onRequestPut({ request, env }) {
  if (!configured(env)) return errorResponse("A központi terméktár nincs konfigurálva.", 503);
  if (!sameOrigin(request)) return errorResponse("Idegen webhelyről érkező kérés elutasítva.", 403);
  if (!await hasAdminAccess(request, env)) return errorResponse("Az adminisztrációhoz belépés szükséges.", 401);
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 4_500_000) return errorResponse("A termékkatalógus túl nagy.", 413);
    let data;
    try { data = JSON.parse(body); } catch { return errorResponse("A kérés nem érvényes JSON.", 400); }
    const products = data?.products;
    if (data?.revision !== null && (typeof data?.revision !== "string" || !/^[a-f0-9]{64}$/.test(data.revision))) {
      return errorResponse("A katalógus verziója hiányzik vagy érvénytelen.", 400);
    }
    const error = validateDesignerCatalog(products);
    if (error) return errorResponse(error, 400);
    const assetIds = [...new Set([...body.matchAll(/\/api\/assets\/([a-f0-9-]{36})/g)].map((match) => match[1]))];
    for (const id of assetIds) {
      const asset = await env.SHOP_DB.prepare("SELECT purpose, content_type FROM shop_assets WHERE id = ?").bind(id).first();
      if (!asset || asset.purpose !== "public" || !asset.content_type.startsWith("image/")) {
        return errorResponse("A termék egyik képe nem található a nyilvános képtárban.", 400);
      }
    }
    const maskIds = new Set();
    for (const product of products) {
      const profile = product.profile;
      for (const value of [profile.fabricMask, profile.surfaceMask,
        ...(profile.protectMasks ?? []).map((mask) => mask.url),
        ...Object.values(profile.views ?? {}).flatMap((view) => [
          view.fabricMask, view.surfaceMask, ...view.protectMasks.map((mask) => mask.url),
        ]),
      ]) {
        const match = typeof value === "string" && /^\/api\/assets\/([a-f0-9-]{36})$/.exec(value);
        if (match) maskIds.add(match[1]);
      }
    }
    for (const id of maskIds) {
      const asset = await env.SHOP_DB.prepare("SELECT content_type FROM shop_assets WHERE id = ?").bind(id).first();
      if (!asset || !["image/png", "image/webp"].includes(asset.content_type)) {
        return errorResponse("A szín-, minta- és védőmaszkok csak PNG vagy WebP fájlok lehetnek.", 400);
      }
    }
    const row = await env.SHOP_DB.prepare("SELECT payload FROM shop_state WHERE state_key = ?").bind("designerProducts").first();
    if ((row ? await revision(row.payload) : null) !== data.revision) {
      return errorResponse("A katalógus közben megváltozott. Töltsd újra az adminoldalt.", 409);
    }
    const payload = JSON.stringify(products);
    const assetGuard = assetIds.map(() => "EXISTS (SELECT 1 FROM shop_assets WHERE id = ?)").join(" AND ");
    const saved = row
      ? await env.SHOP_DB.prepare(
        `UPDATE shop_state SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE state_key = ? AND payload = ?` +
        `${assetGuard ? ` AND ${assetGuard}` : ""} RETURNING state_key`,
      ).bind(payload, "designerProducts", row.payload, ...assetIds).first()
      : await env.SHOP_DB.prepare(
        `INSERT OR IGNORE INTO shop_state (state_key, payload, updated_at) SELECT ?, ?, CURRENT_TIMESTAMP ` +
        `WHERE NOT EXISTS (SELECT 1 FROM shop_state WHERE state_key = ?)` +
        `${assetGuard ? ` AND ${assetGuard}` : ""} RETURNING state_key`,
      ).bind("designerProducts", payload, "designerProducts", ...assetIds).first();
    if (!saved) return errorResponse("A katalógus közben megváltozott. Töltsd újra az adminoldalt.", 409);
    return json({ saved: true, revision: await revision(payload) });
  } catch (error) {
    console.error("A tervező termékeinek mentése sikertelen.", error);
    return errorResponse("A termékkatalógus nem menthető.", 500);
  }
}

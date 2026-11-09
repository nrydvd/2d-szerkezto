import { configured, errorResponse, hasAdminAccess, sameOrigin } from "../../_shared/http.js";

export async function onRequestGet({ request, env, params }) {
  if (!configured(env)) return errorResponse("A szerkesztő képtára nincs konfigurálva.", 503);
  try {
    const asset = await env.SHOP_DB.prepare(
      "SELECT content_type, purpose FROM shop_assets WHERE id = ?",
    ).bind(params.assetId).first();
    if (!asset) return errorResponse("A fájl nem található.", 404);
    if ((asset.purpose === "admin" || asset.purpose === "customer-artwork") &&
        !await hasAdminAccess(request, env)) {
      return errorResponse("Ehhez a belső fájlhoz adminisztrátori belépés szükséges.", 401);
    }
    const object = await env.SHOP_ASSETS.get(params.assetId);
    if (!object) return errorResponse("A fájl nem található az R2-tárban.", 404);
    return new Response(object.body, {
      headers: {
        "Content-Type": asset.content_type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": asset.purpose === "public" ? "public, max-age=3600" : "private, no-store",
      },
    });
  } catch (error) {
    console.error("A fájl kiszolgálása nem sikerült.", error);
    return errorResponse("A fájl átmenetileg nem érhető el.", 500);
  }
}

export async function onRequestDelete({ request, env, params }) {
  if (!configured(env)) return errorResponse("A szerkesztő képtára nincs konfigurálva.", 503);
  if (!sameOrigin(request)) return errorResponse("Idegen webhelyről érkező törlés elutasítva.", 403);
  if (!await hasAdminAccess(request, env)) return errorResponse("Az adminisztrációhoz Cloudflare Access belépés szükséges.", 401);
  try {
    const asset = await env.SHOP_DB.prepare(
      "SELECT id, file_name, content_type, byte_length, purpose, created_at FROM shop_assets WHERE id = ?",
    ).bind(params.assetId).first();
    if (!asset) return errorResponse("A fájl nem található.", 404);
    if (asset.purpose !== "public") return errorResponse("Ez a fájl nem törölhető a termékkatalógusból.", 403);
    const reference = `/api/assets/${params.assetId}`;
    const removed = await env.SHOP_DB.prepare(
      "DELETE FROM shop_assets WHERE id = ? AND purpose = 'public' " +
      "AND NOT EXISTS (SELECT 1 FROM shop_state WHERE instr(payload, ?) > 0) RETURNING id",
    ).bind(params.assetId, reference).first();
    if (!removed) return errorResponse("A fájlra még hivatkozik egy mentett adat. Előbb távolítsd el az összes termékből és mentsd a katalógust.", 409);
    try {
      await env.SHOP_ASSETS.delete(params.assetId);
    } catch (error) {
      try {
        await env.SHOP_DB.prepare(
          "INSERT INTO shop_assets (id, file_name, content_type, byte_length, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(asset.id, asset.file_name, asset.content_type, asset.byte_length, asset.purpose, asset.created_at).run();
      } catch (restoreError) {
        console.error("A fájltörlés sikertelensége után az eszköz metaadata sem állítható vissza.", restoreError);
      }
      throw error;
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("A fájl törlése nem sikerült.", error);
    return errorResponse("A fájlt nem sikerült törölni.", 500);
  }
}

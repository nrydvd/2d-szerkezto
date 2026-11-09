import { configured, errorResponse, hasAdminAccess, safeFileName } from "../../../../_shared/http.js";

export async function onRequestGet({ request, env, params }) {
  if (!configured(env)) return errorResponse("A vásárlói igények tárhelye nincs konfigurálva.", 503);
  if (!await hasAdminAccess(request, env)) return errorResponse("A fájl letöltéséhez adminisztrátori belépés szükséges.", 401);
  if (!/^[0-9a-f-]{36}$/i.test(params.fileId)) return errorResponse("A fájl nem található.", 404);
  try {
    const file = await env.SHOP_DB.prepare(
      "SELECT f.file_name, f.content_type, a.purpose FROM designer_order_files f " +
      "JOIN shop_assets a ON a.id = f.asset_id WHERE f.id = ?",
    ).bind(params.fileId).first();
    if (!file || file.purpose !== "customer-artwork") return errorResponse("A fájl nem található.", 404);
    const row = await env.SHOP_DB.prepare(
      "SELECT a.id FROM designer_order_files f JOIN shop_assets a ON a.id = f.asset_id WHERE f.id = ?",
    ).bind(params.fileId).first();
    const object = row ? await env.SHOP_ASSETS.get(row.id) : null;
    if (!object) return errorResponse("A fájl nem található az R2-tárban.", 404);
    const name = safeFileName(file.file_name);
    return new Response(object.body, {
      headers: {
        "Content-Type": file.content_type,
        "Content-Disposition": `${new URL(request.url).searchParams.has("inline") &&
          (file.content_type.startsWith("image/") || file.content_type === "application/pdf" ||
            file.content_type === "application/json") ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("A vásárlói fájl kiszolgálása nem sikerült.", error);
    return errorResponse("A fájl átmenetileg nem tölthető le.", 500);
  }
}

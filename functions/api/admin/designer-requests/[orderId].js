import { configured, errorResponse, hasAdminAccess, sameOrigin } from "../../../_shared/http.js";

export async function onRequestDelete({ request, env, params }) {
  if (!configured(env)) return errorResponse("A vásárlói igények tárhelye nincs konfigurálva.", 503);
  if (!sameOrigin(request)) return errorResponse("Idegen webhelyről érkező törlés elutasítva.", 403);
  if (!await hasAdminAccess(request, env)) return errorResponse("Az igény törléséhez adminisztrátori belépés szükséges.", 401);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.orderId)) {
    return errorResponse("Az igénycsomag nem található.", 404);
  }
  try {
    const order = await env.SHOP_DB.prepare("SELECT id FROM designer_orders WHERE id = ?").bind(params.orderId).first();
    if (!order) return errorResponse("Az igénycsomag nem található.", 404);
    const files = await env.SHOP_DB.prepare(
      "SELECT f.asset_id, f.id AS file_id FROM designer_order_files f JOIN designer_order_items i ON i.id = f.order_item_id WHERE i.order_id = ?",
    ).bind(params.orderId).all();
    const rows = files.results ?? [];
    const ids = rows.map((row) => row.asset_id);
    const statements = [
      env.SHOP_DB.prepare("DELETE FROM designer_order_files WHERE order_item_id IN (SELECT id FROM designer_order_items WHERE order_id = ?)").bind(params.orderId),
      env.SHOP_DB.prepare("DELETE FROM designer_order_items WHERE order_id = ?").bind(params.orderId),
      env.SHOP_DB.prepare("DELETE FROM designer_orders WHERE id = ?").bind(params.orderId),
    ];
    await env.SHOP_DB.batch(statements);
    for (const row of rows) {
      const stillReferenced = await env.SHOP_DB.prepare(
        "SELECT 1 FROM designer_order_files WHERE asset_id = ?",
      ).bind(row.asset_id).first();
      if (!stillReferenced) {
        await env.SHOP_ASSETS.delete(row.asset_id);
        await env.SHOP_DB.prepare("DELETE FROM shop_assets WHERE id = ? AND purpose = 'customer-artwork'").bind(row.asset_id).run();
      }
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Az igénycsomag törlése sikertelen.", error);
    return errorResponse("A törlés nem fejeződött be. Egyes fájlok már törlődhettek; próbáld újra.", 500);
  }
}

import { configured, errorResponse, json } from "../_shared/http.js";

export async function onRequestPost({ request, env }) {
  if (!configured(env) || !env.SHOPIFY_WEBHOOK_SECRET || !env.SHOPIFY_STORE_DOMAIN) {
    return errorResponse("A Shopify webhook nincs konfigurálva.", 503);
  }
  if (request.headers.get("X-Shopify-Topic") !== "orders/create" ||
      request.headers.get("X-Shopify-Shop-Domain") !== env.SHOPIFY_STORE_DOMAIN) {
    return errorResponse("A webhook forrása érvénytelen.", 401);
  }
  const signature = request.headers.get("X-Shopify-Hmac-Sha256");
  if (!signature) return errorResponse("A webhook aláírása hiányzik.", 401);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 1024 * 1024) return errorResponse("A webhook túl nagy.", 413);
  let decoded;
  try { decoded = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)); }
  catch { return errorResponse("A webhook aláírása érvénytelen.", 401); }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SHOPIFY_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, decoded, bytes)) return errorResponse("A webhook aláírása érvénytelen.", 401);
  try {
    const order = JSON.parse(new TextDecoder().decode(bytes));
    if (!Number.isSafeInteger(order?.id) || !Array.isArray(order.line_items)) {
      return errorResponse("A Shopify-rendelés adatai érvénytelenek.", 400);
    }
    for (const line of order.line_items) {
      const itemId = line.properties?.find((property) => property.name === "Designer tervazonosító")?.value;
      if (typeof itemId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId) ||
          !Number.isSafeInteger(line.id) || !Number.isSafeInteger(line.product_id) || !Number.isSafeInteger(line.variant_id)) continue;
      const item = await env.SHOP_DB.prepare(
        "SELECT i.order_id, o.shopify_order_id FROM designer_order_items i JOIN designer_orders o ON o.id = i.order_id " +
        "WHERE i.id = ? AND i.shopify_product_id = ? AND i.shopify_variant_id = ?",
      ).bind(itemId, String(line.product_id), String(line.variant_id)).first();
      if (!item || (item.shopify_order_id && item.shopify_order_id !== String(order.id))) continue;
      await env.SHOP_DB.batch([
        env.SHOP_DB.prepare("UPDATE designer_orders SET shopify_order_id = ? WHERE id = ? AND (shopify_order_id IS NULL OR shopify_order_id = ?)")
          .bind(String(order.id), item.order_id, String(order.id)),
        env.SHOP_DB.prepare(
          "UPDATE designer_order_items SET shopify_line_item_id = ? WHERE id = ? AND (shopify_line_item_id IS NULL OR shopify_line_item_id = ?) " +
          "AND EXISTS (SELECT 1 FROM designer_orders WHERE id = ? AND shopify_order_id = ?)",
        ).bind(String(line.id), itemId, String(line.id), item.order_id, String(order.id)),
      ]);
    }
    return json({ received: true });
  } catch (error) {
    console.error("A Shopify-rendelés feldolgozása sikertelen.", error);
    return errorResponse("A Shopify-rendelés feldolgozása sikertelen.", 500);
  }
}

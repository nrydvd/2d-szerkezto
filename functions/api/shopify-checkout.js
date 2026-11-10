import { configured, errorResponse, json, sameOrigin } from "../_shared/http.js";
import { storefront } from "../_shared/shopify.js";

export async function onRequestPost({ request, env }) {
  if (!configured(env)) return errorResponse("A tervek tárhelye nincs konfigurálva.", 503);
  if (!sameOrigin(request)) return errorResponse("Idegen webhelyről érkező kérés elutasítva.", 403);
  try {
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (!clientIp) return errorResponse("A kérés biztonságos korlátozása nem ellenőrizhető.", 429);
    const ipHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientIp))),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    const hourWindow = `${new Date().toISOString().slice(0, 13)}:00`;
    const allowance = await env.SHOP_DB.prepare(
      "INSERT INTO customer_upload_windows (ip_hash, hour_window, upload_count) VALUES (?, ?, 1) " +
      "ON CONFLICT(ip_hash, hour_window) DO UPDATE SET upload_count = upload_count + 1 " +
      "WHERE upload_count < 20 RETURNING upload_count",
    ).bind(ipHash, hourWindow).first();
    if (!allowance) return errorResponse("Erről a kapcsolatról most túl sok kérés érkezett. Próbáld újra később.", 429);
    const body = await request.json();
    if (typeof body?.itemId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.itemId)) {
      return errorResponse("A tervazonosító érvénytelen.", 400);
    }
    const item = await env.SHOP_DB.prepare(
      "SELECT id, shopify_product_id, shopify_variant_id, design_json FROM designer_order_items WHERE id = ?",
    ).bind(body.itemId).first();
    if (!item || !/^\d+$/.test(item.shopify_product_id ?? "") || !/^\d+$/.test(item.shopify_variant_id ?? "")) {
      return errorResponse("A vásárlásra előkészített terv nem található.", 404);
    }
    const result = await env.SHOP_DB.prepare("SELECT id, role FROM designer_order_files WHERE order_item_id = ?").bind(item.id).all();
    const files = result.results ?? [];
    const plan = files.find((file) => file.role === "plan");
    const preview = files.find((file) => file.role === "preview");
    const productions = files.filter((file) => file.role === "production-png");
    if (!plan || !preview || !productions.length) return errorResponse("A terv gyártási fájljai hiányoznak.", 409);
    const design = JSON.parse(item.design_json);
    const materialId = design.views?.[design.activeView]?.materialId;
    const origin = new URL(request.url).origin;
    const fileUrl = (file) => `${origin}/api/admin/designer-requests/files/${file.id}`;
    const attributes = [
      { key: "Designer tervazonosító", value: item.id },
      { key: "Anyag", value: materialId },
      { key: "Shopify termékazonosító", value: item.shopify_product_id },
      { key: "Shopify variánsazonosító", value: item.shopify_variant_id },
      { key: "Termékelőnézet", value: fileUrl(preview) },
      { key: "Szerkesztési terv", value: fileUrl(plan) },
      ...productions.map((file, index) => ({ key: `Gyártási PNG ${index + 1}`, value: fileUrl(file) })),
    ];
    if (typeof materialId !== "string") return errorResponse("A terv anyaga hiányzik.", 409);
    const variantId = `gid://shopify/ProductVariant/${item.shopify_variant_id}`;
    const productId = `gid://shopify/Product/${item.shopify_product_id}`;
    const data = await storefront(env, `mutation CreateCart($input: CartInput!) {
      cartCreate(input: $input) {
        cart { checkoutUrl lines(first: 1) { nodes { merchandise { ... on ProductVariant { id product { id } } } } } }
        userErrors { message } warnings { message }
      }
    }`, { input: { lines: [{ merchandiseId: variantId, quantity: 1, attributes }] } });
    const payload = data?.cartCreate;
    const merchandise = payload?.cart?.lines?.nodes?.[0]?.merchandise;
    if (payload?.userErrors?.length || payload?.warnings?.length || merchandise?.id !== variantId ||
        merchandise?.product?.id !== productId || !payload?.cart?.checkoutUrl ||
        new URL(payload.cart.checkoutUrl).protocol !== "https:") {
      return errorResponse("A Shopify nem fogadta el a megfelelő terméket és variánst. A terv megmaradt.", 502);
    }
    return json({ checkoutUrl: payload.cart.checkoutUrl });
  } catch (error) {
    console.error("A Shopify vásárlás előkészítése sikertelen.", error);
    return errorResponse("A Shopify vásárlás nem készíthető elő; ellenőrizd a Storefront kapcsolatot. A terv megmaradt.", 503);
  }
}

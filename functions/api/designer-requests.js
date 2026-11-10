import { configured, errorResponse, hasAdminAccess, hasImageSignature, json, safeFileName, sameOrigin } from "../_shared/http.js";
import { designerProductSlug, validateDesignerCatalog } from "../_shared/designer-catalog.js";
import { normalizeDesignPlan } from "../_shared/designer-plan.js";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const MAX_FILE_BYTES = 80 * 1024 * 1024;
const MAX_REQUEST_BYTES = 80 * 1024 * 1024;
const acceptedRoles = new Set(["plan", "preview", "view-png", "original-upload", "summary-pdf", "archive"]);

function isValidDesign(design, product, canvas) {
  if (!isRecord(design) || design.format !== "roli-2d-design" || design.version !== 1 ||
      design.profileId !== product.profile.id || design.productId !== product.profile.productId ||
      !isRecord(design.canvas) || design.canvas.width !== canvas.width || design.canvas.height !== canvas.height ||
      !Array.isArray(design.layers) || design.layers.length > 30) return false;
  const material = product.materials.find((entry) => entry.id === design.materialId && entry.layoutId === product.profile.id);
  if (!material) return false;
  return design.layers.every((layer) => isRecord(layer) &&
    (layer.type === "text" || layer.type === "image") &&
    typeof layer.id === "string" && layer.id.length > 0 && layer.id.length <= 100 &&
    [layer.x, layer.y, layer.width, layer.height, layer.rotation].every(Number.isFinite) &&
    layer.width > 0 && layer.height > 0 &&
    (layer.type !== "text" || typeof layer.text === "string" && layer.text.length <= (product.editorSettings?.maxTextLength ?? 200)) &&
    (layer.type !== "image" || typeof layer.src === "string" && layer.src.length <= 12 * 1024 * 1024));
}

function hasSignature(bytes, role, contentType) {
  if (role === "plan") return contentType === "application/json" && bytes[0] === 0x7b;
  if (role === "summary-pdf") return contentType === "application/pdf" && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (role === "archive") return contentType === "application/zip" && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (role !== "original-upload" && contentType !== "image/png") return false;
  return hasImageSignature(bytes, contentType);
}

function designSummary(plan) {
  const views = Object.fromEntries(Object.entries(plan.views).map(([key, design]) => [key, {
    materialId: design.materialId,
    ...(design.fabricColor ? { fabricColor: design.fabricColor } : {}),
    layers: design.layers.map((layer) => ({
      id: layer.id, type: layer.type, x: layer.x, y: layer.y, width: layer.width, height: layer.height,
      rotation: layer.rotation,
      ...(layer.type === "text" ? { text: layer.text } : { name: layer.name, ...(layer.pattern ? { pattern: layer.pattern } : {}) }),
    })),
  }]));
  return {
    format: plan.format, version: plan.version, profileId: plan.profileId, productId: plan.productId,
    activeView: plan.activeView, views,
  };
}

export async function onRequestPost({ request, env }) {
  if (!configured(env)) return errorResponse("A vásárlói igények tartós tárhelye nincs konfigurálva.", 503);
  if (!sameOrigin(request)) return errorResponse("Idegen webhelyről érkező kérés elutasítva.", 403);
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_REQUEST_BYTES) return errorResponse("A tervezési csomag túl nagy.", 413);
  const createdAssetIds = [];
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
    if (!allowance) return errorResponse("Erről a kapcsolatról most túl sok terv érkezett. Próbáld újra később.", 429);
    await env.SHOP_DB.prepare("DELETE FROM customer_upload_windows WHERE hour_window < ?")
      .bind(`${new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 13)}:00`).run();
    const form = await request.formData();
    const slug = form.get("productSlug");
    const files = form.getAll("files");
    const roles = form.getAll("roles");
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) ||
        !files.length || files.length > 160 || roles.length !== files.length ||
        files.some((file) => !(file instanceof File))) {
      return errorResponse("A termékazonosító vagy a fájllista érvénytelen.", 400);
    }
    const row = await env.SHOP_DB.prepare("SELECT payload FROM shop_state WHERE state_key = ?")
      .bind("designerProducts").first();
    if (!row) return errorResponse("A termékkatalógus nem található.", 404);
    const products = JSON.parse(row.payload);
    const catalogError = validateDesignerCatalog(products);
    if (catalogError) throw new Error("Érvénytelen termékkatalógus.");
    const product = products.find((entry) => entry.active && entry.editorSettings?.enabled2d !== false &&
      designerProductSlug(entry) === slug);
    if (!product) return errorResponse("A termék nem található vagy nem aktív.", 404);

    let totalBytes = 0;
    const preparedFiles = [];
    for (const [index, file] of files.entries()) {
      const fileRole = roles[index];
      if (!fileRole || !acceptedRoles.has(fileRole) || file.size < 1 || file.size > MAX_FILE_BYTES) {
        return errorResponse("A csomag egyik fájlja hiányzik vagy túl nagy.", 400);
      }
      totalBytes += file.size;
      if (totalBytes > MAX_REQUEST_BYTES) return errorResponse("A tervezési csomag túl nagy.", 413);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!hasSignature(bytes, fileRole, file.type)) return errorResponse(`Érvénytelen fájlformátum: ${safeFileName(file.name)}`, 415);
      preparedFiles.push({ role: fileRole, file, bytes, fileName: safeFileName(file.name) });
    }
    const planFile = preparedFiles.find((entry) => entry.role === "plan");
    if (!planFile || preparedFiles.filter((entry) => entry.role === "plan").length !== 1) {
      return errorResponse("A szerkesztési terv JSON-fájlja hiányzik vagy ismétlődik.", 400);
    }
    let plan;
    try { plan = JSON.parse(new TextDecoder().decode(planFile.bytes)); }
    catch { return errorResponse("A szerkesztési terv JSON-fájlja hibás.", 400); }
    const normalizedPlan = normalizeDesignPlan(plan, product, isValidDesign);
    if (!normalizedPlan) return errorResponse("A terv nézetei nem ehhez az aktív termékhez tartoznak.", 400);
    const expectedViews = Object.keys(normalizedPlan.views).length;
    if (preparedFiles.filter((entry) => entry.role === "preview").length !== 1 ||
        preparedFiles.filter((entry) => entry.role === "view-png").length !== expectedViews - 1 ||
        preparedFiles.filter((entry) => entry.role === "summary-pdf").length !== 1 ||
        preparedFiles.filter((entry) => entry.role === "archive").length !== 1) {
      return errorResponse("A terméknézetek vagy az összesítő fájlok hiányosak.", 400);
    }

    const orderId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    for (const entry of preparedFiles) {
      entry.assetId = crypto.randomUUID();
      await env.SHOP_ASSETS.put(entry.assetId, entry.bytes, {
        httpMetadata: { contentType: entry.file.type },
        customMetadata: { fileName: entry.fileName, purpose: "customer-artwork", orderItemId: itemId },
      });
      createdAssetIds.push(entry.assetId);
    }
    const statements = [
      env.SHOP_DB.prepare("INSERT INTO designer_orders (id, shopify_order_id) VALUES (?, NULL)").bind(orderId),
      env.SHOP_DB.prepare(
        "INSERT INTO designer_order_items (id, order_id, shopify_line_item_id, shopify_product_id, shopify_variant_id, designer_product_id, product_name, design_json) " +
        "VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?)",
      ).bind(itemId, orderId, product.profile.productId, product.profile.name, JSON.stringify(designSummary(normalizedPlan))),
    ];
    for (const entry of preparedFiles) {
      statements.push(
        env.SHOP_DB.prepare("INSERT INTO shop_assets (id, file_name, content_type, byte_length, purpose) VALUES (?, ?, ?, ?, 'customer-artwork')")
          .bind(entry.assetId, entry.fileName, entry.file.type, entry.file.size),
        env.SHOP_DB.prepare(
          "INSERT INTO designer_order_files (id, order_item_id, asset_id, role, file_name, content_type, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), itemId, entry.assetId, entry.role, entry.fileName, entry.file.type, entry.file.size),
      );
    }
    await env.SHOP_DB.batch(statements);
    return json({ saved: true });
  } catch (error) {
    await Promise.all(createdAssetIds.map(async (id) => {
      try { await env.SHOP_ASSETS.delete(id); }
      catch (cleanupError) { console.error("A félbemaradt vásárlói fájl nem törölhető az R2-tárból.", cleanupError); }
    }));
    console.error("A vásárlói igénycsomag mentése nem sikerült.", error);
    return errorResponse("A tervezési csomagot nem sikerült tartósan elmenteni.", 500);
  }
}

export async function onRequestGet({ request, env }) {
  if (!configured(env)) return errorResponse("A vásárlói igények tárhelye nincs konfigurálva.", 503);
  if (!await hasAdminAccess(request, env)) return errorResponse("A vásárlói igényekhez adminisztrátori belépés szükséges.", 401);
  try {
    const result = await env.SHOP_DB.prepare(
      "SELECT o.id AS order_id, o.shopify_order_id, o.created_at AS order_created_at, " +
      "i.id AS item_id, i.shopify_line_item_id, i.shopify_product_id, i.shopify_variant_id, " +
      "i.designer_product_id, i.product_name, i.design_json, i.created_at AS item_created_at, " +
      "f.id AS file_id, f.role, f.file_name, f.content_type, f.byte_length " +
      "FROM designer_orders o JOIN designer_order_items i ON i.order_id = o.id " +
      "LEFT JOIN designer_order_files f ON f.order_item_id = i.id " +
      "ORDER BY o.created_at DESC LIMIT 5000",
    ).all();
    const orders = new Map();
    for (const row of result.results ?? []) {
      let order = orders.get(row.order_id);
      if (!order) {
        order = { id: row.order_id, shopifyOrderId: row.shopify_order_id, createdAt: row.order_created_at, items: new Map() };
        orders.set(row.order_id, order);
      }
      let item = order.items.get(row.item_id);
      if (!item) {
        item = {
          id: row.item_id, shopifyLineItemId: row.shopify_line_item_id,
          shopifyProductId: row.shopify_product_id, shopifyVariantId: row.shopify_variant_id,
          designerProductId: row.designer_product_id, productName: row.product_name,
          design: JSON.parse(row.design_json), files: [],
        };
        order.items.set(row.item_id, item);
      }
      if (row.file_id) item.files.push({
        id: row.file_id, role: row.role, name: row.file_name, contentType: row.content_type, size: row.byte_length,
      });
    }
    return json({ orders: [...orders.values()].map((order) => ({
      ...order, items: [...order.items.values()],
    })) });
  } catch (error) {
    console.error("A vásárlói igények betöltése nem sikerült.", error);
    return errorResponse("A vásárlói igények nem tölthetők be.", 500);
  }
}

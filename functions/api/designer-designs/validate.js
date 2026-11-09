import { configured, errorResponse, json } from "../../_shared/http.js";
import { designerProductSlug, validateDesignerCatalog } from "../../_shared/designer-catalog.js";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const viewKeys = ["front", "back", "right", "left"];

function validViewDesign(design, product, canvas) {
  if (!isRecord(design)) return false;
  const material = product.materials.find((item) => item.id === design.materialId && item.layoutId === product.profile.id);
  return design.format === "roli-2d-design" && design.version === 1 &&
    design.profileId === product.profile.id && design.productId === product.profile.productId && Boolean(material) &&
    isRecord(design.canvas) && isRecord(canvas) && design.canvas.width === canvas.width &&
    design.canvas.height === canvas.height && Array.isArray(design.layers) && design.layers.length <= 30;
}

export async function onRequestPost({ request, env }) {
  if (!configured(env)) return errorResponse("A központi terméktár nincs konfigurálva.", 503);
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 40 * 1024 * 1024) return errorResponse("A tervfájl túl nagy.", 413);
    let data;
    try { data = JSON.parse(body); } catch { return errorResponse("A kérés nem érvényes JSON.", 400); }
    if (!isRecord(data) || typeof data.slug !== "string" || !isRecord(data.design)) {
      return errorResponse("A termékazonosító vagy a terv hiányzik.", 400);
    }

    const row = await env.SHOP_DB.prepare("SELECT payload FROM shop_state WHERE state_key = ?")
      .bind("designerProducts").first();
    if (!row) return errorResponse("A termékkatalógus nem található.", 404);
    const products = JSON.parse(row.payload);
    const catalogError = validateDesignerCatalog(products);
    if (catalogError) throw new Error("Érvénytelen termékkatalógus.");
    const product = products.find((item) => item.active && item.editorSettings?.enabled2d !== false &&
      designerProductSlug(item) === data.slug);
    if (!product) return errorResponse("A termék nem található vagy nem aktív.", 404);

    const design = data.design;
    let valid = false;
    if (design.version === 1) {
      valid = validViewDesign(design, product, product.profile.canvas);
    } else if (design.version === 2 && design.format === "roli-2d-design" &&
        design.profileId === product.profile.id && design.productId === product.profile.productId &&
        typeof design.activeView === "string" && viewKeys.includes(design.activeView) &&
        isRecord(design.views) && Object.keys(design.views).length > 0 &&
        Object.keys(design.views).length <= viewKeys.length && design.views[design.activeView]) {
      const savedViews = Object.entries(design.views);
      valid = savedViews.every(([key, saved]) => {
        if (!viewKeys.includes(key)) return false;
        const view = product.profile.views?.[key];
        const configured = view?.photo && view.fabricMask && view.surfaceMask;
        return Boolean(configured && validViewDesign(saved, product, view.canvas));
      });
    }
    if (!valid) {
      return errorResponse("A terv nem tartozik a kiválasztott termékhez vagy érvénytelen.", 400);
    }
    return json({ verified: true });
  } catch (error) {
    console.error("A termékterv ellenőrzése sikertelen.", error);
    return errorResponse("A termékterv nem ellenőrizhető.", 500);
  }
}

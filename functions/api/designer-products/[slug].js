import { configured, errorResponse, json } from "../../_shared/http.js";
import { designerProductSlug, validateDesignerCatalog } from "../../_shared/designer-catalog.js";

export async function onRequestGet({ env, params }) {
  if (!configured(env)) return errorResponse("A központi terméktár nincs konfigurálva.", 503);
  try {
    const row = await env.SHOP_DB.prepare("SELECT payload FROM shop_state WHERE state_key = ?")
      .bind("designerProducts").first();
    if (!row) return errorResponse("A termék nem található vagy nem aktív.", 404);
    const products = JSON.parse(row.payload);
    if (validateDesignerCatalog(products)) throw new Error("Érvénytelen termékkatalógus.");
    const product = products.find((item) => item.active && item.editorSettings?.enabled2d !== false &&
      designerProductSlug(item) === params.slug);
    return product ? json({ product }) : errorResponse("A termék nem található vagy nem aktív.", 404);
  } catch (error) {
    console.error("A termékprofil betöltése sikertelen.", error);
    return errorResponse("A termékprofil nem tölthető be.", 500);
  }
}

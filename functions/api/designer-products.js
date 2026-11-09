import { configured, errorResponse, json } from "../_shared/http.js";
import { validateDesignerCatalog } from "../_shared/designer-catalog.js";

export async function onRequestGet({ env }) {
  if (!configured(env)) return errorResponse("A központi terméktár nincs konfigurálva.", 503);
  try {
    const row = await env.SHOP_DB.prepare("SELECT payload FROM shop_state WHERE state_key = ?").bind("designerProducts").first();
    if (!row) return json({ products: null });
    const products = JSON.parse(row.payload);
    if (validateDesignerCatalog(products)) throw new Error("Érvénytelen termékkatalógus.");
    return json({ products: products.filter((product) => product.active) });
  } catch (error) {
    console.error("A tervező termékeinek betöltése sikertelen.", error);
    return errorResponse("A termékkatalógus nem tölthető be.", 500);
  }
}

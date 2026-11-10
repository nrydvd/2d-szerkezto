import { configured, errorResponse, json } from "../_shared/http.js";
import { designerProductSlug, validateDesignerCatalog } from "../_shared/designer-catalog.js";
import { shopifyMapping, storefront } from "../_shared/shopify.js";

export async function onRequestGet({ request, env }) {
  if (!configured(env)) return errorResponse("A terméktár nincs konfigurálva.", 503);
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return errorResponse("A termékazonosító érvénytelen.", 400);
  try {
    const row = await env.SHOP_DB.prepare("SELECT payload FROM shop_state WHERE state_key = ?").bind("designerProducts").first();
    const products = row && JSON.parse(row.payload);
    if (!products || validateDesignerCatalog(products)) return errorResponse("A termékkatalógus nem érhető el.", 503);
    const product = products.find((entry) => entry.active && designerProductSlug(entry) === slug);
    if (!product) return errorResponse("A termék nem található.", 404);
    const mappings = product.materials.flatMap((material) => {
      const mapping = shopifyMapping(product, slug, material.id);
      return mapping ? [{ materialId: material.id, ...mapping }] : [];
    });
    if (!mappings.length) return json({ prices: {} });
    const data = await storefront(env, `query VariantPrices($ids: [ID!]!) {
      nodes(ids: $ids) { ... on ProductVariant { id availableForSale price { amount currencyCode } product { id } } }
    }`, { ids: mappings.map((mapping) => `gid://shopify/ProductVariant/${mapping.variantId}`) });
    const prices = {};
    for (const [index, mapping] of mappings.entries()) {
      const variant = data?.nodes?.[index];
      if (variant?.id === `gid://shopify/ProductVariant/${mapping.variantId}` &&
          variant.product?.id === `gid://shopify/Product/${mapping.productId}` && variant.availableForSale &&
          typeof variant.price?.amount === "string" && /^[A-Z]{3}$/.test(variant.price?.currencyCode ?? "")) {
        prices[mapping.materialId] = variant.price;
      }
    }
    return json({ prices });
  } catch (error) {
    console.error("A Shopify-árak betöltése sikertelen.", error);
    return errorResponse("A Shopify-árak jelenleg nem érhetők el.", 503);
  }
}

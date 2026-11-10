const PRODUCTS = {
  "noi-neszeszer": {
    productId: "11336351154513",
    variants: { gyongyvaszon: "55685298749777", szaten: "55685298782545" },
  },
};

export function shopifyMapping(product, slug, materialId) {
  const material = product.materials.find((entry) => entry.id === materialId);
  if (!material) return null;
  const fallback = PRODUCTS[slug];
  const productId = product.shopifyProductId || fallback?.productId;
  const variantId = material.shopifyVariantId || (productId === fallback?.productId ? fallback?.variants[materialId] : undefined);
  if (!/^\d+$/.test(productId ?? "") || !/^\d+$/.test(variantId ?? "")) return null;
  return { productId, variantId, materialName: material.name };
}

export async function storefront(env, query, variables) {
  const domain = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
  if (typeof domain !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) || !token) {
    throw new Error("A Shopify Storefront kapcsolat nincs konfigurálva.");
  }
  const response = await fetch(`https://${domain}/api/2026-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`A Shopify Storefront API nem érhető el (${response.status}).`);
  const result = await response.json();
  if (result.errors?.length) throw new Error("A Shopify Storefront API hibát jelzett.");
  return result.data;
}

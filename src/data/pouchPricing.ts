export interface ProductPriceList {
  productId: string;
  materialPricesHuf: Readonly<Record<string, number>>;
}

export const POUCH_PRICE_LISTS: readonly ProductPriceList[] = [
  { productId: "womens-pouch", materialPricesHuf: { gyongyvaszon: 5490, szaten: 5990 } },
  { productId: "mens-pouch", materialPricesHuf: { gyongyvaszon: 6490, szaten: 6990 } },
];

export interface PriceQuote {
  productId: string;
  materialId: string;
  currency: "HUF";
  finalPriceHuf: number;
}

export function getPouchPrice(productId: string, materialId: string): PriceQuote {
  const prices = POUCH_PRICE_LISTS.find((entry) => entry.productId === productId)?.materialPricesHuf;
  const price = prices && Object.hasOwn(prices, materialId) ? prices[materialId] : undefined;
  if (price === undefined || !Number.isSafeInteger(price) || price < 0) {
    throw new Error("A termék és anyag kombinációjához nem áll rendelkezésre érvényes ár.");
  }
  return { productId, materialId, currency: "HUF", finalPriceHuf: price };
}

export function formatPrice(priceHuf: number): string {
  const grouped = priceHuf.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return `${grouped} Ft`;
}

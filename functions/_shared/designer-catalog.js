const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 120) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const id = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value);
const color = (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const image = (value, local) => typeof value === "string" && value.length <= 12000 &&
  (value === "" || /^\/images\/[a-zA-Z0-9/_.-]+$/.test(value) ||
    /^\/api\/assets\/[a-f0-9-]{36}$/.test(value) ||
    (local && /^local:[a-f0-9-]{36}$/.test(value)) ||
    /^data:image\/svg\+xml;utf8,/.test(value));
const viewKeys = ["front", "back", "right", "left"];
const validDimensions = (value) => record(value) &&
  Number.isSafeInteger(value.width) && value.width >= 100 && value.width <= 10000 &&
  Number.isSafeInteger(value.height) && value.height >= 100 && value.height <= 10000;

function validView(view, local) {
  if (!record(view) || !Array.isArray(view.photos) || view.photos.length > 100 ||
      !view.photos.every((photo) => record(photo) && id(photo.id) && text(photo.name, 200) && image(photo.url, local) &&
        (photo.width === undefined || Number.isSafeInteger(photo.width) && photo.width >= 1 && photo.width <= 10000) &&
        (photo.height === undefined || Number.isSafeInteger(photo.height) && photo.height >= 1 && photo.height <= 10000)) ||
      new Set(view.photos.map((photo) => photo.id)).size !== view.photos.length ||
      (view.referencePhotoId !== undefined && (!id(view.referencePhotoId) ||
        !view.photos.some((photo) => photo.id === view.referencePhotoId))) ||
      !image(view.photo, local) || !image(view.fabricMask, local) || !image(view.surfaceMask, local) ||
      !Array.isArray(view.protectMasks) || view.protectMasks.length > 30 ||
      !view.protectMasks.every((mask) => record(mask) && id(mask.id) && text(mask.label) && image(mask.url, local)) ||
      new Set(view.protectMasks.map((mask) => mask.id)).size !== view.protectMasks.length ||
      (view.canvas !== undefined && !validDimensions(view.canvas))) return false;
  if (!view.photo) return !view.referencePhotoId;
  const photo = view.photos.find((item) => item.id === view.referencePhotoId);
  return Boolean(photo && photo.url === view.photo);
}

export function designerProductSlug(product) {
  return product.slug ?? (product.profile.productId === "womens-pouch" ? "noi-neszeszer" : product.profile.productId);
}

export function validateDesignerCatalog(products, local = false) {
  if (!Array.isArray(products) || products.length > 200) return "A terméklista érvénytelen vagy túl nagy.";
  const ids = new Set();
  const profiles = new Set();
  const slugs = new Set();
  for (const product of products) {
    if (!record(product) || !record(product.profile) || typeof product.active !== "boolean" ||
        !Array.isArray(product.materials) || product.materials.length > 30) return "Érvénytelen termékadatok.";
    const p = product.profile;
    if (!id(p.id) || !id(p.productId) || !text(p.name) || ids.has(p.productId) || profiles.has(p.id)) {
      return "A termék neve és egyedi termék- és profilazonosítója kötelező.";
    }
    ids.add(p.productId);
    profiles.add(p.id);
    const slug = designerProductSlug(product);
    if (!id(slug) || slugs.has(slug)) return "A termék URL-azonosítója érvénytelen vagy már foglalt.";
    slugs.add(slug);
    if (!record(p.canvas) || !record(p.area) ||
        ![p.canvas.width, p.canvas.height, p.area.x, p.area.y, p.area.width, p.area.height].every(Number.isFinite) ||
        p.canvas.width < 100 || p.canvas.width > 10000 || p.canvas.height < 100 || p.canvas.height > 10000 ||
        p.area.x < 0 || p.area.y < 0 || p.area.width <= 0 || p.area.height <= 0 ||
        p.area.x + p.area.width > p.canvas.width || p.area.y + p.area.height > p.canvas.height) {
      return "A vászon vagy a szerkeszthető terület érvénytelen.";
    }
    if (![p.photo, p.fabricMask, p.surfaceMask].every((v) => image(v, local)) ||
        (product.active && (!p.views && (!p.photo || !p.fabricMask || !p.surfaceMask) || !product.materials.length))) {
      return "Aktiváláshoz termékfotó, két maszk és legalább egy anyag szükséges.";
    }
    if (p.photos !== undefined && (!Array.isArray(p.photos) || p.photos.length > 100 ||
        !p.photos.every((photo) => record(photo) && id(photo.id) && text(photo.name, 200) && image(photo.url, local)) ||
        new Set(p.photos.map((photo) => photo.id)).size !== p.photos.length ||
        (p.photo && !p.photos.some((photo) => photo.url === p.photo)))) {
      return "A termékfotók vagy a kiválasztott referenciafotó érvénytelen.";
    }
    if (p.views !== undefined && (!record(p.views) ||
        Object.keys(p.views).some((key) => !viewKeys.includes(key)) ||
        Object.keys(p.views).length > viewKeys.length ||
        Object.values(p.views).some((view) => !validView(view, local)))) {
      return "A terméknézetek képei, referenciafotói vagy maszkjai érvénytelenek.";
    }
    if (p.views) {
      const configured = viewKeys.map((key) => p.views[key]).filter((view) =>
        view?.photo && view.fabricMask && view.surfaceMask && validDimensions(view.canvas));
      if (product.active && !configured.length) return "Aktiváláshoz legalább egy teljesen konfigurált nézet szükséges.";
      for (const view of configured) {
        const reference = view.photos.find((photo) => photo.id === view.referencePhotoId);
        if (!reference || reference.width !== view.canvas.width || reference.height !== view.canvas.height) {
          return "A nézet vásznának meg kell egyeznie a referenciafotó természetes képméretével.";
        }
      }
    }
    if (p.protectMasks !== undefined && (!Array.isArray(p.protectMasks) || p.protectMasks.length > 30 ||
        !p.protectMasks.every((mask) => record(mask) && id(mask.id) && text(mask.label) && image(mask.url, local)) ||
        new Set(p.protectMasks.map((mask) => mask.id)).size !== p.protectMasks.length)) {
      return "A védőmaszkok adatai érvénytelenek.";
    }
    if (p.areas !== undefined && (!record(p.areas) ||
        !["color", "pattern", "protect"].every((key) => p.areas[key] === undefined || (typeof p.areas[key] === "string" && p.areas[key].length <= 300)))) {
      return "A termékterületek belső jegyzetei érvénytelenek.";
    }
    if (product.description !== undefined && (typeof product.description !== "string" || product.description.length > 500)) {
      return "A termékleírás legfeljebb 500 karakter lehet.";
    }
    if (product.shopifyProductId !== undefined && !text(product.shopifyProductId, 200)) {
      return "A Shopify-termékazonosító érvénytelen.";
    }
    if (product.editorSettings !== undefined) {
      const settings = product.editorSettings;
      if (!record(settings) || typeof settings.customText !== "boolean" ||
          !Number.isSafeInteger(settings.maxTextLength) || settings.maxTextLength < 1 || settings.maxTextLength > 200 ||
          typeof settings.imageUpload !== "boolean" ||
          !Number.isSafeInteger(settings.maxUploadBytes) || settings.maxUploadBytes < 1 || settings.maxUploadBytes > 5 * 1024 * 1024 ||
          typeof settings.enabled2d !== "boolean") {
        return "A termékszerkesztő beállításai érvénytelenek.";
      }
    }
    if (product.active && product.editorSettings?.enabled2d === false) {
      return "A 2D szerkesztés nélkül a termék nem aktiválható.";
    }
    const materialIds = new Set();
    for (const m of product.materials) {
      if (!record(m) || !id(m.id) || materialIds.has(m.id) || !text(m.name) ||
          m.layoutId !== p.id ||
          (m.priceHuf !== undefined && (!Number.isSafeInteger(m.priceHuf) || m.priceHuf < 0)) ||
          (m.shopifyVariantId !== undefined && !text(m.shopifyVariantId, 200)) ||
          !image(m.previewUrl, local) || !image(m.textureUrl, local) ||
          !record(m.preview) || m.preview.photoUrl !== p.photo || m.preview.colorMaskUrl !== p.fabricMask ||
          m.preview.surfaceMaskUrl !== p.surfaceMask || typeof m.preview.applyTexture !== "boolean" ||
          !["tile", "cover-luminance", "satin-soft"].includes(m.preview.textureMapping) ||
          !color(m.preview.baseColor) || (m.preview.applyTexture && !m.textureUrl) ||
          !Array.isArray(m.colors) || m.colors.length > 100 ||
          !m.colors.every((c) => record(c) && text(c.name) && color(c.color) && (c.active === undefined || typeof c.active === "boolean")) ||
          !Array.isArray(m.patterns) || m.patterns.length > 100) return "Az anyag vagy az ára érvénytelen.";
      if (m.shopifyVariantId && !product.shopifyProductId) return "A Shopify-variánshoz Shopify-termékazonosító szükséges.";
      materialIds.add(m.id);
      if (product.active && !m.colors.some((entry) => entry.active !== false)) {
        return "Aktiváláshoz minden anyaghoz legalább egy aktív szín szükséges.";
      }
      const patternIds = new Set();
      for (const pattern of m.patterns) {
        if (!record(pattern) || !id(pattern.id) || patternIds.has(pattern.id) || !text(pattern.name) ||
            typeof pattern.active !== "boolean" || !image(pattern.previewUrl, local) || !pattern.previewUrl ||
            !Array.isArray(pattern.variants) || !pattern.variants.length || pattern.variants.length > 30) {
          return "A minta adatai érvénytelenek.";
        }
        patternIds.add(pattern.id);
        const variantIds = new Set();
        for (const v of pattern.variants) {
          if (!record(v) || !id(v.id) || variantIds.has(v.id) || !text(v.name) || !color(v.color) ||
              !image(v.previewUrl, local) || !v.previewUrl || !image(v.imageUrl, local) || !v.imageUrl) {
            return "A mintaváltozat adatai érvénytelenek.";
          }
          variantIds.add(v.id);
        }
      }
    }
  }
  return null;
}

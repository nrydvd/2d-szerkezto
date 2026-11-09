import { loadLocalAssetBlob } from "../data/designer-assets";
import { designerProductSlug, readLocalCatalogForExport, uploadCatalogImage, type EditorProduct } from "../designer-prototype/catalog";
import { decodeImage, readDataUrl, validateImage } from "../designer-prototype/model";
import { validateDesignerCatalog } from "../../functions/_shared/designer-catalog.js";

const LIMIT = 150 * 1024 * 1024;
const localReference = /^local:([a-f0-9-]{36})$/;

function mapAssetReferences(products: EditorProduct[], map: (input: string) => string): EditorProduct[] {
  return products.map((product) => ({
    ...product,
    profile: {
      ...product.profile,
      photo: map(product.profile.photo),
      fabricMask: map(product.profile.fabricMask),
      surfaceMask: map(product.profile.surfaceMask),
      photos: product.profile.photos?.map((photo) => ({ ...photo, url: map(photo.url) })),
      protectMasks: product.profile.protectMasks?.map((mask) => ({ ...mask, url: map(mask.url) })),
    },
    materials: product.materials.map((material) => ({
      ...material,
      previewUrl: map(material.previewUrl),
      textureUrl: map(material.textureUrl),
      preview: {
        ...material.preview,
        photoUrl: map(material.preview.photoUrl),
        colorMaskUrl: map(material.preview.colorMaskUrl),
        surfaceMaskUrl: map(material.preview.surfaceMaskUrl),
      },
      patterns: material.patterns.map((pattern) => ({
        ...pattern,
        previewUrl: map(pattern.previewUrl),
        variants: pattern.variants.map((variant) => ({
          ...variant, previewUrl: map(variant.previewUrl), imageUrl: map(variant.imageUrl),
        })),
      })),
    })),
  }));
}

export async function exportLocalCatalog(): Promise<void> {
  const products = readLocalCatalogForExport();
  const ids = new Set<string>();
  mapAssetReferences(products, (value) => {
    if (value.startsWith("/api/assets/")) throw new Error("A helyi katalógus távoli fájlokra hivatkozik; ezeket előbb külön kell migrálni.");
    const match = localReference.exec(value); if (match) ids.add(match[1]); return value;
  });
  const assets: Record<string, string> = {};
  for (const id of ids) {
    const blob = await loadLocalAssetBlob(id);
    const file = new File([blob], `${id}.png`, { type: blob.type });
    await validateImage(file);
    assets[id] = await readDataUrl(file);
  }
  const archive = new Blob([JSON.stringify({ format: "roli-designer-migration", version: 1, products, assets })], { type: "application/json" });
  if (archive.size > LIMIT) throw new Error("A mentés túl nagy (legfeljebb 150 MB).");
  const url = URL.createObjectURL(archive);
  const link = document.createElement("a");
  link.href = url;
  link.download = "roli-termekek-atvitel.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importLocalCatalog(file: File, current: EditorProduct[], emptyStore: boolean): Promise<EditorProduct[]> {
  if (file.size > LIMIT) throw new Error("Az átviteli fájl legfeljebb 150 MB lehet.");
  const data: unknown = JSON.parse(await file.text());
  if (!data || typeof data !== "object" || !("format" in data) || data.format !== "roli-designer-migration" ||
      !("version" in data) || data.version !== 1 || !("products" in data) || !Array.isArray(data.products) ||
      !("assets" in data) || !data.assets || typeof data.assets !== "object" || Array.isArray(data.assets)) {
    throw new Error("Az átviteli fájl formátuma érvénytelen.");
  }
  const invalid = validateDesignerCatalog(data.products, true);
  if (invalid) throw new Error(invalid);
  const incoming: EditorProduct[] = data.products;
  const base = emptyStore
    ? current.filter((item) => !incoming.some((product) => product.profile.productId === item.profile.productId))
    : current;
  const additions: EditorProduct[] = [];
  for (const product of incoming) {
    const old = base.find((item) =>
      item.profile.productId === product.profile.productId || item.profile.id === product.profile.id ||
      designerProductSlug(item) === designerProductSlug(product));
    if (old) {
      if (JSON.stringify(old) !== JSON.stringify(product)) {
        throw new Error(`Ütközés: „${product.profile.name}” már létezik eltérő adatokkal. A rendszer nem írja felül.`);
      }
    } else additions.push(product);
  }
  const mergedError = validateDesignerCatalog([...base, ...additions], true);
  if (mergedError) throw new Error(mergedError);
  const ids = new Set<string>();
  mapAssetReferences(additions, (value) => {
    if (value.startsWith("/api/assets/")) throw new Error("Az átviteli fájl idegen központi tárhelyre hivatkozik.");
    const match = localReference.exec(value); if (match) ids.add(match[1]); return value;
  });
  const files = new Map<string, File>();
  for (const id of ids) {
    const encoded = (data.assets as Record<string, unknown>)[id];
    if (typeof encoded !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error(`Hiányzó vagy érvénytelen képfájl: ${id}.`);
    }
    const [header, base64] = encoded.split(",");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const image = new File([bytes], `${id}.${header.includes("jpeg") ? "jpg" : header.includes("webp") ? "webp" : "png"}`, { type: header.slice(5, header.indexOf(";")) });
    await validateImage(image);
    const url = URL.createObjectURL(image);
    try { await decodeImage(url); } finally { URL.revokeObjectURL(url); }
    files.set(id, image);
  }
  const urls = new Map<string, string>();
  for (const [id, image] of files) urls.set(id, await uploadCatalogImage(image));
  const transformed = mapAssetReferences(additions, (value) => {
    const match = localReference.exec(value);
    if (!match) return value;
    const replacement = urls.get(match[1]);
    if (!replacement) throw new Error("Az egyik képfájl feltöltése hiányzik.");
    return replacement;
  });
  return [...base, ...transformed];
}

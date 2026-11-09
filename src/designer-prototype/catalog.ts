import {
  EDITOR_VIEW_KEYS, legacyFrontView, pouchProfile, type EditorProfile, type EditorView, type EditorViewKey,
} from "./profile.ts";
import { MATERIALS, type EditorMaterial } from "./materials.ts";
import { loadAssetUrl, saveAsset } from "../data/designer-assets.ts";
import { designerProductSlug, validateDesignerCatalog } from "../../functions/_shared/designer-catalog.js";
export { designerProductSlug } from "../../functions/_shared/designer-catalog.js";

export interface CatalogMaterial extends EditorMaterial {
  priceHuf?: number;
  shopifyVariantId?: string;
}

export interface EditorSettings {
  customText: boolean;
  maxTextLength: number;
  imageUpload: boolean;
  maxUploadBytes: number;
  enabled2d: boolean;
}

export interface EditorProduct {
  slug?: string;
  shopifyProductId?: string;
  description?: string;
  profile: EditorProfile;
  active: boolean;
  materials: CatalogMaterial[];
  editorSettings?: EditorSettings;
}

export const initialCatalog: EditorProduct[] = [{
  profile: pouchProfile,
  active: true,
  materials: MATERIALS.map((material, index) => ({
    ...material, priceHuf: index === 0 ? 5490 : 5990,
  })),
}];

export function editorProductViews(profile: EditorProfile): Partial<Record<EditorViewKey, EditorView>> {
  if (profile.views) return profile.views;
  return profile.photo ? { front: legacyFrontView(profile) } : {};
}

export function configuredEditorViews(profile: EditorProfile): EditorViewKey[] {
  const views = editorProductViews(profile);
  return EDITOR_VIEW_KEYS.filter((key) => {
    const view = views[key];
    return Boolean(view?.photo && view.fabricMask && view.surfaceMask);
  });
}

const LOCAL_KEY = "roli-designer-catalog-v1";
let adminRevision: string | null | undefined;

export function hasStoredCatalog(): boolean {
  return adminRevision !== null;
}

export function readLocalCatalogForExport(): EditorProduct[] {
  const raw = localStorage.getItem(LOCAL_KEY);
  if (raw === null) throw new Error("Ebben a böngészőben nincs mentett helyi termékkatalógus.");
  const value: unknown = JSON.parse(raw);
  const error = validateDesignerCatalog(value, true);
  if (!Array.isArray(value) || error) throw new Error(error ?? "A helyi katalógus érvénytelen.");
  return value as EditorProduct[];
}

async function responseError(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  return new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error : `A termékkatalógus nem érhető el (${response.status}).`);
}

export async function readCatalog(admin = false): Promise<EditorProduct[]> {
  let value: unknown;
  if (import.meta.env.DEV) {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (admin) adminRevision = raw;
    value = raw === null ? null : JSON.parse(raw);
  } else {
    const response = await fetch(admin ? "/api/admin/designer-products" : "/api/designer-products", { cache: "no-store" });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { products: unknown; revision?: unknown };
    if (admin) {
      if (body.revision !== null && typeof body.revision !== "string") throw new Error("A katalógus verziója érvénytelen.");
      adminRevision = body.revision;
    }
    value = body.products;
  }
  if (value === null) return structuredClone(initialCatalog);
  if (!Array.isArray(value) || validateDesignerCatalog(value, import.meta.env.DEV)) throw new Error("A termékkatalógus formátuma érvénytelen.");
  return value as EditorProduct[];
}

export async function readDesignerProduct(slug: string): Promise<EditorProduct | null> {
  if (import.meta.env.DEV) {
    const products = await readCatalog();
    return products.find((product) => product.active && designerProductSlug(product) === slug) ?? null;
  }
  const response = await fetch(`/api/designer-products/${encodeURIComponent(slug)}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw await responseError(response);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("product" in body) ||
      validateDesignerCatalog([body.product])) {
    throw new Error("A termékprofil formátuma érvénytelen.");
  }
  return body.product as EditorProduct;
}

export async function writeCatalog(products: EditorProduct[]): Promise<void> {
  const error = validateDesignerCatalog(products, import.meta.env.DEV);
  if (error) throw new Error(error);
  if (adminRevision === undefined) throw new Error("A mentés előtt az adminnak be kell töltenie a termékkatalógust.");
  if (import.meta.env.DEV) {
    if (localStorage.getItem(LOCAL_KEY) !== adminRevision) throw new Error("A katalógus egy másik lapon megváltozott. A mentéshez töltsd újra az oldalt.");
    const payload = JSON.stringify(products);
    localStorage.setItem(LOCAL_KEY, payload);
    adminRevision = payload;
  } else {
    const response = await fetch("/api/admin/designer-products", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ products, revision: adminRevision }),
    });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { revision?: unknown };
    if (typeof body.revision !== "string") throw new Error("A mentett katalógus verziója nem olvasható; töltsd újra az oldalt.");
    adminRevision = body.revision;
  }
}

export async function uploadCatalogImage(file: File): Promise<string> {
  const id = await saveAsset(file, file.name);
  return import.meta.env.DEV ? `local:${id}` : `/api/assets/${id}`;
}

export async function resolveCatalog(products: EditorProduct[]): Promise<{ products: EditorProduct[]; dispose: () => void }> {
  const urls = new Map<string, Promise<string>>();
  const resolve = async (value: string): Promise<string> => {
    if (!value.startsWith("local:")) return value;
    let url = urls.get(value);
    if (!url) {
      url = loadAssetUrl(value.slice(6));
      urls.set(value, url);
    }
    return url;
  };
  try {
    const resolved = await Promise.all(products.map(async (product) => ({
      ...product,
      profile: {
        ...product.profile,
        photo: await resolve(product.profile.photo),
        fabricMask: await resolve(product.profile.fabricMask),
        surfaceMask: await resolve(product.profile.surfaceMask),
        photos: await Promise.all((product.profile.photos ?? []).map(async (photo) => ({
          ...photo, url: await resolve(photo.url),
        }))),
        protectMasks: await Promise.all((product.profile.protectMasks ?? []).map(async (mask) => ({
          ...mask, url: await resolve(mask.url),
        }))),
        ...(product.profile.views ? { views: Object.fromEntries(await Promise.all(
          Object.entries(product.profile.views ?? {}).map(async ([key, view]) => [key, {
            ...view,
            photo: await resolve(view.photo),
            photos: await Promise.all(view.photos.map(async (photo) => ({ ...photo, url: await resolve(photo.url) }))),
            fabricMask: await resolve(view.fabricMask),
            surfaceMask: await resolve(view.surfaceMask),
            protectMasks: await Promise.all(view.protectMasks.map(async (mask) => ({ ...mask, url: await resolve(mask.url) }))),
          }]),
        )) } : {}),
      },
      materials: await Promise.all(product.materials.map(async (material) => ({
        ...material,
        previewUrl: await resolve(material.previewUrl),
        textureUrl: await resolve(material.textureUrl),
        preview: {
          ...material.preview,
          photoUrl: await resolve(material.preview.photoUrl),
          colorMaskUrl: await resolve(material.preview.colorMaskUrl),
          surfaceMaskUrl: await resolve(material.preview.surfaceMaskUrl),
        },
        patterns: await Promise.all(material.patterns.map(async (pattern) => ({
          ...pattern, previewUrl: await resolve(pattern.previewUrl),
          variants: await Promise.all(pattern.variants.map(async (variant) => ({
            ...variant, previewUrl: await resolve(variant.previewUrl), imageUrl: await resolve(variant.imageUrl),
          }))),
        }))),
      }))),
    })));
    return { products: resolved, dispose: () => urls.forEach((url) => void url.then(URL.revokeObjectURL, () => undefined)) };
  } catch (error) {
    urls.forEach((url) => void url.then(URL.revokeObjectURL, () => undefined));
    throw error;
  }
}

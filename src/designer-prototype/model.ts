import {
  EDITOR_VIEW_KEYS, pouchProfile, type EditorProfile, type EditorViewKey,
} from "./profile.ts";
import { fitLayer } from "./geometry.ts";
import { isTextFont, type TextStyle } from "./text.ts";
import type { ImageEdit } from "./image.ts";
import { DEFAULT_MATERIAL_ID, findMaterial, type EditorMaterial } from "./materials.ts";
import { getPouchPrice } from "../data/pouchPricing.ts";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;
export const MAX_LAYERS = 30;

interface BaseLayer {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface TextLayer extends BaseLayer {
  type: "text";
  text: string;
  color: string;
  style?: TextStyle;
}

export interface ImageLayer extends BaseLayer {
  type: "image";
  src: string;
  name: string;
  pattern?: { id: string; variantId: string };
  edit?: ImageEdit;
}

export type Layer = TextLayer | ImageLayer;

export interface Design {
  format: "roli-2d-design";
  version: 1;
  profileId: string;
  productId: string;
  canvas: { width: number; height: number };
  area: { x: number; y: number; width: number; height: number };
  materialId: string;
  sizeId?: string;
  fabricColor?: string;
  layers: Layer[];
}

export interface DesignCollection {
  format: "roli-2d-design";
  version: 2;
  profileId: string;
  productId: string;
  activeView: EditorViewKey;
  views: Partial<Record<EditorViewKey, Design>>;
}

export function parseDesignCollection(
  content: string,
  profiles: Partial<Record<EditorViewKey, EditorProfile>>,
  materials: readonly EditorMaterial[],
  legacyView: EditorViewKey,
): DesignCollection {
  let data: unknown;
  try { data = JSON.parse(content); }
  catch { throw new Error("A fájl nem érvényes JSON."); }
  if (!isRecord(data) || data.format !== "roli-2d-design") throw new Error("A terv formátuma nem támogatott.");
  if (data.version === 1) {
    const profile = profiles[legacyView];
    if (!profile) throw new Error("Ehhez a nézethez nincs érvényes szerkesztőprofil.");
    const design = parseDesign(content, profile, materials);
    return {
      format: "roli-2d-design", version: 2, profileId: profile.id,
      productId: profile.productId, activeView: legacyView, views: { [legacyView]: design },
    };
  }
  if (data.version !== 2 || typeof data.profileId !== "string" || typeof data.productId !== "string" ||
      typeof data.activeView !== "string" || !EDITOR_VIEW_KEYS.includes(data.activeView as EditorViewKey) ||
      !isRecord(data.views) || Object.keys(data.views).length > EDITOR_VIEW_KEYS.length) {
    throw new Error("A terv nézetei vagy verziója érvénytelen.");
  }
  const activeView = data.activeView as EditorViewKey;
  const views: Partial<Record<EditorViewKey, Design>> = {};
  for (const [key, value] of Object.entries(data.views)) {
    if (!EDITOR_VIEW_KEYS.includes(key as EditorViewKey) || !profiles[key as EditorViewKey] || !isRecord(value)) {
      throw new Error("A terv olyan nézetet tartalmaz, amely nem érhető el ennél a terméknél.");
    }
    const profile = profiles[key as EditorViewKey]!;
    const canvas = isRecord(value.canvas) ? value.canvas : undefined;
    if (value.profileId !== data.profileId || value.productId !== data.productId ||
        canvas?.width !== profile.canvas.width || canvas?.height !== profile.canvas.height) {
      throw new Error("A terv egyik nézete nem egyezik a termék aktuális profiljával.");
    }
    views[key as EditorViewKey] = parseDesign(JSON.stringify(value), profile, materials);
  }
  if (!views[activeView]) throw new Error("A terv aktív nézete hiányzik.");
  const firstProfile = profiles[activeView]!;
  if (data.profileId !== firstProfile.id || data.productId !== firstProfile.productId) {
    throw new Error("A terv nem tartozik ehhez a termékhez.");
  }
  return {
    format: "roli-2d-design", version: 2, profileId: firstProfile.id,
    productId: firstProfile.productId, activeView, views,
  };
}

export function newDesign(profile: EditorProfile = pouchProfile, materialId = DEFAULT_MATERIAL_ID): Design {
  return {
    format: "roli-2d-design",
    version: 1,
    profileId: profile.id,
    productId: profile.productId,
    canvas: { ...profile.canvas },
    area: { x: 0, y: 0, width: profile.canvas.width, height: profile.canvas.height },
    materialId,
    layers: [],
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const imagePattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export function parseDesign(content: string, profile: EditorProfile = pouchProfile, materials?: readonly EditorMaterial[]): Design {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error("A fájl nem érvényes JSON.");
  }
  if (!isRecord(data) || data.format !== "roli-2d-design" || data.version !== 1 ||
      data.profileId !== profile.id || !isRecord(data.canvas) || !isRecord(data.area) ||
      !Array.isArray(data.layers) || data.layers.length > MAX_LAYERS) {
    throw new Error("A terv formátuma, verziója vagy termékprofilja nem támogatott.");
  }
  if (data.fabricColor !== undefined && (typeof data.fabricColor !== "string" || !/^#[0-9a-f]{6}$/i.test(data.fabricColor))) {
    throw new Error("A terv anyagszíne érvénytelen.");
  }
  const productId = data.productId === undefined ? pouchProfile.productId : data.productId;
  if (productId !== profile.productId) {
    throw new Error("A terv terméke nem kompatibilis ezzel a szerkesztővel.");
  }
  if (data.sizeId !== undefined && (typeof data.sizeId !== "string" || !data.sizeId.trim() || data.sizeId.length > 100)) {
    throw new Error("A terv méretazonosítója érvénytelen.");
  }
  const materialId = data.materialId === undefined ? DEFAULT_MATERIAL_ID : data.materialId;
  const material = typeof materialId === "string"
    ? materials ? materials.find((item) => item.id === materialId) : findMaterial(materialId)
    : undefined;
  if (typeof materialId !== "string" || !material) {
    throw new Error("A terv anyaga nem ismert vagy nem érhető el.");
  }
  if (material.layoutId !== profile.id) {
    throw new Error("A terv anyaga nem kompatibilis ezzel a termékprofillel.");
  }
  if (!materials) getPouchPrice(productId, materialId);
  const { canvas, area } = data;
  if (!finite(canvas.width) || !finite(canvas.height) ||
      canvas.width < 100 || canvas.width > 10000 || canvas.height < 100 || canvas.height > 10000 ||
      !finite(area.x) || !finite(area.y) || !finite(area.width) || !finite(area.height) ||
      area.x < 0 || area.y < 0 || area.width <= 0 || area.height <= 0 ||
      area.x + area.width > canvas.width || area.y + area.height > canvas.height) {
    throw new Error("A terv vászna vagy szerkeszthető területe érvénytelen.");
  }
  const validCanvas = { width: canvas.width, height: canvas.height };
  const validArea = { x: area.x, y: area.y, width: area.width, height: area.height };
  const ids = new Set<string>();
  const layers: Layer[] = data.layers.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || item.id.length > 100 || ids.has(item.id) ||
        !finite(item.x) || !finite(item.y) || !finite(item.width) || !finite(item.height) || !finite(item.rotation) ||
        item.x < validArea.x || item.x > validArea.x + validArea.width || item.y < validArea.y || item.y > validArea.y + validArea.height ||
        item.width <= 0 || item.width > validCanvas.width * 2 || item.height <= 0 || item.height > validCanvas.height * 2 ||
        Math.abs(item.rotation) > 180) {
      throw new Error("A terv egyik rétege érvénytelen.");
    }
    ids.add(item.id);
    const base = { id: item.id, x: item.x, y: item.y, width: item.width, height: item.height, rotation: item.rotation };
    if (item.type === "text" && typeof item.text === "string" && item.text.length <= 200 &&
        typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color)) {
      if (item.style !== undefined) {
        const style = item.style;
        if (!isRecord(style) || typeof style.font !== "string" || !isTextFont(style.font) ||
            !finite(style.size) || style.size < 10 || style.size > 150 ||
            typeof style.bold !== "boolean" || typeof style.italic !== "boolean" ||
            (style.align !== "left" && style.align !== "center" && style.align !== "right") ||
            !finite(style.letterSpacing) || style.letterSpacing < -0.05 || style.letterSpacing > 0.5 ||
            !finite(style.lineHeight) || style.lineHeight < 0.8 || style.lineHeight > 3) {
          throw new Error("A terv egyik szövegformázása érvénytelen.");
        }
        return { ...base, type: "text", text: item.text, color: item.color, style: {
          font: style.font, size: style.size, bold: style.bold, italic: style.italic,
          align: style.align, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight,
        } };
      }
      return { ...base, type: "text", text: item.text, color: item.color };
    }
    if (item.type === "image" && typeof item.src === "string" && item.src.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 30 &&
        imagePattern.test(item.src) && typeof item.name === "string" && item.name.length <= 200) {
      if (item.pattern !== undefined) {
        if (item.edit !== undefined) throw new Error("A mintaréteg képszerkesztési adatai nem támogatottak.");
        if (!isRecord(item.pattern) || typeof item.pattern.id !== "string" || !item.pattern.id || item.pattern.id.length > 100 ||
            typeof item.pattern.variantId !== "string" || !item.pattern.variantId || item.pattern.variantId.length > 100) {
          throw new Error("A terv egyik mintájának adatai érvénytelenek.");
        }
        return { ...base, type: "image", src: item.src, name: item.name, pattern: { id: item.pattern.id, variantId: item.pattern.variantId } };
      }
      if (item.edit !== undefined) {
        const edit = item.edit;
        if (!isRecord(edit) || !isRecord(edit.crop) ||
            !finite(edit.opacity) || edit.opacity < 0 || edit.opacity > 1 ||
            typeof edit.flipX !== "boolean" || typeof edit.flipY !== "boolean" ||
            !finite(edit.crop.left) || !finite(edit.crop.right) ||
            !finite(edit.crop.top) || !finite(edit.crop.bottom) ||
            edit.crop.left < 0 || edit.crop.right < 0 || edit.crop.top < 0 || edit.crop.bottom < 0 ||
            edit.crop.left + edit.crop.right >= 1 || edit.crop.top + edit.crop.bottom >= 1) {
          throw new Error("A terv egyik képszerkesztési beállítása érvénytelen.");
        }
        return { ...base, type: "image", src: item.src, name: item.name, edit: {
          opacity: edit.opacity, flipX: edit.flipX, flipY: edit.flipY,
          crop: { left: edit.crop.left, top: edit.crop.top, right: edit.crop.right, bottom: edit.crop.bottom },
        } };
      }
      return { ...base, type: "image", src: item.src, name: item.name };
    }
    throw new Error("A terv egy szöveges vagy képes rétege érvénytelen.");
  });
  if (Math.abs(validCanvas.width / validCanvas.height - profile.canvas.width / profile.canvas.height) > 0.000001) {
    throw new Error("A terv vásznának aránya eltér a termékfotóétól.");
  }
  const factor = profile.canvas.width / validCanvas.width;
  const designArea = { x: 0, y: 0, width: profile.canvas.width, height: profile.canvas.height };
  const adjustedLayers = layers.map((layer) => fitLayer({
    ...layer,
    x: layer.x * factor,
    y: layer.y * factor,
    width: layer.width * factor,
    height: layer.height * factor,
  }, designArea));
  return {
    format: "roli-2d-design", version: 1, profileId: profile.id, productId,
    canvas: { ...profile.canvas },
    area: designArea,
    materialId,
    ...(typeof data.sizeId === "string" ? { sizeId: data.sizeId } : {}),
    ...(typeof data.fabricColor === "string" ? { fabricColor: data.fabricColor } : {}),
    layers: adjustedLayers,
  };
}

export async function validateImage(file: File, maxBytes = MAX_IMAGE_BYTES): Promise<void> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || !file.size || file.size > maxBytes) {
    throw new Error(`Csak legfeljebb ${Math.floor(maxBytes / (1024 * 1024))} MB-os JPEG, PNG vagy WebP kép tölthető fel.`);
  }
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!(file.type === "image/png" && png || file.type === "image/jpeg" && jpeg || file.type === "image/webp" && webp)) {
    throw new Error("A fájl tartalma nem egyezik a megadott képformátummal.");
  }
}

export function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("A kép nem olvasható."));
    reader.onerror = () => reject(new Error("A kép nem olvasható."));
    reader.readAsDataURL(file);
  });
}

export function decodeImage(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) {
        reject(new Error("A kép felbontása nem támogatott."));
      } else {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      }
    };
    image.onerror = () => reject(new Error("A kép nem olvasható vagy sérült."));
    image.src = src;
  });
}

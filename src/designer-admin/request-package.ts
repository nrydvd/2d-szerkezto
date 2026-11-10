import { toPng } from "html-to-image";
import {
  EDITOR_VIEW_LABELS, type EditorViewKey,
} from "../designer-prototype/profile";
import type { DesignCollection, ImageLayer } from "../designer-prototype/model";
import type { EditorProduct } from "../designer-prototype/catalog";

export interface RequestViewExport {
  view: EditorViewKey;
  png: Blob;
  productionPng?: Blob;
}

export interface RequestFile {
  name: string;
  role: string;
  file: File;
}

const encoder = new TextEncoder();
const safeName = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "termek";
const concat = (parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const ascii = (value: string) => encoder.encode(value);

export async function captureProductStage(stage: HTMLElement, width: number): Promise<Blob> {
  const bounds = stage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) throw new Error("A termék előnézete nem látható, ezért nem exportálható.");
  const ratio = Math.min(4, Math.max(1, width / bounds.width));
  const dataUrl = await toPng(stage, {
    pixelRatio: ratio,
    width: bounds.width,
    height: bounds.height,
    cacheBust: true,
    backgroundColor: "#ffffff",
    filter: (node) => !(node instanceof HTMLElement && node.dataset.exportIgnore === "true"),
  });
  const blob = await (await fetch(dataUrl)).blob();
  if (blob.type !== "image/png" || blob.size < 100) throw new Error("A termékterv PNG-exportja üres vagy hibás.");
  return blob;
}

export async function captureProductionArtwork(stage: HTMLElement, profile: { canvas: { width: number; height: number }; surfaceMask: string; protectMasks?: { url: string }[] }): Promise<Blob> {
  const surface = stage.querySelector<HTMLElement>(".surface");
  const bounds = stage.getBoundingClientRect();
  if (!surface || !bounds.width || !bounds.height) throw new Error("A mintaréteg nem exportálható.");
  const width = profile.canvas.width;
  const height = profile.canvas.height;
  const maskImage = new Image();
  maskImage.src = profile.surfaceMask;
  await maskImage.decode();
  const mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const maskContext = mask.getContext("2d", { willReadFrequently: true });
  if (!maskContext) throw new Error("A mintamaszk nem exportálható.");
  maskContext.drawImage(maskImage, 0, 0, width, height);
  for (const protectedMask of profile.protectMasks ?? []) {
    const image = new Image();
    image.src = protectedMask.url;
    await image.decode();
    maskContext.globalCompositeOperation = "destination-out";
    maskContext.drawImage(image, 0, 0, width, height);
  }
  maskContext.globalCompositeOperation = "source-over";
  const pixels = maskContext.getImageData(0, 0, width, height).data;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] > 0) {
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error("A mintamaszk nem tartalmaz exportálható területet.");
  const artworkUrl = await toPng(surface, {
    width: bounds.width, height: bounds.height, pixelRatio: width / bounds.width,
    style: { position: "relative", inset: "auto", width: `${bounds.width}px`, height: `${bounds.height}px`, maskImage: "none", webkitMaskImage: "none" },
  });
  const artwork = new Image();
  artwork.src = artworkUrl;
  await artwork.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A gyártási PNG vászna nem érhető el.");
  context.drawImage(artwork, 0, 0, width, height);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(mask, 0, 0);
  const cropped = document.createElement("canvas");
  cropped.width = right - left + 1;
  cropped.height = bottom - top + 1;
  const croppedContext = cropped.getContext("2d");
  if (!croppedContext) throw new Error("A gyártási PNG kivágása nem érhető el.");
  croppedContext.drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  return new Promise((resolve, reject) => cropped.toBlob((blob) =>
    blob ? resolve(blob) : reject(new Error("A gyártási PNG nem készíthető el.")), "image/png"));
}

function wrapText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) { lines.push(""); continue; }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > width) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawWrapped(context: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineHeight: number) {
  const lines = wrapText(context, text, width);
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

function imageFor(data: Blob) {
  return createImageBitmap(data);
}

function fitImage(context: CanvasRenderingContext2D, image: ImageBitmap, x: number, y: number, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function materialLabel(product: EditorProduct, design: DesignCollection["views"][EditorViewKey]) {
  if (!design) return "Nincs terv";
  const material = product.materials.find((item) => item.id === design.materialId);
  if (!material) return "Ismeretlen anyag";
  const color = design.fabricColor
    ? material.colors.find((item) => item.color.toLowerCase() === design.fabricColor?.toLowerCase())?.name ?? design.fabricColor
    : "Eredeti fotó";
  const patterns = [...new Set(design.layers.flatMap((layer) => {
    if (layer.type !== "image" || !layer.pattern) return [];
    const pattern = material.patterns.find((entry) => entry.id === layer.pattern?.id);
    const variant = pattern?.variants.find((entry) => entry.id === layer.pattern?.variantId);
    return [pattern ? `${pattern.name}${variant ? ` – ${variant.name}` : ""}` : layer.name];
  }))];
  return `${material.name} · ${color}${patterns.length ? ` · Minta: ${patterns.join(", ")}` : ""}`;
}

async function createSummaryPdf(
  product: EditorProduct,
  plan: DesignCollection,
  views: RequestViewExport[],
  uploadedNames: string[],
): Promise<Blob> {
  const pageW = 1240;
  const pageH = 1754;
  const pages: Blob[] = [];
  const images = await Promise.all(views.map(async (view) => [view.view, await imageFor(view.png)] as const));
  const imageMap = new Map(images);
  const canvas = document.createElement("canvas");
  canvas.width = pageW;
  canvas.height = pageH;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A PDF összesítő vászna nem érhető el.");
  const paintPage = (title: string) => {
    context.fillStyle = "#fffdfb";
    context.fillRect(0, 0, pageW, pageH);
    context.fillStyle = "#743a40";
    context.fillRect(0, 0, pageW, 16);
    context.fillStyle = "#743a40";
    context.font = "700 30px Georgia, serif";
    context.fillText("Ro-Lí", 92, 100);
    context.fillStyle = "#332c29";
    context.font = "600 38px Georgia, serif";
    context.fillText(title, 92, 160);
    context.font = "24px Arial, sans-serif";
    context.fillStyle = "#6b625d";
    context.fillText(product.profile.name, 92, 210);
  };
  const savePage = async () => pages.push(await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) =>
    blob ? resolve(blob) : reject(new Error("A PDF oldal képe nem készíthető el.")), "image/jpeg", 0.9)));
  try {
    paintPage("Vásárlói tervezési összesítő");
    let y = 240;
    const active = imageMap.get(plan.activeView);
    if (active) {
      context.fillStyle = "#f3eee9";
      context.fillRect(92, y, 1056, 710);
      fitImage(context, active, 104, y + 10, 1032, 690);
    }
    const additionalViews = (Object.keys(plan.views) as EditorViewKey[]).filter((key) => key !== plan.activeView);
    const thumbGap = 18;
    const thumbWidth = (1056 - thumbGap * Math.max(0, additionalViews.length - 1)) / Math.max(1, additionalViews.length);
    for (const [index, key] of additionalViews.entries()) {
      const thumbnail = imageMap.get(key);
      if (!thumbnail) continue;
      const x = 92 + index * (thumbWidth + thumbGap);
      context.fillStyle = "#f3eee9";
      context.fillRect(x, 980, thumbWidth, 230);
      fitImage(context, thumbnail, x + 7, 987, thumbWidth - 14, 216);
      context.fillStyle = "#332c29";
      context.font = "18px Arial, sans-serif";
      context.fillText(EDITOR_VIEW_LABELS[key], x, 1235);
    }
    y = additionalViews.length ? 1280 : 990;
    context.fillStyle = "#332c29";
    context.font = "600 23px Arial, sans-serif";
    context.fillText("Nézetek, anyagok és színek", 92, y);
    y += 36;
    context.font = "20px Arial, sans-serif";
    for (const key of Object.keys(plan.views) as EditorViewKey[]) {
      const design = plan.views[key];
      if (!design) continue;
      y = drawWrapped(context, `${EDITOR_VIEW_LABELS[key]} · ${materialLabel(product, design)}`, 92, y + 7, 1056, 26);
    }
    context.fillStyle = "#877b73";
    context.font = "16px Arial, sans-serif";
    context.fillText("A rendelési állapot az adminfelületen követhető.", 92, pageH - 54);
    await savePage();

    paintPage("Személyre szabási részletek");
    y = 270;
    const nextPage = async () => {
      await savePage();
      paintPage("Személyre szabási részletek – folytatás");
      y = 250;
    };
    const addHeading = async (label: string) => {
      if (y > pageH - 130) await nextPage();
      context.fillStyle = "#743a40";
      context.font = "600 25px Arial, sans-serif";
      context.fillText(label, 92, y);
      y += 44;
    };
    const addText = async (text: string) => {
      context.fillStyle = "#332c29";
      context.font = "20px Arial, sans-serif";
      const lines = wrapText(context, text, 1056);
      for (let offset = 0; offset < lines.length; offset += 1) {
        if (y > pageH - 90) await nextPage();
        context.fillText(lines[offset], 92, y);
        y += 28;
      }
      y += 8;
    };
    await addHeading("Kiválasztott anyagok és színek");
    for (const key of Object.keys(plan.views) as EditorViewKey[]) {
      const design = plan.views[key];
      if (design) await addText(`${EDITOR_VIEW_LABELS[key]}: ${materialLabel(product, design)}`);
    }
    await addHeading("Vásárlói szövegek");
    const textLayers = (Object.entries(plan.views) as [EditorViewKey, NonNullable<typeof plan.views[EditorViewKey]>][])
      .flatMap(([key, design]) => design.layers.filter((layer) => layer.type === "text")
        .map((layer) => `${EDITOR_VIEW_LABELS[key]}: ${layer.text}`));
    if (textLayers.length) for (const text of textLayers) await addText(text);
    else await addText("A vásárló nem adott meg szöveget.");
    await addHeading("Eredeti, feltöltött fájlok");
    if (uploadedNames.length) for (const name of uploadedNames) await addText(name);
    else await addText("Nincs külön feltöltött grafika.");
    if (product.description?.trim()) {
      await addHeading("Termékhez tartozó megjegyzés");
      await addText(product.description.trim());
    }
    await savePage();
  } finally {
    for (const image of imageMap.values()) image.close();
  }
  return buildImagePdf(pages);
}

async function buildImagePdf(pages: Blob[]): Promise<Blob> {
  const pageWidth = 595;
  const pageHeight = 842;
  const objects: Uint8Array[] = [];
  const addObject = (body: Uint8Array) => { objects.push(body); return objects.length; };
  const catalogId = addObject(new Uint8Array());
  const pagesId = addObject(new Uint8Array());
  const pageIds: number[] = [];
  for (const blob of pages) {
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const imageId = addObject(concat([
      ascii(`<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg, ascii("\nendstream"),
    ]));
    const content = ascii(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`);
    const contentId = addObject(concat([ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii("\nendstream")]));
    const pageId = addObject(ascii(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ));
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = ascii(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objects[pagesId - 1] = ascii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const parts: Uint8Array[] = [ascii("%PDF-1.4\n%âãÏÓ\n")];
  const offsets = [0];
  let offset = parts[0].length;
  for (let index = 0; index < objects.length; index += 1) {
    const entry = concat([ascii(`${index + 1} 0 obj\n`), objects[index], ascii("\nendobj\n")]);
    offsets.push(offset);
    parts.push(entry);
    offset += entry.length;
  }
  const xrefOffset = offset;
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(ascii(xref));
  parts.push(ascii(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));
  return new Blob(parts.map((part) => Uint8Array.from(part).buffer), { type: "application/pdf" });
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function createZip(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(bytes);
    const localHeader = new Uint8Array(30 + name.length);
    const local = new DataView(localHeader.buffer);
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true); localHeader.set(name, 30);
    locals.push(localHeader, bytes);
    const central = new Uint8Array(46 + name.length);
    const entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true); entry.setUint32(16, crc, true); entry.setUint32(20, bytes.length, true);
    entry.setUint32(24, bytes.length, true); entry.setUint16(28, name.length, true); entry.setUint32(42, localOffset, true);
    central.set(name, 46); centrals.push(central);
    localOffset += localHeader.length + bytes.length;
  }
  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true); view.setUint32(12, centralSize, true); view.setUint32(16, localOffset, true);
  return new Blob([...locals, ...centrals, end].map((part) => Uint8Array.from(part).buffer), { type: "application/zip" });
}

export async function createCustomerPackage(
  product: EditorProduct,
  plan: DesignCollection,
  views: RequestViewExport[],
): Promise<RequestFile[]> {
  const base = safeName(product.profile.name);
  const files: RequestFile[] = [];
  const originals = new Map<string, string>();
  const usedNames = new Set<string>();
  const uploadedNames: string[] = [];
  const uniqueName = (name: string) => {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let result = name;
    let suffix = 2;
    while (usedNames.has(result.toLowerCase())) result = `${stem}-${suffix++}${extension}`;
    usedNames.add(result.toLowerCase());
    return result;
  };
  const planBlob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
  const planName = uniqueName(`${base}-terv.json`);
  files.push({ name: planName, role: "plan", file: new File([planBlob], planName, { type: planBlob.type }) });
  for (const view of views) {
    const name = uniqueName(`${base}-${safeName(EDITOR_VIEW_LABELS[view.view])}-termekelonezet.png`);
    files.push({ name, role: view.view === plan.activeView ? "preview" : "view-png", file: new File([view.png], name, { type: "image/png" }) });
    if (view.productionPng) {
      const productionName = uniqueName(`${base}-${safeName(EDITOR_VIEW_LABELS[view.view])}-gyartasi.png`);
      files.push({ name: productionName, role: "production-png", file: new File([view.productionPng], productionName, { type: "image/png" }) });
    }
    const design = plan.views[view.view];
    for (const layer of design?.layers ?? []) {
      if (layer.type !== "image" || layer.pattern || !layer.src.startsWith("data:image/")) continue;
      const image = layer as ImageLayer;
      const key = image.src;
      if (originals.has(key)) continue;
      const originalName = uniqueName(`${safeName(image.name.replace(/\.[^.]+$/, ""))}.${image.src.slice(11, image.src.indexOf(";")) === "jpeg" ? "jpg" : image.src.slice(11, image.src.indexOf(";"))}`);
      const blob = await (await fetch(image.src)).blob();
      originals.set(key, originalName);
      uploadedNames.push(originalName);
      files.push({ name: originalName, role: "original-upload", file: new File([blob], originalName, { type: blob.type }) });
    }
  }
  const summary = await createSummaryPdf(product, plan, views, uploadedNames);
  const pdfName = uniqueName(`${base}-osszefoglalo.pdf`);
  files.push({ name: pdfName, role: "summary-pdf", file: new File([summary], pdfName, { type: summary.type }) });
  const archive = await createZip(files.map(({ name, file }) => ({ name, blob: file })));
  const zipName = uniqueName(`${base}-teljes-csomag.zip`);
  files.push({ name: zipName, role: "archive", file: new File([archive], zipName, { type: archive.type }) });
  return files;
}

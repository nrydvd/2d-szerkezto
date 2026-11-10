import { StrictMode, useCallback, useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  decodeImage, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, MAX_LAYERS, newDesign, parseDesignCollection, readDataUrl, validateImage,
  type Design, type DesignCollection, type Layer, type TextLayer,
} from "./model";
import { fitLayer } from "./geometry";
import { type EditorPattern, type PatternVariant } from "../data/builtinPatterns";
import { DEFAULT_TEXT_STYLE, LEGACY_TEXT_STYLE, TEXT_FONTS, isTextFont, textLayout, type TextStyle } from "./text";
import { DEFAULT_IMAGE_EDIT, cropAspect, cropToAspect, sizeWithin, type Crop, type ImageEdit } from "./image";
import { TextilePreviewCanvas } from "../neszeszerPreview";
import { unavailablePatternIds } from "./materials";
import { formatPrice } from "../data/pouchPricing";
import { captureProductStage, createCustomerPackage, type RequestViewExport } from "../designer-admin/request-package";
import {
  designerProductSlug, editorProductViews, readCatalog, readDesignerProduct, resolveCatalog,
  type EditorProduct,
} from "./catalog";
import {
  EDITOR_VIEW_KEYS, EDITOR_VIEW_LABELS, editorViewProfile, type EditorProfile, type EditorViewKey,
} from "./profile";
import "./style.css";

type History = { past: Design[]; present: Design; future: Design[] };
type Drag = { pointerId: number; layerId: string; startX: number; startY: number; x: number; y: number; before: Design };
type PreparedImage = {
  src: string; name: string; dimensions: { width: number; height: number };
  pattern?: { id: string; variantId: string };
};

function AdminLink() {
  return <a className="admin-link" href="/termekek/">Adminisztráció</a>;
}

function designStamp(design: Design) {
  return design.layers.map((layer) =>
    `${layer.id}:${layer.x}:${layer.y}:${layer.width}:${layer.height}:${layer.rotation}:${layer.type === "text" ? layer.text : layer.src.length}`,
  ).join("|");
}

async function renderPattern(src: string): Promise<PreparedImage["dimensions"] & { src: string }> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height || width * height > 40_000_000) throw new Error("A minta mérete nem támogatott.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A minta előkészítéséhez szükséges vászon nem érhető el.");
  context.drawImage(image, 0, 0);
  return { src: canvas.toDataURL("image/png"), width, height };
}

const textMeasure = document.createElement("canvas").getContext("2d");
if (!textMeasure) throw new Error("A szöveg méréséhez szükséges vászon nem érhető el.");
const measureContext = textMeasure;

function layoutText(layer: TextLayer) {
  const style = layer.style ?? LEGACY_TEXT_STYLE;
  measureContext.font = `${style.italic ? "italic" : "normal"} ${style.bold ? "bold" : "normal"} 100px ${TEXT_FONTS[style.font].family}`;
  return textLayout(layer.text, layer.width, layer.height, style, (line) => {
    const metrics = measureContext.measureText(line);
    return Math.max(metrics.width, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight);
  });
}

function TextArtwork({ layer }: { layer: TextLayer }) {
  const style = layer.style ?? LEGACY_TEXT_STYLE;
  const layout = layoutText(layer);
  return (
    <svg viewBox={`0 0 ${layer.width} ${layer.height}`} aria-hidden="true" style={{ overflow: "hidden" }}>
      {layout.lines.map((line, index) => (
        <text key={index} x={layout.x}
          y={layer.height / 2 + (index - (layout.lines.length - 1) / 2) * layout.size * style.lineHeight}
          dominantBaseline="central" textAnchor={layout.anchor} fill={layer.color}
          fontFamily={TEXT_FONTS[style.font].family} fontSize={layout.size}
          fontWeight={style.bold ? "bold" : "normal"} fontStyle={style.italic ? "italic" : "normal"}
          letterSpacing={`${style.letterSpacing}em`} xmlSpace="preserve">{line}</text>
      ))}
    </svg>
  );
}

function PositionInput({ label, value, onCommit, onInvalid }: {
  label: string; value: number; onCommit: (value: number) => void; onInvalid: () => void;
}) {
  const formatted = String(Number(value.toFixed(2)));
  const [draft, setDraft] = useState(formatted);
  useEffect(() => { setDraft(formatted); }, [formatted]);
  function apply() {
    const number = Number(draft);
    if (!draft.trim() || !Number.isFinite(number)) {
      setDraft(formatted);
      onInvalid();
      return;
    }
    onCommit(number);
    setDraft(formatted);
  }
  return <label>{label}
    <input type="number" step="1" value={draft} onChange={(event) => setDraft(event.target.value)}
      onBlur={apply} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
  </label>;
}

function Editor({ product, view, viewProfiles, designs, onViewChange, onDesignChange, onDesignsLoaded }: {
  product: EditorProduct;
  view: EditorViewKey;
  viewProfiles: Partial<Record<EditorViewKey, EditorProfile>>;
  designs: Partial<Record<EditorViewKey, Design>>;
  onViewChange: (view: EditorViewKey) => void;
  onDesignChange: (view: EditorViewKey, design: Design) => void;
  onDesignsLoaded: (designs: Partial<Record<EditorViewKey, Design>>) => void;
}) {
  const profile = viewProfiles[view] ?? product.profile;
  const materials = product.materials;
  const settings = product.editorSettings ?? {
    customText: true, maxTextLength: 200, imageUpload: true, maxUploadBytes: MAX_IMAGE_BYTES, enabled2d: true,
  };
  const [history, setHistory] = useState<History>(() => ({
    past: [], present: designs[view] ?? newDesign(profile, materials[0].id), future: [],
  }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [visualError, setVisualError] = useState("");
  const [fabricError, setFabricError] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [mobilePanel, setMobilePanel] = useState<"materials" | "tools">("materials");
  const [imageSize, setImageSize] = useState<{ src: string; width: number; height: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const historyRef = useRef(history);
  const historyViewRef = useRef(view);
  const viewDesignsRef = useRef(designs);
  const restoreViewRef = useRef<EditorViewKey | null>(null);
  const designChangeRef = useRef(onDesignChange);
  designChangeRef.current = onDesignChange;
  historyRef.current = history;
  const { present } = history;
  const selected = present.layers.find((layer) => layer.id === selectedId);
  const selectedImageSrc = selected?.type === "image" && !selected.pattern ? selected.src : undefined;

  useEffect(() => { setFabricError(""); setVisualError(""); }, [present.fabricColor, present.materialId]);
  useEffect(() => {
    const currentView = historyViewRef.current;
    viewDesignsRef.current = { ...viewDesignsRef.current, [currentView]: present };
    designChangeRef.current(currentView, present);
  }, [present]);
  useEffect(() => {
    if (historyViewRef.current === view) return;
    viewDesignsRef.current = { ...viewDesignsRef.current, [historyViewRef.current]: historyRef.current.present };
    historyViewRef.current = view;
    updateHistory(() => ({
      past: [], present: viewDesignsRef.current[view] ?? newDesign(profile, materials[0].id), future: [],
    }));
    setSelectedId(null);
    setImageSize(null);
    setZoom(1);
    const restoring = restoreViewRef.current === view;
    if (restoring) restoreViewRef.current = null;
    else if (!exporting) setMessage("");
  }, [view]);

  function centerCanvas() {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
    }
  }

  useEffect(() => { centerCanvas(); }, [zoom]);

  useEffect(() => {
    if (!selectedImageSrc) return;
    let active = true;
    decodeImage(selectedImageSrc).then((dimensions) => {
      if (active) setImageSize({ src: selectedImageSrc, ...dimensions });
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : "A kép mérete nem olvasható.");
    });
    return () => { active = false; };
  }, [selectedImageSrc]);

  function commit(change: (design: Design) => Design) {
    updateHistory((state) => {
      const next = change(state.present);
      if (next === state.present) return state;
      return { past: [...state.past.slice(-49), state.present], present: next, future: [] };
    });
  }

  function updateHistory(change: (state: History) => History) {
    const next = change(historyRef.current);
    historyRef.current = next;
    viewDesignsRef.current = { ...viewDesignsRef.current, [historyViewRef.current]: next.present };
    setHistory(next);
  }

  function undo() {
    updateHistory((state) => {
      if (!state.past.length) return state;
      return { past: state.past.slice(0, -1), present: state.past[state.past.length - 1], future: [state.present, ...state.future] };
    });
  }

  function redo() {
    updateHistory((state) => {
      if (!state.future.length) return state;
      return { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1) };
    });
  }

  function updateLayer(id: string, change: (layer: Layer) => Layer) {
    commit((design) => {
      if (!design.layers.some((layer) => layer.id === id)) return design;
      return { ...design, layers: design.layers.map((layer) => layer.id === id ? fitLayer(change(layer), design.area) : layer) };
    });
  }

  function updateTextStyle(id: string, change: Partial<TextStyle>) {
    updateLayer(id, (layer) => layer.type === "text"
      ? { ...layer, style: { ...(layer.style ?? LEGACY_TEXT_STYLE), ...change } }
      : layer);
  }

  function setFabricColor(color?: string) {
    commit((design) => {
      if (design.fabricColor === color) return design;
      if (color) return { ...design, fabricColor: color };
      const { fabricColor: _color, ...original } = design;
      return original;
    });
  }

  function setMaterial(materialId: string) {
    const material = materials.find((item) => item.id === materialId);
    if (!material || material.layoutId !== profile.id) {
      setMessage("Ez az anyag nem kompatibilis a jelenlegi termékvászonnal.");
      return;
    }
    commit((design) => design.materialId === materialId ? design : { ...design, materialId });
    setMessage(`Kiválasztott anyag: ${material.name}. A meglévő rétegek megmaradtak.`);
  }

  function updateImageEdit(id: string, change: Partial<ImageEdit>) {
    updateLayer(id, (layer) => layer.type === "image" && !layer.pattern
      ? { ...layer, edit: { ...(layer.edit ?? DEFAULT_IMAGE_EDIT), ...change } }
      : layer);
  }

  function updateCrop(id: string, crop: Crop) {
    if (!imageSize || imageSize.src !== selectedImageSrc) return;
    const ratio = cropAspect(crop, imageSize.width, imageSize.height);
    updateLayer(id, (layer) => {
      if (layer.type !== "image" || layer.pattern) return layer;
      return {
        ...layer, height: layer.width / ratio,
        edit: { ...(layer.edit ?? DEFAULT_IMAGE_EDIT), crop },
      };
    });
  }

  async function replaceImage(event: ChangeEvent<HTMLInputElement>, id: string) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!settings.imageUpload) {
      setMessage("Ehhez a termékhez a saját grafika feltöltése nincs engedélyezve.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await validateImage(file, settings.maxUploadBytes);
      const src = await readDataUrl(file);
      const dimensions = await decodeImage(src);
      const design = historyRef.current.present;
      const target = design.layers.find((layer) => layer.id === id);
      if (!target || target.type !== "image" || target.pattern) throw new Error("A kijelölt képréteg már nem elérhető.");
      const nextLayer = fitLayer({
        ...target, src, name: file.name.slice(0, 200),
        ...sizeWithin(target.width, target.height, dimensions.width / dimensions.height),
        edit: { ...(target.edit ?? DEFAULT_IMAGE_EDIT), crop: { ...DEFAULT_IMAGE_EDIT.crop } },
      }, design.area);
      const next = { ...design, layers: design.layers.map((layer) => layer.id === id ? nextLayer : layer) };
      if (new Blob([JSON.stringify(next, null, 2)]).size > MAX_DOCUMENT_BYTES) {
        throw new Error("A csere után a terv túl nagy lenne a JSON-mentéshez.");
      }
      commit(() => next);
      setMessage("A kép cserélve; a kivágás alaphelyzetbe állt.");
    } catch (error) {
      setMessage(error instanceof Error ? `A kép nem cserélhető: ${error.message}` : "A kép nem cserélhető.");
    } finally {
      setBusy(false);
    }
  }

  function addText() {
    if (!settings.customText) return;
    if (present.layers.length >= MAX_LAYERS) {
      setMessage(`Legfeljebb ${MAX_LAYERS} elem adható hozzá.`);
      return;
    }
    const id = crypto.randomUUID();
    const { area } = present;
    commit((design) => ({
      ...design,
      layers: [...design.layers, {
        id, type: "text", text: "Saját szöveg", color: "#332c29", style: { ...DEFAULT_TEXT_STYLE },
        x: area.x + area.width / 2, y: area.y + area.height / 2,
        width: Math.max(10, Math.min(300, area.width * 0.6)),
        height: Math.max(10, Math.min(75, area.height * 0.2)), rotation: 0,
      }],
    }));
    setSelectedId(id);
    setMobilePanel("tools");
    setMessage("Szöveg hozzáadva. A beállítások között szerkesztheted.");
  }

  function addImageLayers(images: PreparedImage[]) {
    const design = historyRef.current.present;
    if (design.layers.length + images.length > MAX_LAYERS) {
      throw new Error(`Legfeljebb ${MAX_LAYERS} elem adható hozzá.`);
    }
    const layers: Layer[] = images.map(({ src, dimensions, name, pattern }, index) => {
      const scale = Math.min(
        Math.min(250, design.area.width * 0.6) / dimensions.width,
        Math.min(200, design.area.height * 0.6) / dimensions.height,
      );
      return fitLayer({
        id: crypto.randomUUID(), type: "image", src, name, ...(pattern ? { pattern } : {}),
        x: design.area.x + design.area.width / 2 + index * 12,
        y: design.area.y + design.area.height / 2 + index * 12,
        width: dimensions.width * scale, height: dimensions.height * scale, rotation: 0,
      }, design.area);
    });
    const next = { ...design, layers: [...design.layers, ...layers] };
    if (new Blob([JSON.stringify(next, null, 2)]).size > MAX_DOCUMENT_BYTES) {
      throw new Error("A terv túl nagy lenne a JSON-mentéshez. Távolíts el néhány képet.");
    }
    commit(() => next);
    setSelectedId(layers[layers.length - 1].id);
    setMobilePanel("tools");
  }

  async function addImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;
    if (!settings.imageUpload) {
      setMessage("Ehhez a termékhez a saját grafika feltöltése nincs engedélyezve.");
      return;
    }
    if (historyRef.current.present.layers.length + files.length > MAX_LAYERS) {
      setMessage(`Legfeljebb ${MAX_LAYERS} elem adható hozzá.`);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const images = await Promise.all(files.map(async (file) => {
        await validateImage(file, settings.maxUploadBytes);
        const src = await readDataUrl(file);
        const dimensions = await decodeImage(src);
        return { src, dimensions, name: file.name.slice(0, 200) };
      }));
      addImageLayers(images);
      setMessage(`${images.length} kép hozzáadva.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A kép feltöltése sikertelen.");
    } finally {
      setBusy(false);
    }
  }

  async function addPattern(pattern: EditorPattern) {
    setBusy(true);
    setMessage("");
    try {
      const variant = pattern.variants[0];
      if (!variant) throw new Error("A mintához nem tartozik használható változat.");
      const image = await renderPattern(variant.imageUrl);
      addImageLayers([{
        src: image.src, dimensions: image, name: `Minta: ${pattern.name}`,
        pattern: { id: pattern.id, variantId: variant.id },
      }]);
      setMessage(`Minta hozzáadva: ${pattern.name}.`);
    } catch (error) {
      setMessage(error instanceof Error ? `A minta nem adható hozzá: ${error.message}` : "A minta nem adható hozzá.");
    } finally {
      setBusy(false);
    }
  }

  async function changePatternVariant(layerId: string, pattern: EditorPattern, variant: PatternVariant) {
    setBusy(true);
    setMessage("");
    try {
      const image = await renderPattern(variant.imageUrl);
      const design = historyRef.current.present;
      const next = {
        ...design,
        layers: design.layers.map((layer): Layer =>
          layer.id === layerId && layer.type === "image" && layer.pattern?.id === pattern.id
            ? { ...layer, src: image.src, pattern: { id: pattern.id, variantId: variant.id } }
            : layer),
      };
      if (new Blob([JSON.stringify(next, null, 2)]).size > MAX_DOCUMENT_BYTES) {
        throw new Error("A terv túl nagy lenne a JSON-mentéshez.");
      }
      commit((current) => ({
        ...current,
        layers: current.layers.map((layer) =>
          layer.id === layerId && layer.type === "image" && layer.pattern?.id === pattern.id
            ? { ...layer, src: image.src, pattern: { id: pattern.id, variantId: variant.id } }
            : layer),
      }));
      setMessage(`Mintaszín: ${variant.name}.`);
    } catch (error) {
      setMessage(error instanceof Error ? `A mintaszín nem módosítható: ${error.message}` : "A mintaszín nem módosítható.");
    } finally {
      setBusy(false);
    }
  }

  function moveLayer(direction: -1 | 1) {
    if (!selected) return;
    commit((design) => {
      const index = design.layers.findIndex((layer) => layer.id === selected.id);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= design.layers.length) return design;
      const layers = [...design.layers];
      [layers[index], layers[next]] = [layers[next], layers[index]];
      return { ...design, layers };
    });
  }

  function deleteLayer() {
    if (!selected) return;
    commit((design) => ({ ...design, layers: design.layers.filter((layer) => layer.id !== selected.id) }));
    setSelectedId(null);
    setMessage("Elem törölve.");
  }

  function startDrag(event: PointerEvent<HTMLDivElement>, layer: Layer) {
    if (busy || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(layer.id);
    setMobilePanel("tools");
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId, layerId: layer.id, startX: event.clientX, startY: event.clientY,
      x: layer.x, y: layer.y, before: historyRef.current.present,
    };
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !stage) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const { canvas, area } = drag.before;
    const x = drag.x + (event.clientX - drag.startX) * canvas.width / rect.width;
    const y = drag.y + (event.clientY - drag.startY) * canvas.height / rect.height;
    updateHistory((state) => ({
      ...state,
      present: { ...state.present, layers: state.present.layers.map((layer) => layer.id === drag.layerId ? fitLayer({ ...layer, x, y }, area) : layer) },
    }));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    updateHistory((state) => {
      if (cancelled) return { ...state, present: drag.before };
      if (JSON.stringify(state.present) === JSON.stringify(drag.before)) return state;
      return { past: [...state.past.slice(-49), drag.before], present: state.present, future: [] };
    });
  }

  async function save() {
    setBusy(true);
    try {
      const designCollection: DesignCollection = {
        format: "roli-2d-design", version: 2, profileId: profile.id,
        productId: profile.productId, activeView: view,
        views: { ...designs, [view]: present },
      };
      const json = JSON.stringify(designCollection, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      if (blob.size > MAX_DOCUMENT_BYTES) throw new Error("A terv túl nagy a mentéshez. Távolíts el néhány képet.");
      if (!import.meta.env.DEV) {
        const response = await fetch("/api/designer-designs/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: designerProductSlug(product), design: designCollection }),
        });
        if (!response.ok) {
          const result: unknown = await response.json().catch(() => null);
          throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string"
            ? result.error : `A terv ellenőrzése sikertelen (${response.status}).`);
        }

      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `roli-${profile.productId}-terv.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(import.meta.env.DEV
        ? "A terv JSON-fájlként letöltve, a képekkel együtt."
        : "A termékhez tartozást a szerver ellenőrizte; a terv JSON-fájlként letöltve.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A terv mentése sikertelen.");
    } finally { setBusy(false); }
  }

  async function saveCustomerRequest() {
    const activeView = view;
    setBusy(true);
    setExporting(true);
    setSelectedId(null);
    setMessage("A nézetek és a fájlcsomag előkészítése…");
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const savedDesigns = { ...viewDesignsRef.current, [activeView]: historyRef.current.present };
      const plan: DesignCollection = {
        format: "roli-2d-design", version: 2, profileId: product.profile.id,
        productId: product.profile.productId, activeView, views: savedDesigns,
      };
      const exportViews: RequestViewExport[] = [];
      for (const key of EDITOR_VIEW_KEYS) {
        const design = plan.views[key];
        const viewProfile = viewProfiles[key];
        if (!design || !viewProfile) continue;
        if (key !== historyViewRef.current) onViewChange(key);
        const deadline = Date.now() + 8000;
        let stage: HTMLDivElement | null = null;
        while (Date.now() < deadline) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const current = stageRef.current;
          if (current?.dataset.exportView === key && current.dataset.exportDesign === designStamp(design)) {
            const recolor = current.querySelector<HTMLCanvasElement>("canvas.visual-recolor");
            const images = [...current.querySelectorAll("img")];
            const imagesReady = images.every((image) => image.complete && image.naturalWidth > 0);
            if (imagesReady && (!recolor || recolor.dataset.exportReady === "true")) {
              stage = current;
              break;
            }
          }
        }
        if (!stage) throw new Error(`${EDITOR_VIEW_LABELS[key]}: a termékterv nem állt készen az exportálásra.`);
        await Promise.all([...stage.querySelectorAll("img")].map((image) => image.decode()));
        setMessage(`${EDITOR_VIEW_LABELS[key]} exportálása…`);
        exportViews.push({ view: key, png: await captureProductStage(stage, design.canvas.width) });
      }
      if (!exportViews.length) throw new Error("Nincs exportálható terméknézet.");
      const files = await createCustomerPackage(product, plan, exportViews);
      const totalBytes = files.reduce((total, entry) => total + entry.file.size, 0);
      if (files.length > 160 || totalBytes > 80 * 1024 * 1024) {
        throw new Error("A kész fájlcsomag túllépi a 80 MB-os mentési korlátot. Távolíts el néhány nagyobb képet.");
      }
      const form = new FormData();
      form.set("productSlug", designerProductSlug(product));
      for (const entry of files) {
        form.append("files", entry.file, entry.name);
        form.append("roles", entry.role);
      }
      const response = await fetch("/api/designer-requests", { method: "POST", body: form });
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("A tartós igénytár nem érhető el. A beküldéshez konfigurált Cloudflare D1 és R2 tárhely szükséges.");
      }
      const body = await response.json() as { saved?: boolean; error?: string };
      if (!response.ok || !body.saved) throw new Error(body.error ?? "A vásárlói igénycsomag nem menthető.");
      setMessage("A tervezési igénycsomag biztonságosan elmentve. A fájlok az admin Vásárlói igények felületén érhetők el.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A tervezési csomag nem készíthető el.");
    } finally {
      if (historyViewRef.current !== activeView) {
        restoreViewRef.current = activeView;
        onViewChange(activeView);
      }
      setExporting(false);
      setBusy(false);
    }
  }

  async function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      if (file.size > MAX_DOCUMENT_BYTES) throw new Error("A tervfájl legfeljebb 40 MB lehet.");
      const collection = parseDesignCollection(await file.text(), viewProfiles, materials, view);
      const loaded = Object.entries(collection.views) as [EditorViewKey, Design][];
      for (const [, design] of loaded) {
        if (!settings.customText && design.layers.some((layer) => layer.type === "text")) {
          throw new Error("Ez a termék nem engedélyez egyedi szöveget.");
        }
        if (design.layers.some((layer) => layer.type === "text" && layer.text.length > settings.maxTextLength)) {
          throw new Error("A terv szövege túllépi a termékhez beállított karakterkorlátot.");
        }
        if (!settings.imageUpload && design.layers.some((layer) => layer.type === "image" && !layer.pattern)) {
          throw new Error("Ez a termék nem engedélyez saját grafika feltöltését.");
        }
      }
      await Promise.all(loaded.flatMap(([, design]) => design.layers.filter((layer) => layer.type === "image").map(async (layer) => {
        const [header, encoded] = layer.src.split(",");
        const binary = atob(encoded);
        const maxBytes = layer.pattern ? MAX_IMAGE_BYTES : settings.maxUploadBytes;
        if (binary.length > maxBytes) throw new Error("A terv egyik képe túllépi a termékhez beállított fájlméretkorlátot.");
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        const type = header.slice(5, header.indexOf(";"));
        await validateImage(new File([bytes], layer.name, { type }), maxBytes);
        await decodeImage(layer.src);
      })));
      const design = collection.views[view] ?? collection.views[collection.activeView]!;
      viewDesignsRef.current = { ...viewDesignsRef.current, ...collection.views };
      onDesignsLoaded(collection.views);
      commit(() => design);
      setSelectedId(null);
      setMessage("A terv betöltve; a rétegek az aktuális nyomtatható területhez igazodnak.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A terv nem tölthető be.");
    } finally {
      setBusy(false);
    }
  }

  const selectedIndex = present.layers.findIndex((layer) => layer.id === selectedId);
  const material = materials.find((item) => item.id === present.materialId);
  if (!material) throw new Error("A kiválasztott anyag nem érhető el.");
  const selectedPattern = selected?.type === "image" && selected.pattern
    ? [...material.patterns, ...materials.flatMap((item) => item.patterns)].find((pattern) => pattern.id === selected.pattern?.id)
    : undefined;
  const selectedTextStyle = selected?.type === "text" ? selected.style ?? LEGACY_TEXT_STYLE : undefined;
  const selectedEdit = selected?.type === "image" && !selected.pattern ? selected.edit ?? DEFAULT_IMAGE_EDIT : undefined;
  const selectedImageSize = imageSize?.src === selectedImageSrc ? imageSize : null;
  const unavailablePatterns = unavailablePatternIds(present.layers, material);
  const availablePatterns = material.patterns.filter((pattern) => pattern.active);
  const price = import.meta.env.DEV && typeof material.priceHuf === "number"
    ? formatPrice(material.priceHuf)
    : undefined;
  const activeMaterialPreview = {
    ...material.preview,
    photoUrl: profile.photo,
    colorMaskUrl: profile.fabricMask,
    surfaceMaskUrl: profile.surfaceMask,
  };
  const selectableViews = EDITOR_VIEW_KEYS.filter((key) => viewProfiles[key]);

  return (
    <main className="designer">
      <header className="designer-header">
        <div className="header-brand"><a className="brand" href="/">Ro-Lí</a><span className="header-divider" aria-hidden="true" /><div><span className="header-caption">Terméktervező</span><h1>{profile.name}</h1></div><AdminLink /></div>
        <div className="header-actions">
          <div className="designer-price" aria-live="polite" aria-label={price ? `Helyi tesztár: ${price}` : "A Shopify variánsára nem érhető el"}>
            <span>{price ? "Helyi tesztár" : "Shopify-ár"}</span>
            <strong>{price ?? "Nem érhető el"}</strong>
          </div>
          <button type="button" className="header-action" onClick={undo} disabled={busy || !history.past.length} aria-label="Visszavonás" title="Visszavonás"><span aria-hidden="true">↶</span><span className="action-text">Visszavonás</span></button>
          <button type="button" className="header-action" onClick={redo} disabled={busy || !history.future.length} aria-label="Újra" title="Újra"><span aria-hidden="true">↷</span><span className="action-text">Újra</span></button>
          <button type="button" className="primary-button" onClick={save} disabled={busy}>Terv letöltése</button>
          <button type="button" className="primary-button" onClick={() => void saveCustomerRequest()} disabled={busy}>Igénycsomag beküldése</button>
        </div>
      </header>
      <div className={`layout mobile-${mobilePanel}`}>
        <aside className="tools-panel" aria-label="Termék és anyag">
          <div className="panel-heading"><span className="eyebrow">A TE TERMÉKED</span><h2>{profile.name}</h2><p className="hint">Válassz anyagot és színt a személyre szabáshoz.</p></div>
          <section className="material-panel" aria-labelledby="material-title">
            <h2 id="material-title">Anyag</h2>
            <div className="material-options" role="group" aria-label="Anyagok">
              {materials.map((option) => (
                <button type="button" key={option.id} className="material-option" disabled={busy}
                  aria-pressed={material.id === option.id} onClick={() => setMaterial(option.id)}>
                  <img src={option.previewUrl || profile.photo} alt="" /><span>{option.name}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="fabric-panel" aria-labelledby="fabric-title">
            <h2 id="fabric-title">Szín</h2>
            <div className="color-options" role="group" aria-label="Anyagszínek">
              <button type="button" className="fabric-original" disabled={busy}
                aria-pressed={!present.fabricColor} onClick={() => setFabricColor()}>{material.preview.applyTexture ? "Alapárnyalat" : "Eredeti fotó"}</button>
              {material.colors.filter((entry) => entry.active !== false).map(({ name, color }) => (
                <button type="button" className="color-option" key={color} disabled={busy}
                  aria-label={name} aria-pressed={present.fabricColor?.toLowerCase() === color}
                  onClick={() => setFabricColor(color)}>
                  <span style={{ backgroundColor: color }} aria-hidden="true" /><span>{name}</span>
                </button>
              ))}
            </div>
            <label className="fabric-custom">Egyedi szín
              <input type="color" value={present.fabricColor ?? material.preview.baseColor} disabled={busy}
                onChange={(event) => setFabricColor(event.target.value)} />
            </label>
          </section>
        </aside>
        <section className="canvas-panel" aria-label="Szerkesztővászon">
          <div className="canvas-heading">
            <div><span className="eyebrow">A TE TERVED</span><h2>Tervezd meg a sajátod</h2></div>
            {selectableViews.length > 1
              ? <div className="view-switch" role="group" aria-label="Terméknézet">
                  {selectableViews.map((key) => <button key={key} type="button" aria-pressed={view === key} disabled={busy}
                    className={view === key ? "selected" : ""} onClick={() => { setMessage(""); onViewChange(key); }}>{EDITOR_VIEW_LABELS[key]}</button>)}
                </div>
              : <span className="canvas-badge">Előnézet</span>}
          </div>
          <div className="canvas-viewport" ref={viewportRef} aria-label="Nagyítható termékelőnézet">
          <div className="canvas-zoom-content" style={{ width: `${zoom * 100}%` }}>
          <div className={`stage${exporting ? " is-exporting" : ""}`} ref={stageRef}
            data-export-view={view} data-export-design={designStamp(present)}
            style={{ aspectRatio: `${present.canvas.width} / ${present.canvas.height}` }} onPointerDown={() => setSelectedId(null)}>
            <img className="product-photo" src={activeMaterialPreview.photoUrl} alt={`${profile.name} termékfotója`} onError={() => setVisualError("A termékfotó nem tölthető be; az előnézet nem használható.")} />
            {(present.fabricColor || activeMaterialPreview.applyTexture) && <TextilePreviewCanvas key={`${material.id}-${present.fabricColor ?? "base"}-${view}`} photoUrl={activeMaterialPreview.photoUrl}
              colorMaskUrl={activeMaterialPreview.colorMaskUrl} color={present.fabricColor ?? activeMaterialPreview.baseColor}
              textureUrl={material.preview.applyTexture ? material.textureUrl : undefined}
              textureMapping={material.preview.textureMapping} onError={setFabricError} />}
            <div className="surface" style={{ maskImage: `url("${activeMaterialPreview.surfaceMaskUrl}")`, WebkitMaskImage: `url("${activeMaterialPreview.surfaceMaskUrl}")` }}>
              {present.layers.map((layer) => (
                <div
                  key={layer.id}
                  className={`layer ${layer.type === "image" && layer.pattern ? "pattern-layer" : ""} ${layer.id === selectedId ? "selected" : ""}`}
                  style={layer.type === "image" && layer.pattern ? undefined : {
                    left: `${layer.x / present.canvas.width * 100}%`,
                    top: `${layer.y / present.canvas.height * 100}%`,
                    width: `${layer.width / present.canvas.width * 100}%`,
                    height: `${layer.height / present.canvas.height * 100}%`,
                    transform: `translate(-50%, -50%) rotate(${layer.rotation}deg)`,
                    color: layer.type === "text" ? layer.color : undefined,
                  }}
                  onPointerDown={(event) => startDrag(event, layer)}
                  onPointerMove={moveDrag}
                  onPointerUp={(event) => endDrag(event)}
                  onPointerCancel={(event) => endDrag(event, true)}
                >
                  {layer.type === "text" ? <TextArtwork layer={layer} /> : layer.pattern ? (
                    <svg viewBox={`0 0 ${present.canvas.width} ${present.canvas.height}`} preserveAspectRatio="none" aria-hidden="true">
                      <defs>
                        <pattern id={`pattern-${layer.id}`} patternUnits="userSpaceOnUse"
                          x={layer.x - layer.width / 2} y={layer.y - layer.height / 2}
                          width={layer.width} height={layer.height}
                          patternTransform={`rotate(${layer.rotation} ${layer.x} ${layer.y})`}>
                          <image href={layer.src} width={layer.width} height={layer.height} preserveAspectRatio="none" />
                        </pattern>
                      </defs>
                      <rect width={present.canvas.width} height={present.canvas.height} fill={`url(#pattern-${layer.id})`} />
                    </svg>
                  ) : layer.edit ? (
                    <svg viewBox={`${layer.edit.crop.left} ${layer.edit.crop.top} ${1 - layer.edit.crop.left - layer.edit.crop.right} ${1 - layer.edit.crop.top - layer.edit.crop.bottom}`}
                      preserveAspectRatio="none" aria-hidden="true"
                      style={{ opacity: layer.edit.opacity, transform: `scale(${layer.edit.flipX ? -1 : 1}, ${layer.edit.flipY ? -1 : 1})` }}>
                      <image href={layer.src} width="1" height="1" preserveAspectRatio="none" />
                    </svg>
                  ) : <img src={layer.src} alt="" draggable={false} />}
                </div>
              ))}
            </div>
            {(profile.protectMasks ?? []).map((mask) => (
              <div key={mask.id} className="protected-surface"
                style={{ maskImage: `url("${mask.url}")`, WebkitMaskImage: `url("${mask.url}")` }}
                aria-hidden="true">
                <img src={profile.photo} alt="" />
              </div>
            ))}
          </div>
          </div>
          </div>
          <div className="canvas-footer">
            <p className="hint">Húzd az elemeket a terméken; a mintamaszk határozza meg a látható területet.</p>
            <div className="zoom-controls" role="group" aria-label="Vászon nagyítása">
              <button type="button" aria-label="Kicsinyítés" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, Number((value - .25).toFixed(2))))}>−</button>
              <span aria-live="polite">{Math.round(zoom * 100)}%</span>
              <button type="button" aria-label="Nagyítás" disabled={zoom >= 2.5} onClick={() => setZoom((value) => Math.min(2.5, Number((value + .25).toFixed(2))))}>＋</button>
              <button type="button" className="center-button" onClick={centerCanvas}>Középre</button>
            </div>
          </div>
          {visualError && <p className="visual-error" role="alert">{visualError}</p>}
          {fabricError && <p className="visual-error" role="alert">{fabricError}</p>}
          <p className="canvas-disclaimer">A maszkolt 2D előnézet tájékoztató jellegű, nem gyártási látványterv.</p>
          {unavailablePatterns.length > 0 && <p className="material-warning" role="status">A tervben olyan minta is szerepel, amely ehhez az anyaghoz jelenleg nem választható. A mintaréteg megmaradt; ellenőrizd az anyaggal való használhatóságát.</p>}
        </section>
        <nav className="mobile-nav" aria-label="Szerkesztőpanel">
          <button type="button" aria-pressed={mobilePanel === "materials"} onClick={() => setMobilePanel("materials")}>Anyag és szín</button>
          <button type="button" aria-pressed={mobilePanel === "tools"} onClick={() => setMobilePanel("tools")}>Tervezés</button>
        </nav>
        <aside className="panel" aria-label="Tervezési eszközök és rétegek">
          <div className="panel-heading"><span className="eyebrow">SZEMÉLYRE SZABÁS</span><h2>Tervezési eszközök</h2><p className="hint">{selected ? "A kijelölt elem személyre szabása." : "Adj mintát, képet vagy saját feliratot a termékhez."}</p></div>
          <details className="tool-disclosure" open>
            <summary>Minták <span>{availablePatterns.length} választható</span></summary>
            <section className="pattern-library" aria-label="Mintakönyvtár">
              <div className="pattern-grid">
                {availablePatterns.map((pattern) => (
                  <button type="button" className="pattern-option" key={pattern.id} onClick={() => void addPattern(pattern)} disabled={busy}
                    aria-pressed={selectedPattern?.id === pattern.id}>
                    <img src={pattern.previewUrl} alt="" /><span>{pattern.name}</span>
                  </button>
                ))}
              </div>
              {availablePatterns.length === 0 && <p className="hint">Ehhez az anyaghoz jelenleg nincs választható minta.</p>}
              <p className="hint">A minta csak a mintamaszk átlátszatlan területén jelenik meg.</p>
            </section>
          </details>
          {settings.imageUpload && <details className="tool-disclosure">
            <summary>Saját grafika <span>{Math.floor(settings.maxUploadBytes / (1024 * 1024))} MB-ig</span></summary>
            <label className={`upload-action ${busy ? "disabled" : ""}`}>Kép kiválasztása<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={addImages} disabled={busy} /></label>
            <p className="hint">PNG, JPEG vagy WebP; a kép a mintamaszk területére vágódik.</p>
          </details>}
          {settings.customText && <details className="tool-disclosure">
            <summary>Felirat <span>Legfeljebb {settings.maxTextLength} karakter</span></summary>
            <button type="button" className="add-text-button" onClick={addText} disabled={busy}>＋ Szöveg hozzáadása</button>
          </details>}
          <details className="tool-disclosure layer-disclosure" open={present.layers.length > 0}>
            <summary>Rétegek <span>{present.layers.length}</span></summary>
            {present.layers.length === 0 ? <p className="hint">Az elemeid itt jelennek meg.</p> : (
              <ol className="layers">
                {[...present.layers].reverse().map((layer) => (
                  <li key={layer.id}>
                    <button type="button" className={layer.id === selectedId ? "active" : ""} disabled={busy} onClick={() => { setSelectedId(layer.id); setMobilePanel("tools"); }}>
                      {layer.type === "text" ? `Szöveg: ${layer.text || "(üres)"}` : layer.name.startsWith("Minta: ") ? layer.name : `Kép: ${layer.name}`}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </details>
          <details className="tool-disclosure">
            <summary>Korábbi terv</summary>
            <label className={`upload-action ${busy ? "disabled" : ""}`}>JSON-terv betöltése<input type="file" accept=".json,application/json" onChange={load} disabled={busy} /></label>
            <p className="hint">A terv kizárólag ehhez a termékhez tölthető vissza.</p>
          </details>
          {selected && (
            <div className="controls">
              <details open>
                <summary>{selected.type === "text" ? "Szöveg" : selected.pattern ? "Minta" : "Kép"} beállításai</summary>
              <fieldset className="editor-controls" disabled={busy}>
              {selected.type === "text" && selectedTextStyle && <>
                <label>Szöveg
                  <textarea maxLength={settings.maxTextLength} rows={3} value={selected.text} onChange={(event) => updateLayer(selected.id, (layer) => layer.type === "text" ? { ...layer, text: event.target.value.slice(0, settings.maxTextLength) } : layer)} />
                </label>
                <div className="text-properties">
                  <label>Betűtípus
                    <select value={selectedTextStyle.font} onChange={(event) => {
                      if (isTextFont(event.target.value)) updateTextStyle(selected.id, { font: event.target.value });
                    }}>
                      {Object.entries(TEXT_FONTS).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}
                    </select>
                  </label>
                  <label>Szöveg színe
                    <input type="color" value={selected.color} onChange={(event) => updateLayer(selected.id, (layer) => layer.type === "text" ? { ...layer, color: event.target.value } : layer)} />
                  </label>
                </div>
                <label>Betűméret: {selectedTextStyle.size}%
                  <input type="range" min="10" max="150" step="1" value={selectedTextStyle.size}
                    onChange={(event) => updateTextStyle(selected.id, { size: Number(event.target.value) })} />
                </label>
                {layoutText(selected).fitted && <p className="hint">A szöveg automatikusan kisebb a beállítottnál, hogy beleférjen a rétegbe.</p>}
                <div className="text-format" role="group" aria-label="Betűstílus">
                  <button type="button" aria-pressed={selectedTextStyle.bold} onClick={() => updateTextStyle(selected.id, { bold: !selectedTextStyle.bold })}><strong>Félkövér</strong></button>
                  <button type="button" aria-pressed={selectedTextStyle.italic} onClick={() => updateTextStyle(selected.id, { italic: !selectedTextStyle.italic })}><em>Dőlt</em></button>
                </div>
                <div className="text-format" role="group" aria-label="Szöveg igazítása">
                  {([["left", "Balra"], ["center", "Középre"], ["right", "Jobbra"]] as const).map(([value, label]) => (
                    <button type="button" key={value} aria-pressed={selectedTextStyle.align === value}
                      onClick={() => updateTextStyle(selected.id, { align: value })}>{label}</button>
                  ))}
                </div>
                <label>Betűköz: {selectedTextStyle.letterSpacing.toFixed(2)} em
                  <input type="range" min="-0.05" max="0.5" step="0.01" value={selectedTextStyle.letterSpacing}
                    onChange={(event) => updateTextStyle(selected.id, { letterSpacing: Number(event.target.value) })} />
                </label>
                <label>Sorköz: {selectedTextStyle.lineHeight.toFixed(1)}
                  <input type="range" min="0.8" max="3" step="0.1" value={selectedTextStyle.lineHeight}
                    onChange={(event) => updateTextStyle(selected.id, { lineHeight: Number(event.target.value) })} />
                </label>
              </>}
              {selectedPattern && selected.type === "image" && selected.pattern && (
                <fieldset className="pattern-colors">
                  <legend>Mintaszín (ideiglenes példák)</legend>
                  <div className="color-options">
                    {selectedPattern.variants.map((variant) => (
                      <button type="button" key={variant.id} className="color-option"
                        aria-label={variant.name} title={variant.name}
                        aria-pressed={selected.pattern?.variantId === variant.id} disabled={busy}
                        onClick={() => void changePatternVariant(selected.id, selectedPattern, variant)}>
                        <span style={{ backgroundColor: variant.color }} aria-hidden="true" />
                        <span>{variant.name}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              {selected.type === "image" && selectedEdit && (
                <section className="image-editor" aria-label="Kép szerkesztése">
                  <label className="button secondary">Kép cseréje
                    <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void replaceImage(event, selected.id)} />
                  </label>
                  <label>Átlátszatlanság: {Math.round(selectedEdit.opacity * 100)}%
                    <input type="range" min="0" max="100" step="1" value={selectedEdit.opacity * 100}
                      onChange={(event) => updateImageEdit(selected.id, { opacity: Number(event.target.value) / 100 })} />
                  </label>
                  <div className="text-format" role="group" aria-label="Kép tükrözése">
                    <button type="button" aria-pressed={selectedEdit.flipX} onClick={() => updateImageEdit(selected.id, { flipX: !selectedEdit.flipX })}>Vízszintes tükrözés</button>
                    <button type="button" aria-pressed={selectedEdit.flipY} onClick={() => updateImageEdit(selected.id, { flipY: !selectedEdit.flipY })}>Függőleges tükrözés</button>
                  </div>
                  <details className="crop-controls">
                    <summary>Kivágás és képarány</summary>
                    <p className="hint">A kereten belüli rész látszik; az eredeti kép megmarad.</p>
                    <div className="crop-preview">
                      <img src={selected.src} alt="Eredeti kép a kivágás beállításához" />
                      <div className="crop-selection" aria-hidden="true" style={{
                        left: `${selectedEdit.crop.left * 100}%`, right: `${selectedEdit.crop.right * 100}%`,
                        top: `${selectedEdit.crop.top * 100}%`, bottom: `${selectedEdit.crop.bottom * 100}%`,
                      }} />
                    </div>
                    <div className="text-format" role="group" aria-label="Képarány">
                      <button type="button" disabled={!selectedImageSize} onClick={() => updateCrop(selected.id, { ...DEFAULT_IMAGE_EDIT.crop })}>Eredeti</button>
                      {([["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["16:9", 16 / 9]] as const).map(([label, ratio]) => (
                        <button type="button" key={label} disabled={!selectedImageSize} onClick={() => {
                          if (selectedImageSize) updateCrop(selected.id, cropToAspect(selectedImageSize.width, selectedImageSize.height, ratio));
                        }}>{label}</button>
                      ))}
                    </div>
                    {([["left", "Bal"], ["right", "Jobb"], ["top", "Felső"], ["bottom", "Alsó"]] as const).map(([edge, label]) => {
                      const opposite = edge === "left" ? "right" : edge === "right" ? "left" : edge === "top" ? "bottom" : "top";
                      return <label key={edge}>{label} kivágás: {Math.round(selectedEdit.crop[edge] * 100)}%
                        <input type="range" min="0" max={Math.max(0, Math.floor((0.99 - selectedEdit.crop[opposite]) * 100))} step="1"
                          value={selectedEdit.crop[edge] * 100} disabled={!selectedImageSize}
                          onChange={(event) => updateCrop(selected.id, { ...selectedEdit.crop, [edge]: Number(event.target.value) / 100 })} />
                      </label>;
                    })}
                  </details>
                </section>
              )}
              <div className="position-controls">
                {([["x", "Vízszintes pozíció"], ["y", "Függőleges pozíció"]] as const).map(([axis, label]) => (
                  <PositionInput key={`${selected.id}-${axis}`} label={label} value={selected[axis]}
                    onInvalid={() => setMessage("Adj meg érvényes pozíciót.")}
                    onCommit={(value) => updateLayer(selected.id, (layer) => ({ ...layer, [axis]: value }))} />
                ))}
              </div>
              <p className="hint">A pozíció középpontja a referenciafotó képpont-koordinátáit használja.</p>
              <label>Réteg mérete: {Math.round(selected.width)}
                <input type="range" min={Math.min(10, selected.width)} max={Math.max(10, Math.round(present.canvas.width * 1.5))} value={selected.width}
                  onChange={(event) => {
                    const width = Number(event.target.value);
                    updateLayer(selected.id, (layer) => ({ ...layer, width, height: layer.height * width / layer.width }));
                  }} />
              </label>
              <label>Forgatás: {Math.round(selected.rotation)}°
                <input type="range" min="-180" max="180" value={Math.max(-180, Math.min(180, selected.rotation))}
                  onChange={(event) => updateLayer(selected.id, (layer) => ({ ...layer, rotation: Number(event.target.value) }))} />
              </label>
              <div className="row">
                <button type="button" onClick={() => moveLayer(1)} disabled={selectedIndex === present.layers.length - 1}>Előrébb</button>
                <button type="button" onClick={() => moveLayer(-1)} disabled={selectedIndex === 0}>Hátrébb</button>
                <button type="button" className="danger" onClick={deleteLayer}>Törlés</button>
              </div>
              <p className="hint">Billentyűs mozgatás:</p>
              <div className="row" aria-label="Elem mozgatása">
                {([["←", -10, 0], ["↑", 0, -10], ["↓", 0, 10], ["→", 10, 0]] as const).map(([label, dx, dy]) => (
                  <button type="button" key={label} aria-label={`Mozgatás ${label}`} onClick={() => updateLayer(selected.id, (layer) => ({
                    ...layer,
                    x: layer.x + dx,
                    y: layer.y + dy,
                  }))}>{label}</button>
                ))}
              </div>
              </fieldset>
              </details>
            </div>
          )}
        </aside>
      </div>
      <p className="status" role="status" aria-live="polite">{busy ? "Feldolgozás…" : message}</p>
    </main>
  );
}

function App() {
  const [products, setProducts] = useState<EditorProduct[] | null>(null);
  const [selected, setSelected] = useState<EditorProduct | null>(null);
  const [viewProfiles, setViewProfiles] = useState<Partial<Record<EditorViewKey, EditorProfile>>>({});
  const [view, setView] = useState<EditorViewKey>("front");
  const [designs, setDesigns] = useState<Partial<Record<EditorViewKey, Design>>>({});
  const [error, setError] = useState("");
  const disposers = useRef<Array<() => void>>([]);
  const route = /^\/szerkeszto\/([^/]+)\/?$/.exec(window.location.pathname);
  const routeSlug = route?.[1] ?? "";
  useEffect(() => {
    let active = true;
    let sequence = 0;
    async function refresh() {
      const current = ++sequence;
      try {
        const catalog = routeSlug ? [await readDesignerProduct(routeSlug)].filter((item): item is EditorProduct => item !== null)
          : await readCatalog();
        const available = catalog.filter((item) => item.active && item.editorSettings?.enabled2d !== false);
        const target = available[0];
        const result = await resolveCatalog(target ? [target] : []);
        if (!active || current !== sequence) { result.dispose(); return; }
        disposers.current.push(result.dispose);
        const resolved = result.products[0];
        if (!resolved) {
          setProducts([]);
          setSelected(null);
          setViewProfiles({});
          setDesigns({});
          setError("");
          return;
        }
        const configured = editorProductViews(resolved.profile);
        const profiles: Partial<Record<EditorViewKey, EditorProfile>> = {};
        const skipped: string[] = [];
        for (const key of EDITOR_VIEW_KEYS) {
          const configuredView = configured[key];
          if (!configuredView?.photo || !configuredView.fabricMask || !configuredView.surfaceMask) continue;
          try {
            const sources = [configuredView.photo, configuredView.fabricMask, configuredView.surfaceMask,
              ...configuredView.protectMasks.map((mask) => mask.url)];
            const images = await Promise.all(sources.map(async (src) => {
              const image = new Image();
              image.src = src;
              await image.decode();
              return { width: image.naturalWidth, height: image.naturalHeight };
            }));
            const [photo, ...masks] = images;
            if (!photo.width || !photo.height || photo.width > 10000 || photo.height > 10000 ||
                photo.width * photo.height > 40_000_000 ||
                masks.some((mask) => mask.width !== photo.width || mask.height !== photo.height)) {
              throw new Error("A referenciafotó és maszkjai méretben nem egyeznek.");
            }
            profiles[key] = editorViewProfile(resolved.profile, {
              ...configuredView, canvas: { width: photo.width, height: photo.height },
            });
          } catch (reason) {
            skipped.push(`${EDITOR_VIEW_LABELS[key]}: ${reason instanceof Error ? reason.message : "érvénytelen konfiguráció"}`);
          }
        }
        if (!Object.keys(profiles).length) {
          throw new Error(skipped.join(" ") || "A termékhez nincs teljesen konfigurált nézet.");
        }
        const initialView = profiles.front ? "front" : EDITOR_VIEW_KEYS.find((key) => profiles[key])!;
        setProducts([resolved]);
        setSelected(resolved);
        setViewProfiles(profiles);
        setView(initialView);
        setDesigns(Object.fromEntries(EDITOR_VIEW_KEYS.flatMap((key) =>
          profiles[key] ? [[key, newDesign(profiles[key]!, resolved.materials[0].id)]] : [],
        )));
        setError(skipped.length ? `Egyes hibás nézetek nem jelentek meg. ${skipped.join(" ")}` : "");
      } catch (reason) {
        if (active && current === sequence) setError(reason instanceof Error ? reason.message : "A termékek nem tölthetők be.");
      }
    }
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const cleanup = disposers.current;
    return () => { active = false; window.removeEventListener("focus", onFocus); cleanup.forEach((dispose) => dispose()); cleanup.length = 0; };
  }, [routeSlug]);
  const reportDesign = useCallback((key: EditorViewKey, design: Design) => {
    setDesigns((current) => current[key] === design ? current : { ...current, [key]: design });
  }, []);
  const restoreDesigns = useCallback((next: Partial<Record<EditorViewKey, Design>>) => {
    setDesigns((current) => ({ ...current, ...next }));
  }, []);
  if (!products || !selected) return <main className="catalog-notice">
    <p role="status">{error || (products ? routeSlug ? "Ez a termék nem található vagy nem aktív." : "Nincs aktív szerkeszthető termék." : "Termékek betöltése…")}</p>
    <AdminLink />
  </main>;
  return <>{error && <p className="catalog-warning" role="alert">{error}</p>}
    <Editor key={selected.profile.productId} product={selected} view={view} viewProfiles={viewProfiles} designs={designs}
      onViewChange={setView} onDesignChange={reportDesign} onDesignsLoaded={restoreDesigns} />
  </>;
}

const root = document.getElementById("root");
if (!root) throw new Error("A szerkesztő gyökéreleme nem található.");
const reactRoot = createRoot(root);
reactRoot.render(<StrictMode><App /></StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => reactRoot.unmount());

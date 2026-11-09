import { StrictMode, useEffect, useState, type ChangeEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  designerProductSlug, editorProductViews, hasStoredCatalog, readCatalog, resolveCatalog, uploadCatalogImage, writeCatalog,
  type CatalogMaterial, type EditorProduct, type EditorSettings,
} from "../designer-prototype/catalog";
import {
  EDITOR_VIEW_KEYS, EDITOR_VIEW_LABELS, type EditorView, type EditorViewKey,
} from "../designer-prototype/profile";
import { decodeImage, validateImage } from "../designer-prototype/model";
import { deleteUnusedAsset } from "../data/designer-assets";
import { BUILTIN_DESIGN_PATTERNS } from "../data/builtinPatterns";
import { validateDesignerCatalog } from "../../functions/_shared/designer-catalog.js";
import { exportLocalCatalog, importLocalCatalog } from "./migration";
import { RequestsPage } from "./requests";
import "./style.css";

const makeId = () => crypto.randomUUID();
const defaultSettings: EditorSettings = {
  customText: true, maxTextLength: 200, imageUpload: true, maxUploadBytes: 5 * 1024 * 1024, enabled2d: true,
};

function blankProduct(name: string, slug: string): EditorProduct {
  const id = makeId();
  return {
    description: "",
    profile: {
      id: `profile-${id}`, productId: `product-${id}`, name,
      canvas: { width: 1000, height: 1000 },
      area: { x: 0, y: 0, width: 1000, height: 1000 },
      photo: "", fabricMask: "", surfaceMask: "", views: {},
    },
    slug, active: false, materials: [],
    editorSettings: { ...defaultSettings },
  };
}

function blankMaterial(product: EditorProduct): CatalogMaterial {
  return {
    id: `material-${makeId()}`, name: "Új anyag",
    layoutId: product.profile.id, previewUrl: "", textureUrl: "",
    preview: {
      photoUrl: product.profile.photo, colorMaskUrl: product.profile.fabricMask,
      surfaceMaskUrl: product.profile.surfaceMask, baseColor: "#e1b5b3",
      applyTexture: false, textureMapping: "cover-luminance",
    },
    colors: [], patterns: structuredClone(BUILTIN_DESIGN_PATTERNS),
  };
}

function imageDimensions(src: string): Promise<{ width: number; height: number; image: HTMLImageElement }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 10000 || image.naturalHeight > 10000 ||
          image.naturalWidth * image.naturalHeight > 40_000_000) {
        reject(new Error("A termékkép vagy maszk felbontása nem támogatott."));
      } else resolve({ width: image.naturalWidth, height: image.naturalHeight, image });
    };
    image.onerror = () => reject(new Error("Egy termékkép vagy maszk nem tölthető be."));
    image.src = src;
  });
}

async function validateMaskFormat(src: string) {
  const response = await fetch(src, { cache: "no-store" });
  if (!response.ok) throw new Error("A maszkfájl nem olvasható.");
  const type = response.headers.get("content-type")?.split(";")[0].toLowerCase();
  if (type !== "image/png" && type !== "image/webp") {
    throw new Error("A szín-, minta- és védőmaszkok csak PNG vagy WebP fájlok lehetnek.");
  }
}

async function checkAlignment(product: EditorProduct) {
  const views = editorProductViews(product.profile);
  for (const key of EDITOR_VIEW_KEYS) {
    const view = views[key];
    if (!view?.photo || !view.fabricMask || !view.surfaceMask) continue;
    const [photo, fabric, surface] = await Promise.all([
      imageDimensions(view.photo), imageDimensions(view.fabricMask), imageDimensions(view.surfaceMask),
    ]);
    const protectedMasks = await Promise.all(view.protectMasks.map((mask) => imageDimensions(mask.url)));
    await Promise.all([view.fabricMask, view.surfaceMask, ...view.protectMasks.map((mask) => mask.url)].map(validateMaskFormat));
    if ([fabric, surface, ...protectedMasks].some((mask) => mask.width !== photo.width || mask.height !== photo.height)) {
      throw new Error(`${EDITOR_VIEW_LABELS[key]}: a maszkok képpontmérete nem egyezik a referenciafotóéval.`);
    }
    if (photo.width !== view.canvas.width || photo.height !== view.canvas.height) {
      throw new Error(`${EDITOR_VIEW_LABELS[key]}: a vászon mérete nem egyezik a referenciafotó természetes képméretével.`);
    }
    for (const mask of [fabric, surface, ...protectedMasks]) {
      const canvas = document.createElement("canvas");
      canvas.width = mask.width;
      canvas.height = mask.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("A maszk nem ellenőrizhető.");
      ctx.drawImage(mask.image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = false;
      let transparent = false;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 0) visible = true;
        if (pixels[i] < 255) transparent = true;
        if (visible && transparent) break;
      }
      if (!visible || !transparent) throw new Error(`${EDITOR_VIEW_LABELS[key]}: a maszknak látható és átlátszó területet is tartalmaznia kell.`);
    }
  }
}

async function normalizeReferenceGeometry(products: EditorProduct[]): Promise<EditorProduct[]> {
  const resolved = await resolveCatalog(products);
  try {
    return await Promise.all(products.map(async (product) => {
      const resolvedProduct = resolved.products.find((item) => item.profile.productId === product.profile.productId);
      if (!resolvedProduct) return product;
      const views = editorProductViews(product.profile);
      const resolvedViews = editorProductViews(resolvedProduct.profile);
      const normalizedViews: Partial<Record<EditorViewKey, EditorView>> = {};
      for (const key of EDITOR_VIEW_KEYS) {
        const view = views[key];
        const resolvedView = resolvedViews[key];
        if (!view || !resolvedView) continue;
        if (!resolvedView.photo) { normalizedViews[key] = view; continue; }
        const { width, height } = await imageDimensions(resolvedView.photo);
        const photos = await Promise.all(view.photos.map(async (photo) => {
          const resolvedPhoto = resolvedView.photos.find((item) => item.id === photo.id);
          if (!resolvedPhoto) return photo;
          const dimensions = await imageDimensions(resolvedPhoto.url);
          return { ...photo, width: dimensions.width, height: dimensions.height };
        }));
        normalizedViews[key] = {
          ...view, canvas: { width, height },
          photos,
        };
      }
      const front = normalizedViews.front;
      const frontPhoto = front?.photo;
      const dimensions = front?.canvas ?? product.profile.canvas;
      return {
        ...product,
        profile: {
          ...product.profile,
          ...(front ? {
            photo: front.photo, fabricMask: front.fabricMask, surfaceMask: front.surfaceMask,
            photos: front.photos, protectMasks: front.protectMasks,
            canvas: dimensions,
            area: { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
          } : {}),
          views: normalizedViews,
        },
        ...(frontPhoto ? { materials: product.materials.map((material) => ({
          ...material,
          preview: { ...material.preview, photoUrl: front!.photo, colorMaskUrl: front!.fabricMask, surfaceMaskUrl: front!.surfaceMask },
        })) } : {}),
      };
    }));
  } finally { resolved.dispose(); }
}

function App() {
  const [products, setProducts] = useState<EditorProduct[]>([]);
  const [newName, setNewName] = useState("");
  const route = /^\/termekek\/([^/]+)\/?$/.exec(window.location.pathname);
  const routeSlug = route?.[1] ?? "";
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [preview, setPreview] = useState<EditorProduct | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [step, setStep] = useState(0);
  const [mask, setMask] = useState<string>("surfaceMask");
  const [adminView, setAdminView] = useState<EditorViewKey>("front");
  const [imageSizes, setImageSizes] = useState<Record<string, string>>({});
  const [detachedFiles, setDetachedFiles] = useState<Array<{ url: string; label: string }>>([]);
  const selected = products.find((item) => item.profile.productId === selectedProductId)
    ?? products.find((item) => designerProductSlug(item) === routeSlug);
  const selectedId = selected?.profile.productId;

  useEffect(() => {
    let live = true;
    readCatalog(true).then(async (items) => {
      if (!live) return;
      const normalized = await normalizeReferenceGeometry(items);
      if (!live) return;
      const changed = normalized.some((item, index) =>
        !items[index].profile.views ||
        item.profile.canvas.width !== items[index].profile.canvas.width ||
        item.profile.canvas.height !== items[index].profile.canvas.height ||
        item.profile.area.x !== items[index].profile.area.x ||
        item.profile.area.y !== items[index].profile.area.y ||
        item.profile.area.width !== items[index].profile.area.width ||
        item.profile.area.height !== items[index].profile.area.height,
      );
      setProducts(normalized);
      setDirty(changed);
      if (changed) setMessage("A régi képadatok kompatibilisen nézetekké alakultak, a méretek automatikusan a referenciafotókhoz igazodtak. Mentsd el a frissítést.");
      setSelectedProductId(normalized.find((item) => designerProductSlug(item) === routeSlug)?.profile.productId ?? null);
      setLoaded(true);
    }).catch((error: unknown) => {
      if (live) setMessage(error instanceof Error ? error.message : "A termékek nem tölthetők be.");
    });
    return () => { live = false; };
  }, [routeSlug]);

  useEffect(() => {
    if (!selected) { setPreview(null); return; }
    let live = true;
    let dispose: (() => void) | undefined;
    resolveCatalog([selected]).then((result) => {
      if (!live) { result.dispose(); return; }
      dispose = result.dispose;
      setPreview(result.products[0]);
    }).catch((error: unknown) => {
      if (live) { setPreview(null); setMessage(error instanceof Error ? error.message : "Az előnézet nem tölthető be."); }
    });
    return () => { live = false; dispose?.(); };
  }, [selected]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function update(change: (product: EditorProduct) => EditorProduct) {
    setProducts((current) => current.map((item) => item.profile.productId === selectedId ? change(item) : item));
    setDirty(true);
  }

  const viewData = selected ? editorProductViews(selected.profile)[adminView] : undefined;

  useEffect(() => { setAdminView("front"); setMask("surfaceMask"); }, [selectedId]);

  function updateView(change: (view: EditorView) => EditorView, key = adminView) {
    if (!selected) return;
    update((product) => {
      const currentViews = editorProductViews(product.profile);
      const current = currentViews[key] ?? {
        photos: [], photo: "", canvas: { width: 1000, height: 1000 }, fabricMask: "", surfaceMask: "", protectMasks: [],
      };
      const view = change(current);
      const views = { ...currentViews, [key]: view };
      const profile = key === "front" ? {
        ...product.profile, views, photo: view.photo, fabricMask: view.fabricMask, surfaceMask: view.surfaceMask,
        photos: view.photos, protectMasks: view.protectMasks, canvas: view.canvas,
        area: { x: 0, y: 0, width: view.canvas.width, height: view.canvas.height },
      } : { ...product.profile, views };
      return {
        ...product, profile,
        ...(key === "front" ? { materials: product.materials.map((material) => ({
          ...material, preview: {
            ...material.preview, photoUrl: view.photo, colorMaskUrl: view.fabricMask, surfaceMaskUrl: view.surfaceMask,
          },
        })) } : {}),
      };
    });
  }

  function recordImageSize(url: string, image: HTMLImageElement) {
    const size = `${image.naturalWidth} × ${image.naturalHeight} px`;
    setImageSizes((current) => current[url] === size ? current : { ...current, [url]: size });
  }

  function rememberDetached(url: string, label: string) {
    if (!/^local:[a-f0-9-]{36}$/.test(url) && !/^\/api\/assets\/[a-f0-9-]{36}$/.test(url)) return;
    setDetachedFiles((current) => current.some((item) => item.url === url) ? current : [...current, { url, label }]);
  }

  async function permanentlyDeleteDetached(file: { url: string; label: string }) {
    if (dirty) { setMessage("A fájl törlése előtt mentsd el a katalógus módosításait."); return; }
    if (!window.confirm(`Véglegesen törlöd a(z) „${file.label}” fájlt? A rendszer előbb ellenőrzi, hogy maradt-e rá hivatkozás.`)) return;
    setBusy(true);
    try {
      await deleteUnusedAsset(file.url, products);
      setDetachedFiles((current) => current.filter((item) => item.url !== file.url));
      setMessage(`A(z) „${file.label}” fájl véglegesen törölve.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A fájl biztonságos törlése sikertelen.");
    } finally { setBusy(false); }
  }

  function getImageSize(url: string) {
    try { return imageSizes[new URL(url, window.location.href).href] ?? imageSizes[url]; }
    catch { return imageSizes[url]; }
  }

  function updateMaterial(index: number, change: (material: CatalogMaterial) => CatalogMaterial) {
    update((product) => ({ ...product, materials: product.materials.map((item, i) => i === index ? change(item) : item) }));
  }

  async function upload(event: ChangeEvent<HTMLInputElement>, apply: (url: string, name: string) => void, maskFile = false) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setBusy(true);
    try {
      await validateImage(file);
      if (maskFile && !["image/png", "image/webp"].includes(file.type)) throw new Error("A maszk átlátszóságot támogató PNG vagy WebP legyen.");
      const objectUrl = URL.createObjectURL(file);
      try {
        await decodeImage(objectUrl);
        if (maskFile) {
          const image = await imageDimensions(objectUrl);
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("A maszk átlátszósága nem ellenőrizhető.");
          context.drawImage(image.image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let visible = false;
          let transparent = false;
          for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] > 0) visible = true;
            if (pixels[i] < 255) transparent = true;
            if (visible && transparent) break;
          }
          if (!visible || !transparent) throw new Error("A maszknak látható és átlátszó területet is tartalmaznia kell.");
        }
      } finally { URL.revokeObjectURL(objectUrl); }
      const url = await uploadCatalogImage(file);
      apply(url, file.name);
      setMessage("Kép feltöltve. A terméket még mentsd el.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A kép feltöltése sikertelen.");
    } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true);
    try {
      const normalized = await normalizeReferenceGeometry(products);
      const validation = validateDesignerCatalog(normalized, import.meta.env.DEV);
      if (validation) throw new Error(validation);
      const resolved = await resolveCatalog(normalized.filter((item) => item.profile.views &&
        Object.values(item.profile.views).some((view) => view?.photo && view.fabricMask && view.surfaceMask),
      ));
      try {
        for (const product of resolved.products.filter((item) => item.active)) await checkAlignment(product);
      } finally { resolved.dispose(); }
      await writeCatalog(normalized);
      setProducts(normalized);
      setDirty(false);
      setMessage("A termékek mentve. Az aktív termékek a szerkesztőben megjelennek.");
      if (!selected && routeSlug) window.location.assign("/termekek/");
      else if (selected && designerProductSlug(selected) !== routeSlug) {
        window.location.assign(`/termekek/${designerProductSlug(selected)}`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A termékek mentése sikertelen.");
    } finally { setBusy(false); }
  }

  async function setProductActive(active: boolean) {
    if (!selected) return;
    if (!active) {
      update((product) => ({ ...product, active: false }));
      return;
    }
    setBusy(true);
    try {
      const [normalized] = await normalizeReferenceGeometry([{ ...selected, active: true }]);
      const validation = validateDesignerCatalog([normalized], import.meta.env.DEV);
      if (validation) throw new Error(validation);
      const resolved = await resolveCatalog([normalized]);
      try { await checkAlignment(resolved.products[0]); }
      finally { resolved.dispose(); }
      update((product) => ({ ...product, active: true }));
      setMessage("A nézetek maszkjai és méretei rendben vannak; a termék aktiválható.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A termék nem aktiválható.");
    } finally { setBusy(false); }
  }

  async function createProduct() {
    const name = newName.trim();
    if (!name || name.length > 120) { setMessage("Add meg az új termék nevét (legfeljebb 120 karakter)."); return; }
    if (dirty) { setMessage("Új termék létrehozása előtt mentsd el a módosításokat."); return; }
    const base = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "") || "termek";
    const used = new Set(products.map(designerProductSlug));
    let slug = base;
    for (let suffix = 2; used.has(slug); suffix++) slug = `${base}-${suffix}`;
    const product = blankProduct(name, slug);
    setProducts((current) => [...current, product]);
    setSelectedProductId(product.profile.productId);
    setNewName("");
    setStep(0);
    setDirty(true);
    setMessage("A termék vázlata létrejött. A mentéshez töltsd ki a kötelező adatokat.");
  }

  function removeProduct() {
    if (!selected || !window.confirm(`Törlöd a(z) „${selected.profile.name}” termékprofilt a katalógusból? A feltöltött fájlok a tárban maradnak.`)) return;
    const urls = JSON.stringify(selected).match(/(?:local:|\/api\/assets\/)[a-f0-9-]{36}/g) ?? [];
    for (const url of new Set(urls)) rememberDetached(url, selected.profile.name);
    setProducts((current) => current.filter((product) => product.profile.productId !== selected.profile.productId));
    setSelectedProductId(null);
    setDirty(true);
    setMessage("A termék eltávolítása függőben van. A módosítások mentésével lép életbe.");
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (dirty) { setMessage("Importálás előtt mentsd el a módosításokat."); return; }
    if (!window.confirm("Az importálás új termékeket és képfájlokat ad a katalógushoz. Eltérő meglévő terméket nem ír felül. Folytatod?")) return;
    setBusy(true);
    try {
      const merged = await importLocalCatalog(file, products, !hasStoredCatalog());
      const normalized = await normalizeReferenceGeometry(merged);
      const resolved = await resolveCatalog(normalized.filter((item) =>
        item.profile.photo && item.profile.fabricMask && item.profile.surfaceMask,
      ));
      try { for (const product of resolved.products.filter((item) => item.active)) await checkAlignment(product); }
      finally { resolved.dispose(); }
      await writeCatalog(normalized);
      setProducts(normalized);
      setMessage("A termékek importálása sikeres. A forrásadatok változatlanul megmaradtak.");
    } catch (error) {
      setMessage(`${error instanceof Error ? error.message : "Az importálás sikertelen."} A forrásadatok megmaradtak; a már feltöltött, nem használt képek a tárban maradhatnak.`);
    } finally { setBusy(false); }
  }

  async function uploadPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length || !selected) return;
    setBusy(true);
    try {
      const uploaded = await Promise.all(files.map(async (file) => {
        await validateImage(file);
        const objectUrl = URL.createObjectURL(file);
        try {
          const dimensions = await imageDimensions(objectUrl);
          const url = await uploadCatalogImage(file);
          return { id: makeId(), url, name: file.name.slice(0, 200), width: dimensions.width, height: dimensions.height };
        } finally { URL.revokeObjectURL(objectUrl); }
      }));
      updateView((view) => {
        const photos = [...view.photos, ...uploaded];
        const first = view.photo ? undefined : uploaded[0];
        return {
          ...view, photos,
          ...(first ? {
            photo: first.url, referencePhotoId: first.id,
            canvas: { width: first.width!, height: first.height! },
          } : {}),
        };
      });
      setMessage(`${uploaded.length} kép feltöltve a(z) ${EDITOR_VIEW_LABELS[adminView]} nézethez. Válaszd ki a referenciafotót.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A termékfotó feltöltése sikertelen.");
    } finally { setBusy(false); }
  }

  async function setReferencePhoto(photoId: string) {
    const selectedPhoto = viewData?.photos.find((photo) => photo.id === photoId);
    if (!selectedPhoto || !selected) return;
    setBusy(true);
    try {
      const resolvedPhoto = preview?.profile.views?.[adminView]?.photos.find((photo) => photo.id === selectedPhoto.id)?.url ?? selectedPhoto.url;
      const dimensions = await imageDimensions(resolvedPhoto);
      updateView((view) => ({
        ...view, photo: selectedPhoto.url, referencePhotoId: selectedPhoto.id,
        canvas: { width: dimensions.width, height: dimensions.height },
        photos: view.photos.map((photo) => photo.id === selectedPhoto.id
          ? { ...photo, width: dimensions.width, height: dimensions.height } : photo),
      }));
      setMessage(`${EDITOR_VIEW_LABELS[adminView]} referencia kiválasztva: ${dimensions.width} × ${dimensions.height} px. Ellenőrizd a nézet maszkjait.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A referenciafotó mérete nem olvasható.");
    } finally { setBusy(false); }
  }

  async function replacePhoto(event: ChangeEvent<HTMLInputElement>, photoId: string) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !viewData) return;
    setBusy(true);
    try {
      await validateImage(file);
      const objectUrl = URL.createObjectURL(file);
      let dimensions: { width: number; height: number };
      try { dimensions = await imageDimensions(objectUrl); }
      finally { URL.revokeObjectURL(objectUrl); }
      const url = await uploadCatalogImage(file);
      const oldPhoto = viewData.photos.find((photo) => photo.id === photoId);
      if (oldPhoto) rememberDetached(oldPhoto.url, oldPhoto.name);
      updateView((view) => ({
        ...view,
        photos: view.photos.map((photo) => photo.id === photoId ? {
          ...photo, url, name: file.name.slice(0, 200), width: dimensions.width, height: dimensions.height,
        } : photo),
        ...(view.referencePhotoId === photoId ? {
          photo: url, canvas: { width: dimensions.width, height: dimensions.height },
        } : {}),
      }));
      setMessage("A kép lecserélve; a korábbi fájl a tárban maradt.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A kép cseréje sikertelen.");
    } finally { setBusy(false); }
  }

  function removePhoto(photoId: string) {
    const photo = viewData?.photos.find((item) => item.id === photoId);
    if (!photo || !viewData) return;
    const isReference = viewData.referencePhotoId === photoId;
    const hasMasks = Boolean(viewData.fabricMask || viewData.surfaceMask || viewData.protectMasks.length);
    const warning = isReference && hasMasks
      ? " Ez a nézet referenciafotója, és maszkok tartoznak hozzá. A nézet a következő fotót használja referenciaként; a maszkok ellenőrzése szükséges."
      : "";
    if (!window.confirm(`Eltávolítod a(z) „${photo.name}” képet ebből a nézetből? A fájl nem törlődik véglegesen a tárból.${warning}`)) return;
    rememberDetached(photo.url, photo.name);
    updateView((view) => {
      const photos = view.photos.filter((item) => item.id !== photoId);
      if (!isReference) return { ...view, photos };
      const next = photos[0];
      return {
        ...view, photos, photo: next?.url ?? "", referencePhotoId: next?.id,
        ...(next?.width && next.height ? { canvas: { width: next.width, height: next.height } } : {}),
      };
    });
    setMessage("A kép hozzárendelése megszűnt. A fájl a tárban maradt, mert más hivatkozásai is lehetnek.");
  }

  function movePhoto(photoId: string, direction: -1 | 1) {
    updateView((view) => {
      const from = view.photos.findIndex((photo) => photo.id === photoId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= view.photos.length) return view;
      const photos = [...view.photos];
      [photos[from], photos[to]] = [photos[to], photos[from]];
      return { ...view, photos };
    });
  }

  function removeViewMask(field: "fabricMask" | "surfaceMask") {
    if (!viewData?.[field] || !window.confirm(`Eltávolítod a ${field === "fabricMask" ? "színmaszk" : "mintamaszk"} hozzárendelését a(z) ${EDITOR_VIEW_LABELS[adminView]} nézetből? A fájl nem törlődik a tárból.`)) return;
    rememberDetached(viewData[field], `${EDITOR_VIEW_LABELS[adminView]} ${field === "fabricMask" ? "színmaszk" : "mintamaszk"}`);
    updateView((view) => ({ ...view, [field]: "" }));
    setMessage("A maszk hozzárendelése megszűnt; a fájl megmaradt a tárban.");
  }

  function uploadViewMask(event: ChangeEvent<HTMLInputElement>, field: "fabricMask" | "surfaceMask") {
    const previous = viewData?.[field];
    void upload(event, (url) => {
      if (previous && previous !== url) rememberDetached(previous, `${EDITOR_VIEW_LABELS[adminView]} ${field}`);
      updateView((view) => ({ ...view, [field]: url }));
    }, true);
  }

  function addProtectMask(url: string, name: string) {
    updateView((view) => ({
      ...view, protectMasks: [...view.protectMasks, { id: makeId(), label: name.slice(0, 120), url }],
    }));
  }

  const previewView = preview?.profile.views?.[adminView];
  const selectedMaskUrl = mask === "fabricMask"
    ? previewView?.fabricMask
    : mask === "surfaceMask"
      ? previewView?.surfaceMask
      : previewView?.protectMasks.find((item) => item.id === mask)?.url;
  const steps = ["Alapadatok és képek", "Maszkok", "Anyagok, színek és Shopify", "Szerkesztőbeállítások", "Ellenőrzés és mentés"];

  function productIssues(product: EditorProduct): string[] {
    const issues: string[] = [];
    if (!product.profile.name.trim()) issues.push("Adj meg terméknevet.");
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(designerProductSlug(product))) issues.push("Adj meg érvényes, egyedi URL-azonosítót.");
    const configured = EDITOR_VIEW_KEYS.filter((key) => {
      const view = editorProductViews(product.profile)[key];
      return Boolean(view?.photo && view.fabricMask && view.surfaceMask && view.canvas.width >= 100 && view.canvas.height >= 100);
    });
    if (!configured.length) issues.push("Konfigurálj legalább egy nézetet referenciafotóval, szín- és mintamaszkkal.");
    if (product.materials.some((material) => material.shopifyVariantId) && !product.shopifyProductId) {
      issues.push("A Shopify-variánsazonosítókhoz add meg a Shopify-termékazonosítót is.");
    }
    if (!product.materials.some((material) => material.name.trim() &&
        (Boolean(material.shopifyVariantId) || Number.isSafeInteger(material.priceHuf) && (material.priceHuf ?? 0) > 0) &&
        material.colors.some((color) => color.name.trim() && color.active !== false))) {
      issues.push("Adj meg legalább egy anyagot aktív színnel és valós Shopify-variánsazonosítóval (a régi helyi katalógus a meglévő tesztárat is elfogadja).");
    }
    return issues;
  }

  return <main className="admin">
    <header><div><a href="/">Ro-Lí</a><h1>Termékek kezelése</h1></div><nav aria-label="Adminisztráció"><a href="/termekek/igenyek/">Vásárlói igények</a><a href="/szerkeszto/" target="_blank" rel="noreferrer">Szerkesztő megnyitása ↗</a></nav></header>
    <p className="notice" role="status">{message}</p>
    {import.meta.env.DEV && <p className="notice">Helyi fejlesztői mód: a mentés csak ebben a böngészőben él, nem központi Cloudflare-tárban.</p>}
    {!loaded ? <p>A termékek betöltése szükséges a szerkesztéshez.</p> : <div className="admin-layout">
      <aside><label>Új termék neve<input maxLength={120} value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
        <button disabled={busy} onClick={() => void createProduct()}>+ Új termék létrehozása</button>
        <h2>Adatok átvitele</h2>
        <button disabled={busy} onClick={() => void exportLocalCatalog().then(() => setMessage("A helyi termékek átviteli fájlja elkészült.")).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Az exportálás sikertelen."))}>Helyi termékek exportálása</button>
        <label>Átviteli fájl importálása<input disabled={busy || !loaded} type="file" accept=".json,application/json" onChange={(event) => void importBackup(event)} /></label>
        <h2>Termékek</h2>
        {products.map((item) => <a className={`product-link ${selectedId === item.profile.productId ? "selected" : ""}`} key={item.profile.productId} href={`/termekek/${designerProductSlug(item)}`}>
          {item.profile.name} <small>{item.active ? "Aktív" : "Inaktív"}</small>
        </a>)}
        {detachedFiles.length > 0 && <>
          <h2>Leválasztott fájlok</h2>
          <p className="help">A végleges törlés előtt a mentett katalógus hivatkozásait is ellenőrizzük.</p>
          {detachedFiles.map((file) => <div className="detached-file" key={file.url}>
            <span>{file.label}</span>
            <button type="button" className="danger" disabled={busy || dirty} onClick={() => void permanentlyDeleteDetached(file)}>Végleges törlés</button>
          </div>)}
        </>}
      </aside>
      <section className="editor">
        <div className="admin-toolbar">
          <div><strong>{selected?.profile.name ?? "Termékkatalógus"}</strong><span>{dirty ? "Nem mentett módosítások" : "Minden módosítás mentve"}</span></div>
          <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Mentés…" : "Módosítások mentése"}</button>
        </div>
        {!selected && <div className="empty-editor"><h2>{routeSlug ? "A termék nem található" : "Válassz terméket"}</h2><p>{routeSlug ? "Ellenőrizd a címet, vagy válassz terméket a listából." : "Hozz létre egy termékvázlatot, vagy nyiss meg egy meglévő termékprofilt."}</p></div>}
        {selected && <>
          <div className="title-row"><div><h2>{selected.profile.name || "Új termék"}</h2><p>Csillaggal jelölt mezők szükségesek az aktiváláshoz.</p></div><button type="button" className="danger" disabled={busy} onClick={removeProduct}>Termék törlése</button></div>
          <nav className="steps" aria-label="Termékbeállítás szakaszai">
            {steps.map((label, index) => <button key={label} type="button" className={step === index ? "current" : ""} aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)}>
              <span>{index + 1}</span>{label}
            </button>)}
          </nav>
          <fieldset disabled={busy} className="step-content">
            {step === 0 && <>
              <h3>Alapadatok és képek</h3>
              <div className="number-grid">
                <label>Terméknév *<input required value={selected.profile.name} maxLength={120} onChange={(event) => update((product) => ({ ...product, profile: { ...product.profile, name: event.target.value } }))} /></label>
                <label>Egyedi URL-azonosító *<input required pattern="[a-z0-9][a-z0-9-]{0,99}" value={designerProductSlug(selected)} onChange={(event) => update((product) => ({ ...product, slug: event.target.value }))} /><small>Csak kisbetű, szám és kötőjel; ez nem módosítja a stabil termékazonosítót ({selected.profile.productId}).</small></label>
              </div>
              <label>Rövid leírás<textarea maxLength={500} rows={3} value={selected.description ?? ""} onChange={(event) => update((product) => ({ ...product, description: event.target.value }))} /></label>
              <label>Shopify termékazonosító (opcionális)<input maxLength={200} value={selected.shopifyProductId ?? ""} placeholder="A későbbi Shopify-összekapcsoláshoz" onChange={(event) => update((product) => ({ ...product, shopifyProductId: event.target.value || undefined }))} /><small>Ne adj meg becsült azonosítót; ezt a Shopify-termékből kell majd átmásolni.</small></label>
              <div className="view-tabs" role="group" aria-label="Terméknézet kiválasztása">
                {EDITOR_VIEW_KEYS.map((key) => <button key={key} type="button" aria-pressed={adminView === key}
                  className={adminView === key ? "selected" : ""} onClick={() => { setAdminView(key); setMask("surfaceMask"); }}>
                  {EDITOR_VIEW_LABELS[key]}
                </button>)}
              </div>
              <h4>{EDITOR_VIEW_LABELS[adminView]} képei</h4>
              <label>{EDITOR_VIEW_LABELS[adminView]} képeinek feltöltése<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => void uploadPhotos(event)} /><small>JPG, PNG vagy WebP. Több kép feltölthető, a sorrendjük külön állítható.</small></label>
              {viewData?.photos.length ? <div className="photo-grid">
                {viewData.photos.map((photo, index) => {
                  const isReference = viewData.referencePhotoId === photo.id;
                  const resolved = previewView?.photos.find((item) => item.id === photo.id)?.url ?? photo.url;
                  return <div key={photo.id} className={`photo-card ${isReference ? "selected" : ""}`}>
                    <img src={resolved} alt={`${EDITOR_VIEW_LABELS[adminView]}: ${photo.name}`} onLoad={(event) => recordImageSize(event.currentTarget.currentSrc, event.currentTarget)} onError={() => setMessage(`A termékkép nem tölthető be: ${photo.name}.`)} />
                    <span>{photo.name}</span><strong>{isReference ? "Referenciafotó" : "Referencia kiválasztása"}</strong>
                    <button type="button" disabled={isReference} onClick={() => void setReferencePhoto(photo.id)}>Használat referenciaként</button>
                    <label className="button">Kép lecserélése<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void replacePhoto(event, photo.id)} /></label>
                    <div className="photo-actions">
                      <button type="button" aria-label="Kép mozgatása előre" disabled={index === 0} onClick={() => movePhoto(photo.id, -1)}>↑</button>
                      <button type="button" aria-label="Kép mozgatása hátra" disabled={index === viewData.photos.length - 1} onClick={() => movePhoto(photo.id, 1)}>↓</button>
                      <button type="button" className="danger" onClick={() => removePhoto(photo.id)}>Eltávolítás</button>
                    </div>
                  </div>;
                })}
              </div> : <p className="help">Ehhez a nézethez még nincs kép feltöltve.</p>}
              <p className="help">A nézet vászna a kiválasztott referenciafotó természetes képméretét veszi át; koordinátát nem kell megadni.</p>
            </>}
            {step === 1 && <>
              <h3>{EDITOR_VIEW_LABELS[adminView]} maszkjai</h3>
              <div className="view-tabs" role="group" aria-label="Maszkhoz tartozó nézet">
                {EDITOR_VIEW_KEYS.map((key) => <button key={key} type="button" aria-pressed={adminView === key}
                  className={adminView === key ? "selected" : ""} onClick={() => { setAdminView(key); setMask("surfaceMask"); }}>
                  {EDITOR_VIEW_LABELS[key]}
                </button>)}
              </div>
              <p className="help">A színmaszk és a mintamaszk külön működésű. Mindkettő PNG vagy átlátszó WebP legyen; a maszk látható és átlátszó részt is tartalmazzon.</p>
              <div className="file-grid">
                {([["fabricMask", "Színmaszk *"], ["surfaceMask", "Mintamaszk *"]] as const).map(([field, label]) => <div key={field}>
                  <label>{label}
                    <input type="file" accept="image/png,image/webp" onChange={(event) => uploadViewMask(event, field)} />
                    <small>{viewData?.[field] ? getImageSize(previewView?.[field] ?? viewData[field]) ?? "Méret betöltése…" : "Kötelező a nézet aktiválásához"}</small>
                  </label>
                  {viewData?.[field] && <>
                    <img className="mask-thumb" src={previewView?.[field] ?? viewData[field]} alt={`${label} előnézete`} onLoad={(event) => recordImageSize(event.currentTarget.currentSrc, event.currentTarget)} />
                    <button type="button" className="danger" onClick={() => removeViewMask(field)}>Maszk eltávolítása</button>
                  </>}
                </div>)}
              </div>
              <h4>Opcionális védőmaszkok</h4>
              <p className="help">Külön jelöld a változatlan részeket, például cipzárt, fémhúzót vagy címkét. Ezek nem helyettesítik a szín- vagy mintamaszkot.</p>
              {(viewData?.protectMasks ?? []).map((protectMask) => <div className="protect-row" key={protectMask.id}>
                <img src={previewView?.protectMasks.find((item) => item.id === protectMask.id)?.url ?? protectMask.url} alt={`${protectMask.label} védőmaszk`} onLoad={(event) => recordImageSize(event.currentTarget.currentSrc, event.currentTarget)} />
                <label>Maszk neve<input maxLength={120} value={protectMask.label} onChange={(event) => updateView((view) => ({ ...view, protectMasks: view.protectMasks.map((item) => item.id === protectMask.id ? { ...item, label: event.target.value } : item) }))} /></label>
                <button type="button" onClick={() => {
                  if (window.confirm(`Eltávolítod a(z) „${protectMask.label}” védőmaszkot a(z) ${EDITOR_VIEW_LABELS[adminView]} nézetből? A fájl a tárban marad.`)) {
                    rememberDetached(protectMask.url, `${EDITOR_VIEW_LABELS[adminView]} ${protectMask.label}`);
                    updateView((view) => ({ ...view, protectMasks: view.protectMasks.filter((item) => item.id !== protectMask.id) }));
                  }
                }}>Eltávolítás</button>
              </div>)}
              <div className="protect-add">
                <label>Védőmaszk neve<input id="protect-mask-name" maxLength={120} placeholder="Például: Cipzár" /></label>
                <label>Védőmaszk feltöltése<input type="file" accept="image/png,image/webp" onChange={(event) => {
                  const nameField = document.getElementById("protect-mask-name");
                  const name = nameField instanceof HTMLInputElement && nameField.value.trim() ? nameField.value.trim() : event.currentTarget.files?.[0]?.name.replace(/\.[^.]+$/, "") ?? "Védőmaszk";
                  void upload(event, (url) => addProtectMask(url, name), true);
                }} /></label>
              </div>
              <label>Illeszkedés előnézete<select value={mask} onChange={(event) => setMask(event.target.value)}><option value="surfaceMask">Mintamaszk</option><option value="fabricMask">Színmaszk</option>{(viewData?.protectMasks ?? []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              {previewView?.photo && <div className="preview" style={{ aspectRatio: `${previewView.canvas.width} / ${previewView.canvas.height}` }}>
                <img src={previewView.photo} alt={`${EDITOR_VIEW_LABELS[adminView]} referenciafotó`} onLoad={(event) => recordImageSize(event.currentTarget.currentSrc, event.currentTarget)} />
                {selectedMaskUrl && <img className="overlay" src={selectedMaskUrl} alt="Kiválasztott maszk fedése" />}
              </div>}
              <p className="help">Referenciafotó: {getImageSize(previewView?.photo ?? viewData?.photo ?? "") ?? "méret betöltése…"} · Maszkok: csak a(z) {EDITOR_VIEW_LABELS[adminView]} nézethez tartoznak.</p>
              {selectedMaskUrl && <p className="help">Kiválasztott maszk: {getImageSize(selectedMaskUrl) ?? "méret betöltése…"}.
                {getImageSize(selectedMaskUrl) && getImageSize(previewView?.photo ?? "") &&
                (getImageSize(selectedMaskUrl) === getImageSize(previewView?.photo ?? "")
                  ? " A képméretek egyeznek." : " Hiba: a képméretek eltérnek; ez a nézet nem aktiválható.")}</p>}
              <div className="number-grid">
                <label>Színezhető terület – belső jegyzet<input value={selected.profile.areas?.color ?? ""} maxLength={300} onChange={(event) => update((product) => ({ ...product, profile: { ...product.profile, areas: { ...product.profile.areas, color: event.target.value } } }))} /></label>
                <label>Mintázható terület – belső jegyzet<input value={selected.profile.areas?.pattern ?? ""} maxLength={300} onChange={(event) => update((product) => ({ ...product, profile: { ...product.profile, areas: { ...product.profile.areas, pattern: event.target.value } } }))} /></label>
                <label>Változatlan területek – belső jegyzet<input value={selected.profile.areas?.protect ?? ""} maxLength={300} onChange={(event) => update((product) => ({ ...product, profile: { ...product.profile, areas: { ...product.profile.areas, protect: event.target.value } } }))} /></label>
              </div>
            </>}
            {step === 2 && <>
              <h3>Anyagok, színek és Shopify-variánsok</h3>
              <p className="help">A Shopify lesz a vásárlási ár forrása. Itt csak a valódi Shopify-termék- és variánsazonosítók kapcsolhatók az anyagokhoz; az ár lekérése és kosárba helyezése későbbi integrációs feladat. A korábbi helyi tesztárak adatkompatibilitás miatt megmaradnak, de itt nem módosíthatók.</p>
              {selected.materials.map((material, index) => <section className="material" key={material.id}>
                <div className="title-row"><h4>{material.name || `Anyag ${index + 1}`}</h4><button type="button" className="danger" onClick={() => update((product) => ({ ...product, materials: product.materials.filter((item) => item.id !== material.id) }))}>Anyag eltávolítása</button></div>
                <div className="number-grid">
                  <label>Anyag neve *<input value={material.name} maxLength={120} onChange={(event) => updateMaterial(index, (item) => ({ ...item, name: event.target.value }))} /></label>
                  <label>Shopify-variánsazonosító (opcionális)<input maxLength={200} value={material.shopifyVariantId ?? ""} placeholder="A Shopify valódi variánsazonosítója" onChange={(event) => updateMaterial(index, (item) => ({ ...item, shopifyVariantId: event.target.value || undefined }))} /><small>Ne adj meg kitalált azonosítót vagy kézi árat.</small></label>
                  <label>Anyagtextúra / minta<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void upload(event, (url) => updateMaterial(index, (item) => ({ ...item, textureUrl: url, previewUrl: url })))} /><small>{material.textureUrl ? "Feltöltve" : "Opcionális"}</small></label>
                  <label>Textúra megjelenítése<select value={material.preview.applyTexture ? material.preview.textureMapping : "none"} onChange={(event) => {
                    const value = event.target.value;
                    updateMaterial(index, (item) => ({ ...item, preview: { ...item.preview, applyTexture: value !== "none", textureMapping: value === "tile" || value === "satin-soft" ? value : "cover-luminance" } }));
                  }}><option value="none">Csak eredeti fotó</option><option value="cover-luminance">Finom textúra</option><option value="tile">Ismétlődő textúra</option><option value="satin-soft">Lágy szaténhatás</option></select></label>
                  <label>Fotó alapszíne<input type="color" value={material.preview.baseColor} onChange={(event) => updateMaterial(index, (item) => ({ ...item, preview: { ...item.preview, baseColor: event.target.value } }))} /></label>
                </div>
                <h4>Színek</h4>
                {material.colors.map((color, colorIndex) => <div className="inline color-row" key={`${material.id}-${colorIndex}`}>
                  <input aria-label="Szín neve" value={color.name} maxLength={120} onChange={(event) => updateMaterial(index, (item) => ({ ...item, colors: item.colors.map((entry, i) => i === colorIndex ? { ...entry, name: event.target.value } : entry) }))} />
                  <input aria-label="Színkód és előnézet" type="color" value={color.color} onChange={(event) => updateMaterial(index, (item) => ({ ...item, colors: item.colors.map((entry, i) => i === colorIndex ? { ...entry, color: event.target.value } : entry) }))} />
                  <label className="check"><input type="checkbox" checked={color.active !== false} onChange={(event) => updateMaterial(index, (item) => ({ ...item, colors: item.colors.map((entry, i) => i === colorIndex ? { ...entry, active: event.target.checked } : entry) }))} /> Aktív</label>
                  <button type="button" onClick={() => updateMaterial(index, (item) => ({ ...item, colors: item.colors.filter((_, i) => i !== colorIndex) }))}>Törlés</button>
                </div>)}
                <button type="button" onClick={() => updateMaterial(index, (item) => ({ ...item, colors: [...item.colors, { name: "Új szín", color: "#bca99a", active: true }] }))}>+ Szín hozzáadása</button>
                <h4>Minták</h4>
                {material.patterns.map((pattern) => <div className="inline" key={pattern.id}><span>{pattern.name}</span><button type="button" onClick={() => updateMaterial(index, (item) => ({ ...item, patterns: item.patterns.filter((entry) => entry.id !== pattern.id) }))}>Eltávolítás</button></div>)}
                <label>Új mintakép feltöltése<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void upload(event, (url, name) => {
                  const id = `pattern-${makeId()}`;
                  updateMaterial(index, (item) => ({ ...item, patterns: [...item.patterns, {
                    id, name: name.slice(0, 120), active: true, previewUrl: url,
                    variants: [{ id: "original", name: "Eredeti", color: "#ffffff", previewUrl: url, imageUrl: url }],
                  }] }));
                })} /></label>
              </section>)}
              <button type="button" onClick={() => update((product) => ({ ...product, materials: [...product.materials, blankMaterial(product)] }))}>+ Anyag hozzáadása</button>
            </>}
            {step === 3 && <>
              <h3>Szerkesztőbeállítások</h3>
              {(() => {
                const settings = selected.editorSettings ?? defaultSettings;
                return <>
                  <label className="check"><input type="checkbox" checked={settings.customText} onChange={(event) => update((product) => ({ ...product, editorSettings: { ...(product.editorSettings ?? defaultSettings), customText: event.target.checked } }))} /> Egyedi szöveg engedélyezése</label>
                  <label>Maximális karakterszám<input type="number" min="1" max="200" value={settings.maxTextLength} disabled={!settings.customText} onChange={(event) => update((product) => ({ ...product, editorSettings: { ...(product.editorSettings ?? defaultSettings), maxTextLength: Number(event.target.value) } }))} /></label>
                  <label className="check"><input type="checkbox" checked={settings.imageUpload} onChange={(event) => update((product) => ({ ...product, editorSettings: { ...(product.editorSettings ?? defaultSettings), imageUpload: event.target.checked } }))} /> Saját grafika feltöltésének engedélyezése</label>
                  <label>Maximális képfájlméret (MB)<input type="number" min="0.1" max="5" step="0.1" value={settings.maxUploadBytes / (1024 * 1024)} disabled={!settings.imageUpload} onChange={(event) => update((product) => ({ ...product, editorSettings: { ...(product.editorSettings ?? defaultSettings), maxUploadBytes: Math.round(Number(event.target.value) * 1024 * 1024) } }))} /></label>
                  <label className="check"><input type="checkbox" checked={settings.enabled2d} onChange={(event) => update((product) => ({ ...product, editorSettings: { ...(product.editorSettings ?? defaultSettings), enabled2d: event.target.checked }, active: event.target.checked ? product.active : false }))} /> 2D szerkesztés engedélyezése</label>
                  <p className="help">A beállítások kizárólag a 2D szerkesztő vezérlőit szabályozzák; a termékprofilban tárolódnak.</p>
                </>;
              })()}
            </>}
            {step === 4 && <>
              <h3>Ellenőrzés és mentés</h3>
              <ul className="checklist">
                {[
                  ["Terméknév", Boolean(selected.profile.name.trim())],
                  ["Egyedi URL-azonosító", /^[a-z0-9][a-z0-9-]{0,99}$/.test(designerProductSlug(selected))],
                  ["Legalább egy teljesen konfigurált nézet", EDITOR_VIEW_KEYS.some((key) => {
                    const view = editorProductViews(selected.profile)[key];
                    return Boolean(view?.photo && view.fabricMask && view.surfaceMask && view.canvas.width >= 100 && view.canvas.height >= 100);
                  })],
                  ["Anyag, Shopify-variáns vagy helyi tesztár, aktív szín", selected.materials.some((material) => material.name.trim() &&
                    (Boolean(material.shopifyVariantId) || Number.isSafeInteger(material.priceHuf) && (material.priceHuf ?? 0) > 0) &&
                    material.colors.some((color) => color.name.trim() && color.active !== false))],
                ].map(([label, valid]) => <li key={String(label)} className={valid ? "valid" : "invalid"}>{valid ? "✓" : "•"} {label}</li>)}
              </ul>
              {productIssues(selected).length > 0 && <div className="validation-errors" role="alert"><strong>Aktiválás előtt szükséges:</strong><ul>{productIssues(selected).map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
              <label className="check"><input type="checkbox" checked={selected.active} disabled={!selected.active && productIssues(selected).length > 0} onChange={(event) => void setProductActive(event.target.checked)} /> Termék aktiválása a szerkesztőben</label>
              <p className="help">Termékazonosító: {selected.profile.productId} (stabil, nem változik a slug módosításakor).</p>
              <p className="help">A képek és maszkok eltávolítása csak a termékből szünteti meg a hozzárendelést. Végleges törlés nincs engedélyezve, amíg a fájl összes katalóguson kívüli hivatkozása nem ellenőrizhető.</p>
              {selected.active && <p>Termékszerkesztő útvonala: <a href={`/szerkeszto/${designerProductSlug(selected)}`}>/szerkeszto/{designerProductSlug(selected)}</a></p>}
            </>}
          </fieldset>
          <div className="step-actions">
            <button type="button" disabled={step === 0 || busy} onClick={() => setStep((current) => current - 1)}>← Előző</button>
            <span>{step + 1} / {steps.length}</span>
            {step < steps.length - 1 && <button type="button" className="primary" onClick={() => setStep((current) => current + 1)}>Következő →</button>}
          </div>
        </>}
      </section>
    </div>}
  </main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Az admin gyökéreleme nem található.");
const reactRoot = createRoot(root);
const page = window.location.pathname.replace(/\/+$/, "");
reactRoot.render(<StrictMode>{page === "/termekek/igenyek" ? <RequestsPage /> : <App />}</StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => reactRoot.unmount());

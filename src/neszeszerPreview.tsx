import { useEffect, useRef } from "react";
import { satinShade } from "./designer-prototype/satin";
export { BUILTIN_DESIGN_PATTERNS } from "./data/builtinPatterns";

const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string) {
  let cached = imageCache.get(src);
  if (!cached) {
    cached = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`A kép nem tölthető be: ${src}`));
      image.src = src;
    }).catch((error: unknown) => {
      imageCache.delete(src);
      throw error;
    });
    imageCache.set(src, cached);
  }
  return cached;
}

function pixelsOf(image: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("A vászon nem érhető el.");
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

function softenedPixelsOf(image: CanvasImageSource, width: number, height: number) {
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(width / 6));
  small.height = Math.max(1, Math.round(height / 6));
  const context = small.getContext("2d");
  if (!context) throw new Error("A simított előnézeti vászon nem érhető el.");
  context.drawImage(image, 0, 0, small.width, small.height);
  return pixelsOf(small, width, height).data;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

const MAX_PREVIEW_EDGE = 1600;
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Textúrahű átszínezés: a fotó fényessége (szövés, varrás, árnyék) megmarad, az alapszínt a kiválasztott szín adja.
 * A színmaszk a teljes textilt fedi (cipzár nélkül), a minta csak az első panelen jelenik meg.
 */
export function TextilePreviewCanvas({
  photoUrl,
  colorMaskUrl,
  patternMaskUrl,
  color,
  patternUrl,
  textureUrl,
  textureMapping = "tile",
  onError,
  onRendered,
}: {
  photoUrl: string;
  colorMaskUrl: string;
  patternMaskUrl?: string;
  color: string;
  patternUrl?: string;
  textureUrl?: string;
  textureMapping?: "tile" | "cover-luminance" | "satin-soft";
  onError?: (message: string) => void;
  onRendered?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.dataset.exportReady = "false";
      const [photo, colorMask, patternMask, pattern, texture] = await Promise.all([
        loadImage(photoUrl),
        loadImage(colorMaskUrl),
        patternMaskUrl ? loadImage(patternMaskUrl) : Promise.resolve(undefined),
        patternUrl ? loadImage(patternUrl) : Promise.resolve(undefined),
        textureUrl && textureMapping !== "satin-soft" ? loadImage(textureUrl) : Promise.resolve(undefined),
      ]);
      if (cancelled) return;
      const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(photo.naturalWidth, photo.naturalHeight));
      const width = Math.max(1, Math.round(photo.naturalWidth * scale));
      const height = Math.max(1, Math.round(photo.naturalHeight * scale));
      const base = pixelsOf(photo, width, height);
      const softened = textureMapping === "satin-soft" ? softenedPixelsOf(photo, width, height) : undefined;
      const fabric = pixelsOf(colorMask, width, height).data;
      const panel = patternMask ? pixelsOf(patternMask, width, height).data : undefined;
      let patternData: Uint8ClampedArray | undefined;
      let textureData: Uint8ClampedArray | undefined;
      function tiledImageData(image: HTMLImageElement) {
        const tiled = document.createElement("canvas");
        tiled.width = width;
        tiled.height = height;
        const tileContext = tiled.getContext("2d", { willReadFrequently: true });
        if (!tileContext) return undefined;
        const fill = tileContext.createPattern(image, "repeat");
        if (!fill) return undefined;
        tileContext.fillStyle = fill;
        tileContext.fillRect(0, 0, width, height);
        return tileContext.getImageData(0, 0, width, height).data;
      }
      if (pattern) patternData = tiledImageData(pattern);
      if (texture && textureMapping === "cover-luminance") {
        const textureCanvas = document.createElement("canvas");
        textureCanvas.width = width;
        textureCanvas.height = height;
        const textureContext = textureCanvas.getContext("2d", { willReadFrequently: true });
        if (!textureContext) throw new Error("A textúra előnézete nem érhető el.");
        const textureScale = Math.max(width / texture.naturalWidth, height / texture.naturalHeight);
        const textureWidth = texture.naturalWidth * textureScale;
        const textureHeight = texture.naturalHeight * textureScale;
        textureContext.drawImage(texture, (width - textureWidth) / 2, (height - textureHeight) / 2, textureWidth, textureHeight);
        textureData = textureContext.getImageData(0, 0, width, height).data;
      } else if (texture) {
        textureData = tiledImageData(texture);
      }

      const out = base.data;
      // Átlagos textilfényesség a színmaszkon belül.
      let sum = 0;
      let count = 0;
      for (let i = 0; i < out.length; i += 4) {
        if (fabric[i + 3] > 200) {
          sum += luma(out[i], out[i + 1], out[i + 2]);
          count += 1;
        }
      }
      const reference = count ? sum / count : 128;
      const [tr, tg, tb] = hexToRgb(color);
      for (let i = 0; i < out.length; i += 4) {
        const fabricAlpha = fabric[i + 3] / 255;
        if (fabricAlpha === 0) continue;
        const originalShade = luma(out[i], out[i + 1], out[i + 2]);
        const shade = softened
          ? satinShade(originalShade, luma(softened[i], softened[i + 1], softened[i + 2]), reference)
          : originalShade;
        const factor = shade / reference;
        const lift = (shade - reference) * 0.3;
        const textureLight = textureData && textureMapping === "cover-luminance"
          ? luma(textureData[i], textureData[i + 1], textureData[i + 2]) / 200 : undefined;
        let r = (textureLight !== undefined ? tr * textureLight : textureData ? textureData[i] * tr / 255 : tr) * factor + lift;
        let g = (textureLight !== undefined ? tg * textureLight : textureData ? textureData[i + 1] * tg / 255 : tg) * factor + lift;
        let b = (textureLight !== undefined ? tb * textureLight : textureData ? textureData[i + 2] * tb / 255 : tb) * factor + lift;
        const panelAlpha = patternData && panel ? (panel[i + 3] / 255) * (patternData[i + 3] / 255) : 0;
        if (panelAlpha > 0 && patternData) {
          r = r * (1 - panelAlpha) + (patternData[i] * factor + lift) * panelAlpha;
          g = g * (1 - panelAlpha) + (patternData[i + 1] * factor + lift) * panelAlpha;
          b = b * (1 - panelAlpha) + (patternData[i + 2] * factor + lift) * panelAlpha;
        }
        out[i] = Math.max(0, Math.min(255, out[i] * (1 - fabricAlpha) + r * fabricAlpha));
        out[i + 1] = Math.max(0, Math.min(255, out[i + 1] * (1 - fabricAlpha) + g * fabricAlpha));
        out[i + 2] = Math.max(0, Math.min(255, out[i + 2] * (1 - fabricAlpha) + b * fabricAlpha));
      }
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Az előnézeti vászon nem érhető el.");
      context.putImageData(base, 0, 0);
      canvas.dataset.exportReady = "true";
      onRendered?.();
    }
    render().catch((error: unknown) => {
      if (cancelled) return;
      console.error("A neszeszer előnézete nem készíthető el.", error);
      onError?.("Az anyagszín előnézete nem készíthető el; az eredeti fotó látható.");
    });
    return () => {
      cancelled = true;
    };
  }, [photoUrl, colorMaskUrl, patternMaskUrl, color, patternUrl, textureUrl, textureMapping, onError, onRendered]);

  return <canvas ref={canvasRef} className="visual-recolor" aria-hidden="true" />;
}

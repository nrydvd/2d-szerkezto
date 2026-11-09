import { pouchProfile } from "./profile.ts";
import { BUILTIN_DESIGN_PATTERNS, type EditorPattern } from "../data/builtinPatterns.ts";

export interface EditorMaterial {
  id: string;
  name: string;
  previewUrl: string;
  textureUrl: string;
  layoutId: string;
  preview: {
    photoUrl: string;
    colorMaskUrl: string;
    surfaceMaskUrl: string;
    applyTexture: boolean;
    textureMapping: "tile" | "cover-luminance" | "satin-soft";
    baseColor: string;
  };
  colors: readonly { name: string; color: string; active?: boolean }[];
  patterns: readonly EditorPattern[];
}

const exampleColors = [
  { name: "Zsálya", color: "#8c9c84" },
  { name: "Homok", color: "#d3bc98" },
  { name: "Púderrózsaszín", color: "#cf9c9b" },
  { name: "Kék", color: "#8299ad" },
  { name: "Sötétszürke", color: "#625d5b" },
] as const;

const commonPreview = {
  photoUrl: pouchProfile.photo,
  colorMaskUrl: pouchProfile.fabricMask,
  surfaceMaskUrl: pouchProfile.surfaceMask,
  baseColor: "#e1b5b3",
  textureMapping: "cover-luminance" as const,
};

export const MATERIALS: readonly EditorMaterial[] = [
  {
    id: "gyongyvaszon", name: "Gyöngyvászon",
    previewUrl: "/images/materials/gyongyvaszon.png",
    textureUrl: "/images/materials/gyongyvaszon.png",
    layoutId: pouchProfile.id,
    preview: { ...commonPreview, applyTexture: false },
    colors: exampleColors,
    patterns: [...BUILTIN_DESIGN_PATTERNS],
  },
  {
    id: "szaten", name: "Szatén",
    previewUrl: "/images/materials/szaten.png",
    textureUrl: "/images/materials/szaten.png",
    layoutId: pouchProfile.id,
    preview: { ...commonPreview, applyTexture: true, textureMapping: "satin-soft" },
    colors: exampleColors,
    patterns: [...BUILTIN_DESIGN_PATTERNS],
  },
];

export const DEFAULT_MATERIAL_ID = "gyongyvaszon";

export function findMaterial(id: string): EditorMaterial | undefined {
  return MATERIALS.find((material) => material.id === id);
}

export function unavailablePatternIds(
  layers: readonly { type: string; pattern?: { id: string } }[],
  material: EditorMaterial,
): string[] {
  return [...new Set(layers.flatMap((layer) =>
    layer.type === "image" && layer.pattern && !material.patterns.some((pattern) => pattern.active && pattern.id === layer.pattern?.id)
      ? [layer.pattern.id] : []))];
}

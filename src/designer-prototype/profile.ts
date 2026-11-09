export interface EditorProfile {
  id: string;
  productId: string;
  name: string;
  canvas: { width: number; height: number };
  photo: string;
  fabricMask: string;
  surfaceMask: string;
  photos?: { id: string; url: string; name: string }[];
  protectMasks?: { id: string; label: string; url: string }[];
  views?: Partial<Record<EditorViewKey, EditorView>>;
  areas?: { color?: string; pattern?: string; protect?: string };
  area: { x: number; y: number; width: number; height: number };
}

export const EDITOR_VIEW_KEYS = ["front", "back", "right", "left"] as const;
export type EditorViewKey = typeof EDITOR_VIEW_KEYS[number];
export const EDITOR_VIEW_LABELS: Record<EditorViewKey, string> = {
  front: "Elölnézet",
  back: "Hátulnézet",
  right: "Jobb oldal",
  left: "Bal oldal",
};

export interface EditorPhoto {
  id: string;
  url: string;
  name: string;
  width?: number;
  height?: number;
}

export interface EditorView {
  photos: EditorPhoto[];
  referencePhotoId?: string;
  photo: string;
  canvas: { width: number; height: number };
  fabricMask: string;
  surfaceMask: string;
  protectMasks: { id: string; label: string; url: string }[];
}

export function legacyFrontView(profile: EditorProfile): EditorView {
  const photos = profile.photos?.length
    ? profile.photos
    : profile.photo ? [{ id: "legacy-reference", url: profile.photo, name: "Referenciafotó" }] : [];
  const reference = photos.find((photo) => photo.url === profile.photo) ?? photos[0];
  return {
    photos: photos.map((photo) => ({ ...photo })),
    ...(reference ? { referencePhotoId: reference.id } : {}),
    photo: reference?.url ?? profile.photo,
    canvas: { ...profile.canvas },
    fabricMask: profile.fabricMask,
    surfaceMask: profile.surfaceMask,
    protectMasks: (profile.protectMasks ?? []).map((mask) => ({ ...mask })),
  };
}

export function editorViewProfile(profile: EditorProfile, view: EditorView): EditorProfile {
  return {
    ...profile,
    id: profile.id,
    photo: view.photo,
    canvas: { ...view.canvas },
    area: { x: 0, y: 0, width: view.canvas.width, height: view.canvas.height },
    fabricMask: view.fabricMask,
    surfaceMask: view.surfaceMask,
    photos: view.photos.map((photo) => ({ ...photo })),
    protectMasks: view.protectMasks.map((mask) => ({ ...mask })),
  };
}

export const pouchProfile: EditorProfile = {
  id: "noi-neszeszer-prototype",
  productId: "womens-pouch",
  name: "Női neszeszer",
  canvas: { width: 1254, height: 1254 },
  photo: "/images/products/noi-neszeszer-00.png",
  fabricMask: "/images/masks/noi-neszeszer/fabric-color-mask.png",
  surfaceMask: "/images/masks/noi-neszeszer/front-panel-pattern-mask.png",
  area: { x: 0, y: 0, width: 1254, height: 1254 },
};

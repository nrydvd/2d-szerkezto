export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ImageEdit {
  crop: Crop;
  opacity: number;
  flipX: boolean;
  flipY: boolean;
}

export const DEFAULT_IMAGE_EDIT: ImageEdit = {
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
  opacity: 1,
  flipX: false,
  flipY: false,
};

export function cropAspect(crop: Crop, width: number, height: number) {
  return width * (1 - crop.left - crop.right) / (height * (1 - crop.top - crop.bottom));
}

export function cropToAspect(width: number, height: number, ratio: number): Crop {
  const imageRatio = width / height;
  if (imageRatio > ratio) {
    const side = (1 - ratio / imageRatio) / 2;
    return { left: side, right: side, top: 0, bottom: 0 };
  }
  const side = (1 - imageRatio / ratio) / 2;
  return { left: 0, right: 0, top: side, bottom: side };
}

export function sizeWithin(width: number, height: number, ratio: number) {
  if (width / height > ratio) return { width: height * ratio, height };
  return { width, height: width / ratio };
}

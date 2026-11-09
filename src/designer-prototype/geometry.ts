export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedLayer {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export function rotatedHalfExtents(layer: PositionedLayer) {
  const radians = layer.rotation * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  return {
    x: (layer.width * cosine + layer.height * sine) / 2,
    y: (layer.width * sine + layer.height * cosine) / 2,
  };
}

export function fitLayer<T extends PositionedLayer>(layer: T, area: Rectangle): T {
  const initial = rotatedHalfExtents(layer);
  const scale = Math.min(1, area.width / (2 * initial.x), area.height / (2 * initial.y));
  const fitted = { ...layer, width: layer.width * scale, height: layer.height * scale };
  const half = rotatedHalfExtents(fitted);
  return {
    ...fitted,
    x: Math.max(area.x + half.x, Math.min(area.x + area.width - half.x, layer.x)),
    y: Math.max(area.y + half.y, Math.min(area.y + area.height - half.y, layer.y)),
  };
}

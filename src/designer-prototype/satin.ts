export function satinShade(shade: number, softenedShade: number, reference: number): number {
  const detail = shade - softenedShade;
  const detailWeight = detail < -30 ? 1 : 0.12;
  const sheen = Math.max(0, Math.min(7, (softenedShade - reference) * 0.12));
  return Math.max(0, Math.min(255, softenedShade + detail * detailWeight + sheen));
}

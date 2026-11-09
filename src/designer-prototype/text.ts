export const TEXT_FONTS = {
  sans: { label: "Letisztult", family: "system-ui, sans-serif" },
  serif: { label: "Klasszikus", family: "Georgia, serif" },
  mono: { label: "Írógépes", family: "'Courier New', monospace" },
} as const;

export type TextFont = keyof typeof TEXT_FONTS;
export const isTextFont = (value: string): value is TextFont =>
  Object.prototype.hasOwnProperty.call(TEXT_FONTS, value);
export type TextAlignment = "left" | "center" | "right";
export interface TextStyle {
  font: TextFont;
  size: number;
  bold: boolean;
  italic: boolean;
  align: TextAlignment;
  letterSpacing: number;
  lineHeight: number;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: "sans", size: 50, bold: false, italic: false,
  align: "center", letterSpacing: 0, lineHeight: 1.2,
};
export const LEGACY_TEXT_STYLE: TextStyle = { ...DEFAULT_TEXT_STYLE, size: 75 };

export function textLayout(
  text: string, width: number, height: number, style: TextStyle,
  measure: (line: string) => number,
) {
  const lines = text.split(/\r\n|\r|\n/);
  const longest = Math.max(0, ...lines.map((line) => {
    const characters = Array.from(line).length;
    return Math.max(0, measure(line) / 100 + Math.max(0, characters - 1) * style.letterSpacing);
  }));
  const requestedSize = height * style.size / 100;
  const widthLimit = longest > 0 ? width * 0.88 / (longest + 0.2) : requestedSize;
  const heightLimit = height * 0.88 / (1.4 + (lines.length - 1) * style.lineHeight);
  const size = Math.min(requestedSize, widthLimit, heightLimit);
  return {
    lines, size, fitted: size < requestedSize - 0.01,
    x: style.align === "left" ? width * 0.06 : style.align === "right" ? width * 0.94 : width / 2,
    anchor: style.align === "left" ? "start" as const : style.align === "right" ? "end" as const : "middle" as const,
  };
}

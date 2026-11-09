export interface PatternVariant {
  id: string;
  name: string;
  color: string;
  previewUrl: string;
  imageUrl: string;
}

export interface EditorPattern {
  id: string;
  name: string;
  active: boolean;
  previewUrl: string;
  variants: PatternVariant[];
}

const tile = (body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">${body}</svg>`,
  )}`;

const variants = (original: string, draw: (color: string) => string): PatternVariant[] =>
  [
    { id: "original", name: "Eredeti", color: original },
    { id: "sage", name: "Zsálya", color: "#7c8f72" },
    { id: "rose", name: "Rózsa", color: "#c27d85" },
    { id: "ochre", name: "Okkersárga", color: "#b8975a" },
  ].filter((variant, index, options) => options.findIndex((other) => other.color === variant.color) === index)
    .map(({ id, name, color }) => {
    const url = tile(draw(color));
    return { id, name, color, previewUrl: url, imageUrl: url };
  });

const dots = variants("#7c8f72", (color) => `<rect width="96" height="96" fill="#f6efe4"/><circle cx="24" cy="24" r="8" fill="${color}"/><circle cx="72" cy="72" r="8" fill="${color}"/>`);
const stripes = variants("#b8975a", (color) => `<rect width="96" height="96" fill="#f6efe4"/><rect x="0" y="0" width="96" height="16" fill="${color}"/><rect x="0" y="48" width="96" height="16" fill="${color}"/>`);
const checks = variants("#d9aaa4", (color) => `<rect width="96" height="96" fill="#f6efe4"/><rect width="48" height="48" fill="${color}"/><rect x="48" y="48" width="48" height="48" fill="${color}"/>`);

export const BUILTIN_DESIGN_PATTERNS: EditorPattern[] = [
  {
    id: "builtin-dots",
    name: "Pöttyök (ideiglenes példa)",
    active: true,
    previewUrl: dots[0].previewUrl,
    variants: dots,
  },
  {
    id: "builtin-stripes",
    name: "Csíkok (ideiglenes példa)",
    active: true,
    previewUrl: stripes[0].previewUrl,
    variants: stripes,
  },
  {
    id: "builtin-checks",
    name: "Kockák (ideiglenes példa)",
    active: true,
    previewUrl: checks[0].previewUrl,
    variants: checks,
  },
];

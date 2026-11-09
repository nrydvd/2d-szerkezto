import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MAX_IMAGE_BYTES, MAX_LAYERS, newDesign, parseDesign, parseDesignCollection, validateImage } from "../src/designer-prototype/model.ts";
import { fitLayer, rotatedHalfExtents } from "../src/designer-prototype/geometry.ts";
import { editorViewProfile, pouchProfile } from "../src/designer-prototype/profile.ts";
import { BUILTIN_DESIGN_PATTERNS } from "../src/data/builtinPatterns.ts";
import { DEFAULT_TEXT_STYLE, textLayout } from "../src/designer-prototype/text.ts";
import { DEFAULT_IMAGE_EDIT, cropAspect, cropToAspect, sizeWithin } from "../src/designer-prototype/image.ts";
import { DEFAULT_MATERIAL_ID, MATERIALS, unavailablePatternIds } from "../src/designer-prototype/materials.ts";
import { satinShade } from "../src/designer-prototype/satin.ts";
import { formatPrice, getPouchPrice } from "../src/data/pouchPricing.ts";

test("the product and material price list returns all four prices and rejects unknown combinations", () => {
  for (const [productId, materialId, price] of [
    ["womens-pouch", "gyongyvaszon", 5490],
    ["womens-pouch", "szaten", 5990],
    ["mens-pouch", "gyongyvaszon", 6490],
    ["mens-pouch", "szaten", 6990],
  ]) {
    assert.deepEqual(getPouchPrice(productId, materialId), { productId, materialId, currency: "HUF", finalPriceHuf: price });
  }
  assert.equal(formatPrice(5490), "5\u00a0490 Ft");
  assert.throws(() => getPouchPrice("unknown", "szaten"), /ár/);
  assert.throws(() => getPouchPrice("womens-pouch", "toString"), /ár/);
});

test("product and optional size survive designs while legacy and incompatible products are handled explicitly", () => {
  const design = { ...newDesign(), sizeId: "size-example" };
  assert.deepEqual(parseDesign(JSON.stringify(design)), design);
  const { productId, sizeId, ...legacy } = design;
  assert.equal(productId, "womens-pouch");
  assert.equal(sizeId, "size-example");
  assert.equal(parseDesign(JSON.stringify(legacy)).productId, productId);
  for (const invalid of ["mens-pouch", "unknown", null, ""]) {
    assert.throws(() => parseDesign(JSON.stringify({ ...design, productId: invalid })), /terméke/);
  }
  for (const invalid of [null, "", " ", 10, "x".repeat(101)]) {
    assert.throws(() => parseDesign(JSON.stringify({ ...design, sizeId: invalid })), /méretazonosítója/);
  }
});

test("explicit product profiles isolate materials and restore layers against their own geometry", () => {
  const profile = {
    id: "another-profile", productId: "another-product", name: "Másik termék",
    canvas: { width: 800, height: 600 },
    area: { x: 100, y: 120, width: 600, height: 300 },
    photo: "/photo.png", fabricMask: "/color-mask.png", surfaceMask: "/pattern-mask.png",
  };
  const materials = [{ ...MATERIALS[0], id: "linen", layoutId: profile.id }];
  const design = newDesign(profile, "linen");
  design.layers = [{
    id: "text", type: "text", text: "Terv", color: "#123456",
    x: 400, y: 250, width: 100, height: 50, rotation: 0,
  }];
  assert.deepEqual(parseDesign(JSON.stringify(design), profile, materials), design);
  assert.throws(() => parseDesign(JSON.stringify(design)), /termékprofilja/);
  assert.throws(() => parseDesign(JSON.stringify({ ...design, materialId: "szaten" }), profile, materials), /anyaga/);
  assert.throws(() => parseDesign(JSON.stringify(design), profile, [{ ...materials[0], layoutId: "wrong" }]), /kompatibilis/);
  assert.throws(() => parseDesign(JSON.stringify({ ...design, productId: "womens-pouch" }), profile, materials), /terméke/);
});

test("multi-view design collections preserve independent edit states and load legacy plans", () => {
  const backProfile = editorViewProfile(pouchProfile, {
    photos: [{ id: "back-photo", url: "/images/products/noi-neszeszer-back.png", name: "Hátulnézet", width: 900, height: 1200 }],
    referencePhotoId: "back-photo",
    photo: "/images/products/noi-neszeszer-back.png",
    canvas: { width: 900, height: 1200 },
    fabricMask: "/images/masks/noi-neszeszer/back-color.png",
    surfaceMask: "/images/masks/noi-neszeszer/back-pattern.png",
    protectMasks: [{ id: "back-zipper", label: "Hátsó cipzár", url: "/images/masks/noi-neszeszer/back-zipper.png" }],
  });
  const front = { ...newDesign(pouchProfile, "gyongyvaszon"), fabricColor: "#123456" };
  const back = { ...newDesign(backProfile, "szaten"), fabricColor: "#abcdef" };
  const profiles = { front: pouchProfile, back: backProfile };
  const collection = {
    format: "roli-2d-design", version: 2, profileId: pouchProfile.id, productId: pouchProfile.productId,
    activeView: "back", views: { front, back },
  };
  const restored = parseDesignCollection(JSON.stringify(collection), profiles, MATERIALS, "front");
  assert.equal(restored.activeView, "back");
  assert.equal(restored.views.front.fabricColor, "#123456");
  assert.equal(restored.views.front.materialId, "gyongyvaszon");
  assert.equal(restored.views.back.fabricColor, "#abcdef");
  assert.equal(restored.views.back.canvas.height, 1200);
  const legacy = parseDesignCollection(JSON.stringify(front), profiles, MATERIALS, "front");
  assert.equal(legacy.version, 2);
  assert.deepEqual(legacy.views.front, front);
  assert.throws(() => parseDesignCollection(JSON.stringify({ ...collection, activeView: "right" }), profiles, MATERIALS, "front"), /aktív nézete hiányzik/);
});

test("production pricing never substitutes a local catalog price when Shopify has not supplied one", () => {
  const app = readFileSync(new URL("../src/designer-prototype/main.tsx", import.meta.url), "utf8");
  assert.match(app, /import\.meta\.env\.DEV && typeof material\.priceHuf === "number"/);
  assert.match(app, /price \?\? "Nem érhető el"/);
  assert.match(app, /Shopify-ár/);
});

test("satin softens fine detail, preserves dark seams and keeps sheen bounded", () => {
  assert.equal(satinShade(204, 200, 200), 200.48);
  assert.equal(satinShade(160, 200, 200), 160);
  assert.ok(satinShade(220, 220, 150) <= 227);
  assert.ok(satinShade(220, 220, 150) > 220);
  assert.equal(satinShade(0, 0, 200), 0);
  assert.equal(satinShade(255, 255, 100), 255);
  assert.equal(MATERIALS.find((material) => material.id === "szaten").preview.textureMapping, "satin-soft");
  assert.equal(MATERIALS.find((material) => material.id === "gyongyvaszon").preview.applyTexture, false);
});

test("the artwork surface uses the mask without blending its colors with the photo", () => {
  const css = readFileSync(new URL("../src/designer-prototype/style.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/designer-prototype/main.tsx", import.meta.url), "utf8");
  const surface = css.match(/\.surface\s*\{([^}]*)\}/)?.[1];
  assert.ok(surface);
  assert.match(surface, /mask-size:\s*100% 100%/);
  assert.doesNotMatch(surface, /(?:mix-blend-mode|filter)\s*:/);
  assert.match(app, /className="surface" style=\{\{ maskImage: `url\("\$\{activeMaterialPreview\.surfaceMaskUrl\}"\)`/);
  assert.match(app, /onViewChange\(key\)/);
  assert.match(app, /className="protected-surface"/);
  assert.ok(app.indexOf('className="surface"') < app.indexOf('className="protected-surface"'));
  assert.doesNotMatch(app, /className="product-selector"/);
  assert.match(css, /\.protected-surface\s*\{[^}]*mask-size:\s*100% 100%/);
});

test("new design placement spans the full reference image and legacy designs remain normalized", () => {
  const design = newDesign();
  assert.deepEqual(design.area, { x: 0, y: 0, width: pouchProfile.canvas.width, height: pouchProfile.canvas.height });
  const old = {
    ...design,
    area: { x: 120, y: 350, width: 760, height: 370 },
    layers: [{ id: "legacy", type: "text", text: "Terv", color: "#123456", x: 500, y: 500, width: 100, height: 50, rotation: 0 }],
  };
  assert.deepEqual(parseDesign(JSON.stringify(old)).area, design.area);
});

function assertInside(layer, area) {
  const half = rotatedHalfExtents(layer);
  const epsilon = 1e-8;
  assert.ok(layer.x - half.x >= area.x - epsilon);
  assert.ok(layer.x + half.x <= area.x + area.width + epsilon);
  assert.ok(layer.y - half.y >= area.y - epsilon);
  assert.ok(layer.y + half.y <= area.y + area.height + epsilon);
}

test("empty and multilayer designs round-trip with geometry and embedded images", () => {
  const design = newDesign();
  design.layers = [
    { id: "text", type: "text", text: "Árvíztűrő", color: "#123456", x: 200, y: 450, width: 100, height: 50, rotation: 37 },
    { id: "image", type: "image", name: "test.png", src: "data:image/png;base64,aGVsbG8=", x: 300, y: 500, width: 80, height: 40, rotation: -12 },
  ];
  assert.deepEqual(parseDesign(JSON.stringify(design)), design);
  assert.deepEqual(parseDesign(JSON.stringify(newDesign())), newDesign());
});

test("fabric color is validated and survives mixed-layer JSON; legacy designs keep the original photo", () => {
  const design = newDesign();
  design.fabricColor = "#8c9c84";
  design.layers = [
    { id: "text", type: "text", text: "Terv", color: "#123456", x: 400, y: 500, width: 100, height: 50, rotation: 0 },
    { id: "image", type: "image", name: "test.png", src: "data:image/png;base64,YQ==", x: 400, y: 500, width: 100, height: 50, rotation: 0 },
  ];
  assert.deepEqual(parseDesign(JSON.stringify(design)), design);
  assert.equal(parseDesign(JSON.stringify(newDesign())).fabricColor, undefined);
  for (const invalid of ["red", "#123", "#12345678", "", null, 42, {}]) {
    assert.throws(() => parseDesign(JSON.stringify({ ...design, fabricColor: invalid })), /anyagszíne/);
  }
});

test("materials round-trip with mixed layers and older designs use the default material", () => {
  const design = newDesign();
  design.materialId = "szaten";
  design.fabricColor = "#8c9c84";
  design.layers = [
    { id: "text", type: "text", text: "Terv", color: "#123456", x: 400, y: 500, width: 100, height: 50, rotation: 0 },
    { id: "image", type: "image", name: "test.png", src: "data:image/png;base64,YQ==", x: 400, y: 500, width: 100, height: 50, rotation: 0 },
    { id: "pattern", type: "image", name: "Minta", src: "data:image/png;base64,Yg==", pattern: { id: "builtin-dots", variantId: "rose" }, x: 400, y: 500, width: 100, height: 50, rotation: 0 },
  ];
  assert.deepEqual(parseDesign(JSON.stringify(design)), design);
  const { materialId, ...legacy } = design;
  assert.equal(parseDesign(JSON.stringify(legacy)).materialId, DEFAULT_MATERIAL_ID);
  for (const invalid of ["missing", "", null, 2, {}]) {
    assert.throws(() => parseDesign(JSON.stringify({ ...design, materialId: invalid })), /anyaga/);
  }
  assert.equal(materialId, "szaten");
});

test("material configurations have independent pattern lists and warn without removing layers", () => {
  assert.deepEqual(MATERIALS.map((material) => material.id), ["gyongyvaszon", "szaten"]);
  for (const material of MATERIALS) {
    assert.equal(material.layoutId, pouchProfile.id);
    assert.ok(material.previewUrl && material.textureUrl && material.preview.photoUrl && material.preview.colorMaskUrl && material.preview.surfaceMaskUrl);
    assert.ok(material.colors.length);
    assert.ok(material.patterns.every((pattern) => BUILTIN_DESIGN_PATTERNS.some((builtin) => builtin.id === pattern.id)));
  }
  assert.notEqual(MATERIALS[0].patterns, MATERIALS[1].patterns);
  const layers = [
    { type: "image", pattern: { id: "builtin-dots" } },
    { type: "text" },
    { type: "image", pattern: { id: "builtin-stripes" } },
  ];
  const other = { ...MATERIALS[1], patterns: BUILTIN_DESIGN_PATTERNS.filter((pattern) => pattern.id === "builtin-dots") };
  assert.deepEqual(unavailablePatternIds(layers, other), ["builtin-stripes"]);
  assert.equal(layers.length, 3);
});

test("formatted multiline text survives JSON and legacy text remains compatible", () => {
  const design = newDesign();
  const base = { type: "text", text: "Árvíztűrő\nTükörfúrógép", color: "#123456", x: 400, y: 500, width: 200, height: 100, rotation: 30 };
  design.layers = [
    { ...base, id: "styled", style: { font: "serif", size: 42, bold: true, italic: true, align: "right", letterSpacing: 0.13, lineHeight: 1.8 } },
    { ...base, id: "legacy" },
  ];
  assert.deepEqual(parseDesign(JSON.stringify(design)), design);
  const style = design.layers[0].style;
  for (const invalid of [
    { ...style, font: "unknown" }, { ...style, font: "__proto__" }, { ...style, size: 0 },
    { ...style, bold: "true" }, { ...style, italic: 1 }, { ...style, align: "justify" },
    { ...style, letterSpacing: 1 }, { ...style, lineHeight: 0 }, null, {},
  ]) {
    assert.throws(() => parseDesign(JSON.stringify({ ...design, layers: [{ ...design.layers[0], style: invalid }] })));
  }
});

test("text layout preserves lines, alignment and spacing while fitting the box", () => {
  const measure = (line) => Array.from(line).length * 60;
  const short = textLayout("Első\nMásodik\n", 300, 150, { ...DEFAULT_TEXT_STYLE, align: "left" }, measure);
  assert.deepEqual(short.lines, ["Első", "Második", ""]);
  assert.equal(short.x, 18);
  assert.equal(short.anchor, "start");
  assert.ok(short.size * (1.4 + (short.lines.length - 1) * DEFAULT_TEXT_STYLE.lineHeight) <= 150 * 0.88);
  const loose = textLayout("Első\nMásodik", 300, 150, { ...DEFAULT_TEXT_STYLE, lineHeight: 3, align: "right" }, measure);
  const tight = textLayout("Első\nMásodik", 300, 150, { ...DEFAULT_TEXT_STYLE, lineHeight: 0.8, align: "center" }, measure);
  assert.equal(loose.anchor, "end");
  assert.ok(loose.size < tight.size);
  const long = textLayout("x".repeat(200), 300, 150, { ...DEFAULT_TEXT_STYLE, letterSpacing: 0.5 }, measure);
  assert.ok(long.fitted);
  assert.ok(long.size * (120 + 199 * 0.5 + 0.2) <= 300 * 0.88 + 1e-8);
});

test("the existing pattern examples are distinct and available in the library", () => {
  assert.deepEqual(BUILTIN_DESIGN_PATTERNS.map((pattern) => pattern.id), [
    "builtin-dots", "builtin-stripes", "builtin-checks",
  ]);
  assert.equal(new Set(BUILTIN_DESIGN_PATTERNS.map((pattern) => pattern.previewUrl)).size, 3);
  for (const pattern of BUILTIN_DESIGN_PATTERNS) {
    assert.ok(pattern.active);
    assert.match(pattern.name, /ideiglenes/);
    assert.match(decodeURIComponent(pattern.previewUrl), /^data:image\/svg\+xml;utf8,<svg /);
    assert.equal(pattern.variants[0].previewUrl, pattern.previewUrl);
    assert.ok(pattern.variants.length > 1);
    const geometry = pattern.variants.map((variant) => decodeURIComponent(variant.imageUrl).replaceAll(variant.color, "#COLOR"));
    assert.ok(geometry.every((shape) => shape === geometry[0]));
  }
});

test("pattern metadata survives a round-trip while legacy images remain compatible", () => {
  const design = newDesign();
  const base = { type: "image", name: "Minta", src: "data:image/png;base64,YQ==", x: 400, y: 500, width: 100, height: 100, rotation: 20 };
  design.layers = [
    { ...base, id: "pattern", pattern: { id: "builtin-dots", variantId: "rose" } },
    { ...base, id: "legacy" },
  ];
  assert.deepEqual(parseDesign(JSON.stringify(design)), design);
  for (const pattern of [{ id: "", variantId: "rose" }, { id: "dots" }, { id: "x".repeat(101), variantId: "rose" }, null]) {
    assert.throws(() => parseDesign(JSON.stringify({ ...design, layers: [{ ...design.layers[0], pattern }] })));
  }
});

test("multiple uploaded and duplicate pattern layers keep their images and order in JSON", () => {
  const design = newDesign();
  const image = (id, name, src) => ({
    id, type: "image", name, src, x: 400, y: 500, width: 100, height: 100, rotation: 0,
  });
  design.layers = [
    image("upload-1", "one.png", "data:image/png;base64,YQ=="),
    image("pattern-1", "Minta: Pöttyök", "data:image/png;base64,Yg=="),
    image("upload-2", "two.webp", "data:image/webp;base64,Yw=="),
    image("pattern-2", "Minta: Pöttyök", "data:image/png;base64,Yg=="),
  ];
  assert.deepEqual(parseDesign(JSON.stringify(design)), design);
});

test("non-destructive image edits round-trip and invalid settings are rejected", () => {
  const design = newDesign();
  const image = { id: "image", type: "image", name: "test.png", src: "data:image/png;base64,YQ==", x: 400, y: 500, width: 100, height: 100, rotation: 20 };
  const edit = { crop: { left: 0.1, right: 0.2, top: 0.15, bottom: 0.05 }, opacity: 0.42, flipX: true, flipY: true };
  design.layers = [{ ...image, edit }, { ...image, id: "legacy" }];
  assert.deepEqual(parseDesign(JSON.stringify(design)), design);
  for (const invalid of [
    { ...edit, opacity: -1 }, { ...edit, opacity: 1.1 }, { ...edit, flipX: 1 },
    { ...edit, crop: { ...edit.crop, left: -0.1 } },
    { ...edit, crop: { ...edit.crop, right: 0.9 } },
    { ...edit, crop: { ...edit.crop, bottom: 1 } }, { ...edit, crop: {} }, null,
  ]) {
    assert.throws(() => parseDesign(JSON.stringify({ ...design, layers: [{ ...image, edit: invalid }] })));
  }
  assert.throws(() => parseDesign(JSON.stringify({ ...design, layers: [{ ...image, edit, pattern: { id: "x", variantId: "x" } }] })));
});

test("crop presets retain the source and achieve the requested aspect ratio", () => {
  for (const [width, height] of [[1000, 500], [500, 1000], [300, 300]]) {
    for (const ratio of [1, 4 / 3, 3 / 4, 16 / 9]) {
      const crop = cropToAspect(width, height, ratio);
      assert.ok(Math.abs(cropAspect(crop, width, height) - ratio) < 1e-10);
      assert.ok(crop.left >= 0 && crop.right >= 0 && crop.top >= 0 && crop.bottom >= 0);
      const dimensions = sizeWithin(200, 150, ratio);
      assert.ok(dimensions.width <= 200 && dimensions.height <= 150);
      assert.ok(Math.abs(dimensions.width / dimensions.height - ratio) < 1e-10);
      assertInside(fitLayer({ x: 100, y: 350, ...dimensions, rotation: 45 }, pouchProfile.area), pouchProfile.area);
    }
  }
  assert.equal(cropAspect(DEFAULT_IMAGE_EDIT.crop, 400, 200), 2);
});

test("moving, resizing and rotating keep the complete layer inside the configured area", () => {
  const area = pouchProfile.area;
  for (const rotation of [-180, -135, -90, -45, 0, 30, 45, 90, 135, 180]) {
    for (const [x, y] of [[-10000, -10000], [10000, 10000], [500, 500]]) {
      for (const [width, height] of [[20, 20], [1000, 800], [50, 900], [900, 50]]) {
        const fitted = fitLayer({ x, y, width, height, rotation }, area);
        assertInside(fitted, area);
        assert.ok(Math.abs(fitted.width / fitted.height - width / height) < 1e-8);
      }
    }
  }
});

test("older designs use current profile geometry and fit their layers", () => {
  const design = newDesign();
  design.area = { x: 120, y: 350, width: 760, height: 370 };
  design.layers = [{ id: "edge", type: "text", text: "Terv", color: "#123456", x: 120, y: 350, width: 500, height: 250, rotation: 45 }];
  const restored = parseDesign(JSON.stringify(design));
  assert.deepEqual(restored.area, pouchProfile.area);
  assertInside(restored.layers[0], restored.area);
  assert.equal(restored.layers[0].rotation, 45);
  assert.throws(() => parseDesign(JSON.stringify({ ...design, canvas: { width: 1000, height: 1200 } })));
});

test("invalid documents and duplicate or unsafe layers are rejected", () => {
  const design = newDesign();
  assert.throws(() => parseDesign("{"));
  assert.throws(() => parseDesign(JSON.stringify({ ...design, version: 2 })));
  assert.throws(() => parseDesign(JSON.stringify({ ...design, area: { x: 0, y: 0, width: 2000, height: 2 } })));
  const text = { id: "same", type: "text", text: "x", color: "#000000", x: 200, y: 450, width: 50, height: 50, rotation: 0 };
  assert.throws(() => parseDesign(JSON.stringify({ ...design, layers: [text, text] })));
  assert.throws(() => parseDesign(JSON.stringify({ ...design, layers: Array(MAX_LAYERS + 1).fill(text) })));
  assert.throws(() => parseDesign(JSON.stringify({ ...design, layers: [{ ...text, type: "image", src: "https://example.com/image.png", name: "x" }] })));
  assert.throws(() => parseDesign(JSON.stringify({ ...design, layers: [{ ...text, x: -1 }] })));
});

test("upload validation checks declared type, signature and size", async () => {
  const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "a.png", { type: "image/png" });
  await validateImage(png);
  await assert.rejects(validateImage(new File(["not an image"], "a.png", { type: "image/png" })));
  await assert.rejects(validateImage(new File(["x"], "a.svg", { type: "image/svg+xml" })));
  await assert.rejects(validateImage(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "a.png", { type: "image/png" })));
});

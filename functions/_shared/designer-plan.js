const viewKeys = ["front", "back", "right", "left"];
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function viewCanvas(profile, key) {
  const view = profile.views ? profile.views[key] : key === "front" ? profile : undefined;
  return view?.photo && view.fabricMask && view.surfaceMask && isRecord(view.canvas) ? view.canvas : null;
}

export function normalizeDesignPlan(plan, product, validateView) {
  if (!isRecord(plan) || plan.format !== "roli-2d-design") return null;
  if (plan.version === 1) {
    const design = {
      ...plan,
      productId: plan.productId === undefined ? "womens-pouch" : plan.productId,
      materialId: plan.materialId === undefined ? "gyongyvaszon" : plan.materialId,
    };
    const canvas = viewCanvas(product.profile, "front");
    if (!canvas || !validateView(design, product, canvas)) return null;
    return {
      format: plan.format, version: 2, profileId: design.profileId,
      productId: design.productId, activeView: "front", views: { front: design },
    };
  }
  if (plan.version !== 2 || plan.profileId !== product.profile.id ||
      plan.productId !== product.profile.productId || !viewKeys.includes(plan.activeView) ||
      !isRecord(plan.views)) return null;
  const keys = Object.keys(plan.views);
  if (!keys.length || keys.length > viewKeys.length || !keys.includes(plan.activeView)) return null;
  for (const key of keys) {
    if (!viewKeys.includes(key)) return null;
    const canvas = viewCanvas(product.profile, key);
    if (!canvas || !validateView(plan.views[key], product, canvas)) return null;
  }
  return plan;
}

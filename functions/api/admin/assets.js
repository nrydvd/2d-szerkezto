import { configured, errorResponse, hasAdminAccess, sameOrigin, storeAsset } from "../../_shared/http.js";

export async function onRequestPost({ request, env }) {
  if (!configured(env)) return errorResponse("A szerkesztő képtára nincs konfigurálva.", 503);
  if (!sameOrigin(request)) return errorResponse("Idegen webhelyről érkező feltöltés elutasítva.", 403);
  if (!await hasAdminAccess(request, env)) return errorResponse("Az adminisztrációhoz Cloudflare Access belépés szükséges.", 401);
  try {
    const result = await storeAsset(request, env, "admin", 25 * 1024 * 1024);
    return result.response;
  } catch (error) {
    console.error("Az admin fájlfeltöltése nem sikerült.", error);
    return errorResponse("A fájlt nem sikerült az R2-tárba menteni.", 500);
  }
}

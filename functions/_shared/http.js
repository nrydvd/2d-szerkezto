const accessCertificates = new Map();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(message, status) {
  return json({ error: message }, status);
}

export function configured(env) {
  return Boolean(env.SHOP_DB && env.SHOP_ASSETS);
}

export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin === new URL(request.url).origin;
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

export async function hasAdminAccess(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  if (!token || !teamDomain || !audience) return false;

  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) return false;
  try {
    const header = decodeJsonPart(encodedHeader);
    const claims = decodeJsonPart(encodedPayload);
    const issuer = `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      claims.iss !== issuer ||
      !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience) ||
      typeof claims.exp !== "number" ||
      claims.exp <= Date.now() / 1000 ||
      (typeof claims.nbf === "number" && claims.nbf > Date.now() / 1000)
    ) return false;

    let certificates = accessCertificates.get(issuer);
    if (!certificates || certificates.expiresAt <= Date.now()) {
      const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
      if (!response.ok) return false;
      const body = await response.json();
      certificates = { keys: body.keys, expiresAt: Date.now() + 5 * 60 * 1000 };
      accessCertificates.set(issuer, certificates);
    }
    const jwk = certificates.keys.find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
  } catch {
    return false;
  }
}

export function safeFileName(name) {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 180) || "upload";
}

export async function storeAsset(request, env, purpose, maxBytes) {
  const form = await request.formData();
  const file = form.get("file");
  const assetPurpose = purpose === "admin"
    ? form.get("purpose") === "internal" ? "admin" : "public"
    : purpose;
  if (!(file instanceof File) || file.size < 1 || file.size > maxBytes) {
    return { response: errorResponse(`A fájl legfeljebb ${Math.floor(maxBytes / (1024 * 1024))} MB lehet.`, 400) };
  }
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowedTypes.has(file.type)) return { response: errorResponse("Nem támogatott fájltípus.", 415) };

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type.startsWith("image/") && !hasImageSignature(bytes, file.type)) {
    return { response: errorResponse("A fájl tartalma nem egyezik a megadott képfajtával.", 400) };
  }
  const id = crypto.randomUUID();
  const fileName = safeFileName(file.name);
  try {
    await env.SHOP_ASSETS.put(id, bytes, {
      httpMetadata: { contentType: file.type.startsWith("model/") ? "model/gltf-binary" : file.type },
      customMetadata: { fileName, purpose: assetPurpose },
    });
    await env.SHOP_DB.prepare(
      "INSERT INTO shop_assets (id, file_name, content_type, byte_length, purpose) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, fileName, file.type, file.size, assetPurpose).run();
    return { response: json({ id }) };
  } catch (error) {
    await env.SHOP_ASSETS.delete(id);
    throw error;
  }
}

function hasImageSignature(bytes, type) {
  if (type === "image/png") {
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/webp") {
    return bytes.length >= 12 &&
      new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  }
  return false;
}

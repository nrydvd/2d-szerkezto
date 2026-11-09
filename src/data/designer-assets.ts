const DATABASE_NAME = "roli-private-local-assets";
const DATABASE_VERSION = 1;
const ASSET_STORE = "assets";

interface StoredAsset {
  id: string;
  blob: Blob;
  name: string;
  mimeType: string;
  createdAt: string;
}

function openAssetDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("Ez a böngésző nem támogatja a helyi képtárolást."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ASSET_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Nem sikerült megnyitni a helyi képtárat."));
    request.onblocked = () => reject(new Error("A helyi képtár megnyitását egy másik böngészőlap blokkolja."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("A helyi képtár művelete sikertelen."));
  });
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export async function saveAsset(file: File | Blob, name = "feltöltött-kép"): Promise<string> {
  if (import.meta.env.PROD) {
    const form = new FormData();
    form.set("file", file, name);
    const response = await fetch("/api/admin/assets", {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!response.ok) {
      throw new Error(await responseMessage(response, "A fájlt nem sikerült a központi tárba feltölteni."));
    }
    const result = await response.json() as { id?: unknown };
    if (typeof result.id !== "string" || !result.id) {
      throw new Error("A fájltár érvénytelen azonosítót adott vissza.");
    }
    return result.id;
  }

  const database = await openAssetDatabase();
  try {
    const asset: StoredAsset = {
      id: crypto.randomUUID(),
      blob: file,
      name,
      mimeType: file.type,
      createdAt: new Date().toISOString(),
    };
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    await requestResult(transaction.objectStore(ASSET_STORE).add(asset));
    return asset.id;
  } catch (error) {
    console.error("A feltöltött fájl helyi mentése sikertelen.", error);
    throw new Error("A fájl nem menthető a böngésző helyi képtárába.");
  } finally {
    database.close();
  }
}

export async function loadAssetUrl(assetId: string): Promise<string> {
  if (import.meta.env.PROD) {
    const assetPath = `/api/assets/${encodeURIComponent(assetId)}`;
    let response = await fetch(assetPath, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.status === 401) {
      response = await fetch(`/api/admin/assets/${encodeURIComponent(assetId)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
    }
    if (response.ok) return URL.createObjectURL(await response.blob());
    if (response.status !== 404) {
      throw new Error(await responseMessage(response, "A központi fájltárból nem tölthető be a fájl."));
    }
  }
  return URL.createObjectURL(await loadLocalAssetBlob(assetId));
}

export async function loadLocalAssetBlob(assetId: string): Promise<Blob> {
  const database = await openAssetDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE, "readonly");
    const asset = await requestResult<StoredAsset | undefined>(
      transaction.objectStore(ASSET_STORE).get(assetId),
    );
    if (!asset) throw new Error(`A helyi fájl nem található (${assetId}).`);
    return asset.blob;
  } finally {
    database.close();
  }
}

export async function deleteUnusedAsset(assetUrl: string, catalog: unknown): Promise<void> {
  const local = /^local:([a-f0-9-]{36})$/.exec(assetUrl);
  const remote = /^\/api\/assets\/([a-f0-9-]{36})$/.exec(assetUrl);
  if (!local && !remote) throw new Error("Ez a beépített fájl nem törölhető a terméktárból.");
  if (local) {
    if (JSON.stringify(catalog).includes(`local:${local[1]}`)) {
      throw new Error("A fájlra még hivatkozik egy mentett termék. Előbb távolítsd el az összes termékből, majd mentsd a katalógust.");
    }
    const database = await openAssetDatabase();
    try {
      const transaction = database.transaction(ASSET_STORE, "readwrite");
      await requestResult(transaction.objectStore(ASSET_STORE).delete(local[1]));
    } finally {
      database.close();
    }
    return;
  }
  const response = await fetch(`/api/admin/assets/${remote![1]}`, {
    method: "DELETE", credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(await responseMessage(response, `A fájl végleges törlése sikertelen (${response.status}).`));
  }
}

import { useEffect, useState } from "react";

type RequestFile = { id: string; role: string; name: string; contentType: string; size: number };
type RequestItem = {
  id: string;
  shopifyLineItemId: string | null;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  designerProductId: string;
  productName: string;
  design: unknown;
  files: RequestFile[];
};
type RequestOrder = { id: string; shopifyOrderId: string | null; createdAt: string; items: RequestItem[] };
type RequestResponse = { orders: RequestOrder[]; error?: string };

const fileLabels: Record<string, string> = {
  plan: "Szerkesztési terv (JSON)",
  preview: "Teljes termékterv (PNG)",
  "view-png": "További nézet (PNG)",
  "production-png": "Gyártási grafika (PNG)",
  "original-upload": "Eredeti vásárlói fájl",
  "summary-pdf": "Tervezési összesítő (PDF)",
  archive: "Teljes fájlcsomag (ZIP)",
};

function fileUrl(id: string, inline = false) {
  return `/api/admin/designer-requests/files/${encodeURIComponent(id)}${inline ? "?inline=1" : ""}`;
}

export function RequestsPage() {
  const [orders, setOrders] = useState<RequestOrder[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/designer-requests", { cache: "no-store" }).then(async (response) => {
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("A vásárlói igényekhez konfigurált Cloudflare D1/R2 API szükséges.");
      }
      const body = await response.json() as RequestResponse;
      if (!response.ok) throw new Error(body.error ?? "A vásárlói igények nem tölthetők be.");
      if (active) setOrders(body.orders);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "A vásárlói igények nem tölthetők be.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function deleteOrder(order: RequestOrder) {
    if (!window.confirm("Véglegesen törlöd ezt az igénycsomagot és minden hozzá tartozó fájlt?")) return;
    setDeleting(order.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/designer-requests/${encodeURIComponent(order.id)}`, {
        method: "DELETE", credentials: "same-origin", redirect: "manual",
      });
      if (!response.ok) {
        const body = response.headers.get("content-type")?.includes("application/json") ? await response.json() as { error?: string } : null;
        throw new Error(body?.error ?? "Az igénycsomag törlése sikertelen; ellenőrizd az adminisztrátori belépést.");
      }
      setOrders((current) => current?.filter((item) => item.id !== order.id) ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Az igénycsomag törlése sikertelen.");
    } finally { setDeleting(null); }
  }

  return <main className="admin requests-page">
    <header>
      <div><a href="/">Ro-Lí</a><h1>Vásárlói igények</h1></div>
      <nav aria-label="Adminisztráció"><a href="/termekek/">Termékadmin</a><a href="/szerkeszto/">Szerkesztő</a></nav>
    </header>
    <section className="request-intro">
      <p className="eyebrow">TERVEZÉSI CSOMAGOK</p>
      <h2>Vásárlói tervek és fájlok</h2>
      <p className="notice">A beküldött tervek itt érhetők el. A Shopify-rendelés azonosítója a konfigurált és sikeresen feldolgozott rendelési webhook után jelenik meg.</p>
    </section>
    {loading && <p role="status">Igénycsomagok betöltése…</p>}
    {error && <p className="request-error" role="alert">{error}</p>}
    {orders?.length === 0 && <p className="request-empty">Még nincs beküldött vásárlói igény.</p>}
    {orders?.map((order) => <details className="request-order" key={order.id}>
      <summary>
        <span><strong>{order.shopifyOrderId ? `Shopify-rendelés ${order.shopifyOrderId}` : "Shopify-rendeléshez nem kapcsolt igény"}</strong>
          <small>{new Date(`${order.createdAt.includes("T") ? order.createdAt : order.createdAt.replace(" ", "T")}${order.createdAt.endsWith("Z") ? "" : "Z"}`).toLocaleString("hu-HU")} · {order.items.length} terméktétel</small>
        </span>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="request-order-content">
        <button type="button" className="danger" disabled={deleting !== null} onClick={() => void deleteOrder(order)}>
          {deleting === order.id ? "Törlés…" : "Igénycsomag törlése"}
        </button>
        {order.items.map((item) => {
          const preview = item.files.find((file) => file.role === "preview");
          return <details className="request-item" key={item.id}>
            <summary><span><strong>{item.productName}</strong><small>Tervező termékazonosító: {item.designerProductId}</small></span><span aria-hidden="true">⌄</span></summary>
            <div className="request-item-content">
              {preview && <a className="request-preview-link" href={fileUrl(preview.id, true)} target="_blank" rel="noreferrer">
                <img src={fileUrl(preview.id, true)} alt={`${item.productName} teljes termékterve`} />
                <span>Teljes termékterv megnyitása</span>
              </a>}
              <h3>Fájlok</h3>
              <ul className="request-file-list">
                {item.files.map((file) => <li key={file.id}>
                  <a href={fileUrl(file.id, file.role === "summary-pdf")} target={file.role === "summary-pdf" ? "_blank" : undefined}
                    rel={file.role === "summary-pdf" ? "noreferrer" : undefined} download={file.role === "summary-pdf" ? undefined : file.name}>
                    {fileLabels[file.role] ?? file.role}: {file.name}
                  </a>
                  <small>{(file.size / 1024).toFixed(0)} KB</small>
                </li>)}
              </ul>
              <details className="request-plan">
                <summary>Rövid tervadatok megtekintése</summary>
                <pre>{JSON.stringify(item.design, null, 2)}</pre>
              </details>
              {item.files.filter((file) => file.role === "plan").map((file) =>
                <p key={file.id}><a href={fileUrl(file.id, true)} target="_blank" rel="noreferrer">Teljes szerkesztési terv megtekintése JSON-ként ↗</a></p>)}
              <p className="notice">Shopify line item, product és variáns ID: {item.shopifyLineItemId ?? "—"} · {item.shopifyProductId ?? "—"} · {item.shopifyVariantId ?? "—"}</p>
            </div>
          </details>;
        })}
      </div>
    </details>)}
  </main>;
}

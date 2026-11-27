// Aviso a TODO el equipo cuando la líder financiera (o un admin) aprueba una hoja de gastos.
// Lo llama la app justo después de aprobarla: POST /api/aviso-hoja?id=<id de la solicitud>
// con la sesión de quien aprueba. Se comprueba aquí que esa persona puede aprobar (admin o
// perfiles.finanzas) y que la hoja está de verdad aprobada; cada hoja se avisa una sola vez.
import webpush from "web-push";

const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const eur = n => (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const nombreCorto = n => String(n || "").split(" ")[0];

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Solo POST" });
    if (!SB_URL || !SB_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(500).json({ error: "Faltan variables de entorno" });
    webpush.setVapidDetails("mailto:keia@keia.company", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

    // ¿Quién lo pide? Tiene que ser admin o líder financiera
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
    if (!u.ok) return res.status(401).json({ error: "Sesión no válida" });
    const email = String((await u.json()).email || "").toLowerCase();
    const [yo] = await sb(`perfiles?select=nombre,rol,finanzas&email=eq.${encodeURIComponent(email)}`);
    if (!yo || !(yo.rol === "admin" || yo.finanzas)) return res.status(403).json({ error: "Solo la líder financiera o un admin" });

    // La hoja tiene que existir y estar aprobada
    const id = parseInt(req.query?.id, 10);
    if (!id) return res.status(400).json({ error: "Falta el id" });
    const [hoja] = await sb(`solicitudes_hoja_gasto?select=id,estado,datos&id=eq.${id}`);
    if (!hoja || hoja.estado !== "aprobada") return res.status(409).json({ error: "La hoja no está aprobada" });

    // Una sola vez por hoja (si se pulsa dos veces o se aprueba desde dos sitios no se repite)
    const marca = await sb("audit_progress?on_conflict=key", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ key: `aviso_hoja|${id}`, val: { por: yo.nombre, cuando: new Date().toISOString() } }),
    });
    if (!marca?.length) return res.status(200).json({ enviado: 0, motivo: "Ya se avisó de esta hoja" });

    let d = {}; try { d = JSON.parse(hoja.datos || "{}"); } catch {}
    const quien = nombreCorto(d.nombre) || "alguien";
    const detalle = [d.proyecto, d.actividad].filter(Boolean).join(" · ");
    const body = `${nombreCorto(yo.nombre)} ha aprobado la hoja de gastos de ${quien}: ${eur(d.total)}${detalle ? ` (${detalle})` : ""}.`;

    // Todo el equipo (los visitantes, como el profesorado, no)
    const equipo = new Set((await sb("perfiles?select=nombre&rol=in.(admin,miembro)")).map(p => p.nombre));
    const subs = (await sb("push_suscripciones?select=endpoint,persona,sub")).filter(s => equipo.has(s.persona));
    let ok = 0, borradas = 0;
    await Promise.all(subs.map(async s => {
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({ title: "KEIA · Hoja de gastos aprobada ✅", body, url: "/?tab=finanzas", tag: `hoja-${id}` }), { TTL: 24 * 3600 });
        ok++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await sb(`push_suscripciones?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" }).catch(() => {});
          borradas++;
        } else console.error("push hoja", s.persona, e.statusCode, e.body);
      }
    }));
    return res.status(200).json({ enviado: ok, de: subs.length, borradas });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}

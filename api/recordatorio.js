// Recordatorio de horas: notificación push de lunes a viernes a las 18:00 (hora de Madrid).
// Lo lanza Supabase (pg_cron + pg_net) a las 16:00 y 17:00 UTC; aquí solo se envía si en Madrid son las 18,
// así funciona igual en horario de verano y de invierno.
// También sirve para "Enviarme una prueba" desde la app (?prueba=1 con la sesión de la persona).
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

// Partes de la fecha/hora actual en Madrid
function madrid(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24, weekday: p.weekday };
}

const fmt = s => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`; };

function mensaje(persona, horas) {
  const mias = horas.filter(e => e.persona === persona);
  const enCurso = mias.find(e => e.enCurso);
  const segs = mias.reduce((a, e) => a + (e.enCurso ? (Date.now() - new Date(e.inicio).getTime()) / 1000 : (parseFloat(e.segundos) || 0)), 0);
  const nombre = String(persona || "").split(" ")[0];
  if (enCurso) return `${nombre}, tienes el contador en marcha${enCurso.proyecto ? ` (${enCurso.proyecto})` : ""}. Páralo cuando acabes 😉`;
  if (segs < 60) return `${nombre}, hoy todavía no has apuntado horas. ¡Cuéntalas antes de desconectar!`;
  return `${nombre}, hoy llevas ${fmt(segs)}. Revisa que esté todo apuntado.`;
}

export default async function handler(req, res) {
  try {
    if (!SB_URL || !SB_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(500).json({ error: "Faltan variables de entorno" });
    webpush.setVapidDetails("mailto:keia@keia.company", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

    const prueba = req.query?.prueba === "1";
    let soloPersona = null;

    if (prueba) {
      // Prueba desde la app: solo a los dispositivos de quien la pide
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
      if (!u.ok) return res.status(401).json({ error: "Sesión no válida" });
      const email = String((await u.json()).email || "").toLowerCase();
      const perf = await sb(`perfiles?select=nombre&email=eq.${encodeURIComponent(email)}`);
      soloPersona = perf?.[0]?.nombre;
      if (!soloPersona) return res.status(403).json({ error: "Sin perfil" });
    } else {
      if (req.headers["x-recordatorio-secret"] !== process.env.RECORDATORIO_SECRET) return res.status(401).json({ error: "No autorizado" });
      const m = madrid();
      if (req.query?.forzar !== "1" && (m.hour !== 18 || ["Sat", "Sun"].includes(m.weekday))) return res.status(200).json({ enviado: false, motivo: `En Madrid son las ${m.hour}h (${m.weekday})` });
      if (req.query?.persona) soloPersona = String(req.query.persona); // envío manual a una sola persona
    }

    const subs = await sb(`push_suscripciones?select=endpoint,persona,sub${soloPersona ? `&persona=eq.${encodeURIComponent(soloPersona)}` : ""}`);
    if (!subs.length) return res.status(200).json({ enviado: 0, motivo: "Nadie tiene el recordatorio activado" });

    // Horas de hoy (desde ayer a medianoche UTC para no perder nada; luego se filtra por el día de Madrid)
    const hoy = madrid().ymd;
    const desde = new Date(Date.now() - 36 * 3600e3).toISOString();
    const filas = await sb(`audit_progress?select=val&key=like.horas%7C*&val->>inicio=gte.${encodeURIComponent(desde)}`);
    const horas = filas.map(r => r.val).filter(v => v && v.inicio && !v.borrado && (v.enCurso || madrid(new Date(v.inicio)).ymd === hoy));

    let ok = 0, borradas = 0; const errores = [];
    await Promise.all(subs.map(async s => {
      const payload = JSON.stringify({
        title: prueba ? "KEIA · Prueba del recordatorio" : "KEIA · ¿Has contado tus horas?",
        body: mensaje(s.persona, horas),
        url: "/?tab=clockify",
        tag: "recordatorio-horas",
      });
      try { const r = await webpush.sendNotification(s.sub, payload, { TTL: 3 * 3600, urgency: "high" }); ok++; console.log("push ok", s.persona, r.statusCode); }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { // dispositivo dado de baja
          await sb(`push_suscripciones?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" }).catch(() => {});
          borradas++;
        } else { console.error("push error", s.persona, e.statusCode, e.body); errores.push({ persona: s.persona, status: e.statusCode, body: String(e.body || e.message).slice(0, 200) }); }
      }
    }));
    return res.status(200).json({ enviado: ok, de: subs.length, borradas, errores });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}

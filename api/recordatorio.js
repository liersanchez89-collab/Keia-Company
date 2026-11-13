// Recordatorios de horas: notificación push de lunes a viernes a las 9:00 (entrada: activa el contador)
// y a las 18:00 (salida: cuenta tus horas), hora de Madrid.
// Lo lanza Supabase (pg_cron + pg_net) a las 7, 8, 16 y 17 UTC; aquí solo se envía si en Madrid son las 9 o las 18,
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

const OBJETIVO_H = 40;
const segsDe = e => e.enCurso ? (Date.now() - new Date(e.inicio).getTime()) / 1000 : (parseFloat(e.segundos) || 0);

function mensajeManana(persona, semana) {
  const nombre = String(persona || "").split(" ")[0];
  const segs = semana.filter(e => e.persona === persona).reduce((a, e) => a + segsDe(e), 0);
  const enCurso = semana.find(e => e.persona === persona && e.enCurso);
  if (enCurso) return `Buenos días, ${nombre}. Ya tienes el contador en marcha 💪 Esta semana llevas ${fmt(segs)} de ${OBJETIVO_H} h.`;
  const falta = Math.max(0, OBJETIVO_H * 3600 - segs);
  return segs < 60
    ? `Buenos días, ${nombre}. No te olvides de activar el contador al empezar ⏱ Objetivo: ${OBJETIVO_H} h esta semana.`
    : `Buenos días, ${nombre}. Activa el contador al empezar ⏱ Llevas ${fmt(segs)} de ${OBJETIVO_H} h esta semana${falta ? ` (te faltan ${fmt(falta)})` : " ✅"}.`;
}

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
    let turno = "tarde";

    if (prueba) {
      // Prueba desde la app: solo a los dispositivos de quien la pide
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
      if (!u.ok) return res.status(401).json({ error: "Sesión no válida" });
      const email = String((await u.json()).email || "").toLowerCase();
      const perf = await sb(`perfiles?select=nombre&email=eq.${encodeURIComponent(email)}`);
      soloPersona = perf?.[0]?.nombre;
      if (!soloPersona) return res.status(403).json({ error: "Sin perfil" });
      turno = req.query?.turno === "manana" ? "manana" : "tarde";
    } else {
      if (req.headers["x-recordatorio-secret"] !== process.env.RECORDATORIO_SECRET) return res.status(401).json({ error: "No autorizado" });
      const m = madrid();
      if (req.query?.forzar !== "1" && (![9, 18].includes(m.hour) || ["Sat", "Sun"].includes(m.weekday))) return res.status(200).json({ enviado: false, motivo: `En Madrid son las ${m.hour}h (${m.weekday})` });
      turno = req.query?.turno || (m.hour < 12 ? "manana" : "tarde");
      if (req.query?.persona) soloPersona = String(req.query.persona); // envío manual a una sola persona
    }

    const subs = await sb(`push_suscripciones?select=endpoint,persona,sub${soloPersona ? `&persona=eq.${encodeURIComponent(soloPersona)}` : ""}`);
    if (!subs.length) return res.status(200).json({ enviado: 0, motivo: "Nadie tiene el recordatorio activado" });

    // Horas de hoy (desde ayer a medianoche UTC para no perder nada; luego se filtra por el día de Madrid)
    const hoy = madrid().ymd;
    const desde = new Date(Date.now() - 36 * 3600e3).toISOString();
    const filas = await sb(`audit_progress?select=val&key=like.horas%7C*&val->>inicio=gte.${encodeURIComponent(desde)}`);
    const horas = filas.map(r => r.val).filter(v => v && v.inicio && !v.borrado && (v.enCurso || madrid(new Date(v.inicio)).ymd === hoy));
    // Semana (lunes a domingo, Madrid) para el mensaje de la mañana
    let semana = [];
    if (turno === "manana") {
      const dowIdx = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[madrid().weekday] ?? 0;
      const desdeSem = new Date(Date.now() - (dowIdx + 1) * 864e5).toISOString();
      const filasSem = await sb(`audit_progress?select=val&key=like.horas%7C*&val->>inicio=gte.${encodeURIComponent(desdeSem)}`);
      const [y, mo, d] = hoy.split("-").map(Number);
      const lunes = new Date(Date.UTC(y, mo - 1, d - dowIdx)).toISOString().slice(0, 10);
      semana = filasSem.map(r => r.val).filter(v => v && v.inicio && !v.borrado && (v.enCurso || madrid(new Date(v.inicio)).ymd >= lunes));
    }

    let ok = 0, borradas = 0; const errores = [];
    await Promise.all(subs.map(async s => {
      const payload = JSON.stringify({
        title: prueba ? "KEIA · Prueba del recordatorio" : turno === "manana" ? "KEIA · ¡A por el día!" : "KEIA · ¿Has contado tus horas?",
        body: turno === "manana" ? mensajeManana(s.persona, semana) : mensaje(s.persona, horas),
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

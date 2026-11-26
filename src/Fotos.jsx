// ── Fotos de perfil ──────────────────────────────────────────────────────────
// Cada persona puede subir su foto (tabla fotos_perfil + bucket "avatares" en Supabase).
// <Avatar> la enseña donde antes salía la inicial; si no hay foto, sigue saliendo la inicial.
import { useState, useEffect, useSyncExternalStore, useRef } from "react";
import { createPortal } from "react-dom";
import { sb } from "./supabase.js";
import { perfil, esVisitante } from "./perfil.js";

let fotos = {};               // { nombre: url }
const oyentes = new Set();
const avisar = () => oyentes.forEach(f => f());
const suscribir = f => { oyentes.add(f); return () => oyentes.delete(f); };
const leer = () => fotos;
function poner(nombre, url){ fotos = { ...fotos }; if(url) fotos[nombre] = url; else delete fotos[nombre]; avisar(); }

let iniciado = false;
// Carga las fotos una vez y escucha cambios en tiempo real
export function iniciarFotos(){
  if(iniciado) return; iniciado = true;
  sb.from("fotos_perfil").select("nombre,url").then(({ data }) => {
    if(!data) return;
    fotos = Object.fromEntries(data.map(r => [r.nombre, r.url])); avisar();
  });
  sb.channel("rt:fotos_perfil")
    .on("postgres_changes", { event: "*", schema: "public", table: "fotos_perfil" }, p => {
      if(p.eventType === "DELETE") poner(p.old.nombre, null);
      else poner(p.new.nombre, p.new.url);
    }).subscribe();
}

export const useFotos = () => useSyncExternalStore(suscribir, leer);

// Círculo (o cuadrado redondeado) con la foto de la persona o, si no tiene, su inicial.
// Si tiene foto, al tocarla se abre en grande (ampliable={false} para desactivarlo).
export function Avatar({ nombre, color = "#B5AFA8", size = 28, radius = 99, fontSize, textColor = "#FFF", style, ampliable = true }){
  const f = useFotos();
  const url = f[nombre];
  const base = { width: size, height: size, borderRadius: radius, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", ...style };
  if(url){
    const abrir = ampliable ? e => { e.stopPropagation(); e.preventDefault(); ampliar(nombre, url, color); } : undefined;
    return <img src={url} alt={nombre} loading="lazy" onClick={abrir} title={ampliable ? "Ver foto de " + nombre : undefined}
      style={{ ...base, objectFit: "cover", background: color, cursor: ampliable ? "zoom-in" : base.cursor }}/>;
  }
  return <div style={{ ...base, background: color, color: textColor, fontSize: fontSize || Math.round(size * 0.4), fontWeight: 700 }}>{(nombre || "?")[0]}</div>;
}

// ── Foto ampliada (una sola ventana para toda la app) ──
let grande = null;            // { nombre, url, color } | null
const oyentesG = new Set();
function ampliar(nombre, url, color){ grande = { nombre, url, color }; oyentesG.forEach(f => f()); }
function cerrarGrande(){ grande = null; oyentesG.forEach(f => f()); }
const useGrande = () => useSyncExternalStore(f => { oyentesG.add(f); return () => oyentesG.delete(f); }, () => grande);

export function FotoAmpliada({ font }){
  const g = useGrande();
  useEffect(() => {
    if(!g) return;
    const k = e => { if(e.key === "Escape") cerrarGrande(); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [g]);
  if(!g) return null;
  return createPortal(
    <div onClick={cerrarGrande}
      style={{ position: "fixed", inset: 0, background: "rgba(15,15,15,.82)", zIndex: 2000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 20, cursor: "zoom-out", fontFamily: font }}>
      <img src={g.url} alt={g.nombre}
        style={{ width: "min(82vw, 60vh, 420px)", height: "min(82vw, 60vh, 420px)", objectFit: "cover", borderRadius: 22, boxShadow: "0 0 0 4px #FFF, 0 0 0 7px " + (g.color || "#D94A32") + ", 0 24px 64px rgba(0,0,0,.45)" }}/>
      <div style={{ color: "#FFF", fontSize: 18, fontWeight: 700, fontFamily: "'Manrope','Inter',sans-serif" }}>{g.nombre}</div>
      <div style={{ color: "rgba(255,255,255,.6)", fontSize: 11 }}>Toca en cualquier sitio para cerrar</div>
    </div>,
    document.body
  );
}

// Recorta la imagen en cuadrado y la reduce a 640×640 JPG (pesa poco y carga rápido)
function recortar(file){
  return new Promise((ok, mal) => {
    const img = new Image();
    const u = URL.createObjectURL(file);
    img.onload = () => {
      const lado = Math.min(img.width, img.height), T = 640;
      const c = document.createElement("canvas"); c.width = T; c.height = T;
      c.getContext("2d").drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, 0, 0, T, T);
      URL.revokeObjectURL(u);
      c.toBlob(b => b ? ok(b) : mal(new Error("No se pudo procesar la imagen")), "image/jpeg", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(u); mal(new Error("Ese archivo no es una imagen válida")); };
    img.src = u;
  });
}

async function subirFoto(file){
  const blob = await recortar(file);
  const { data: { user } } = await sb.auth.getUser();
  if(!user) throw new Error("Sesión caducada, vuelve a entrar");
  const carpeta = user.id;
  // Borra las fotos anteriores de su carpeta
  const { data: viejas } = await sb.storage.from("avatares").list(carpeta);
  const ruta = `${carpeta}/foto-${Date.now()}.jpg`;
  const { error: e1 } = await sb.storage.from("avatares").upload(ruta, blob, { contentType: "image/jpeg", upsert: true });
  if(e1) throw e1;
  const url = sb.storage.from("avatares").getPublicUrl(ruta).data.publicUrl;
  const { error: e2 } = await sb.from("fotos_perfil").upsert({ nombre: perfil.nombre, url, updated_at: new Date().toISOString() });
  if(e2) throw e2;
  poner(perfil.nombre, url);
  if(viejas?.length) sb.storage.from("avatares").remove(viejas.map(v => `${carpeta}/${v.name}`)).catch(() => {});
}

async function quitarFoto(){
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from("fotos_perfil").delete().eq("nombre", perfil.nombre);
  if(error) throw error;
  poner(perfil.nombre, null);
  if(user){
    const { data: viejas } = await sb.storage.from("avatares").list(user.id);
    if(viejas?.length) sb.storage.from("avatares").remove(viejas.map(v => `${user.id}/${v.name}`)).catch(() => {});
  }
}

// Botón de la cabecera (tu foto) + ventana para cambiarla
export function BotonPerfil({ color = "#D94A32", font }){
  const [abierto, setAbierto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef(null);
  const f = useFotos();
  const tiene = !!f[perfil.nombre];
  const puede = !!perfil.nombre && !esVisitante();

  useEffect(() => {
    if(!abierto) return;
    const k = e => { if(e.key === "Escape") setAbierto(false); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [abierto]);

  async function elegir(e){
    const file = e.target.files?.[0]; e.target.value = "";
    if(!file) return;
    if(file.size > 15 * 1024 * 1024){ setErr("La imagen pesa demasiado (máx. 15 MB)."); return; }
    setErr(""); setBusy(true);
    try{ await subirFoto(file); }catch(x){ setErr(x.message || "No se pudo subir la foto."); }
    setBusy(false);
  }
  async function quitar(){
    setErr(""); setBusy(true);
    try{ await quitarFoto(); }catch(x){ setErr(x.message || "No se pudo quitar la foto."); }
    setBusy(false);
  }

  if(!perfil.nombre) return null;
  return (
    <>
      <button onClick={() => setAbierto(true)} title="Tu perfil · cambiar foto"
        style={{ background: "transparent", border: "2px solid rgba(255,255,255,.18)", borderRadius: 99, padding: 0, cursor: "pointer", display: "flex", marginLeft: 12, flexShrink: 0 }}>
        <Avatar nombre={perfil.nombre} color={color} size={32} ampliable={false}/>
      </button>
      {abierto && (
        <div onClick={() => !busy && setAbierto(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(23,23,23,.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: font }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: "#FFFFFF", borderRadius: 18, width: "100%", maxWidth: 340, padding: "28px 24px 22px", boxShadow: "0 24px 64px rgba(0,0,0,.25)", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, position: "relative", color: "#171717" }}>
            <button onClick={() => setAbierto(false)} aria-label="Cerrar"
              style={{ position: "absolute", top: 12, right: 12, background: "#F2F0ED", border: "none", borderRadius: 8, width: 28, height: 28, cursor: "pointer", fontSize: 14, color: "#57534E" }}>✕</button>
            <div style={{ position: "relative" }}>
              <Avatar nombre={perfil.nombre} color={color} size={112} ampliable={false} style={{ boxShadow: "0 0 0 4px #FFF, 0 0 0 6px " + color }}/>
              {busy && <div style={{ position: "absolute", inset: 0, borderRadius: 99, background: "rgba(255,255,255,.65)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: 26, height: 26, border: "3px solid #D94A32", borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite" }}/>
              </div>}
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Manrope','Inter',sans-serif" }}>{perfil.nombre}</div>
              <div style={{ fontSize: 12, color: "#6B665F", marginTop: 2 }}>{perfil.rol === "admin" ? "Admin" : perfil.rol === "visitante" ? "Visitante" : "Miembro"}</div>
            </div>
            {puede ? (
              <>
                <input ref={input} type="file" accept="image/*" onChange={elegir} style={{ display: "none" }}/>
                <button disabled={busy} onClick={() => input.current?.click()}
                  style={{ width: "100%", background: "#D94A32", color: "#FFF", border: "none", borderRadius: 10, padding: "12px", fontSize: 14, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? .6 : 1, fontFamily: "inherit" }}>
                  {busy ? "Guardando…" : tiene ? "📷 Cambiar foto" : "📷 Añadir foto de perfil"}
                </button>
                {tiene && <button disabled={busy} onClick={quitar}
                  style={{ width: "100%", background: "transparent", color: "#57534E", border: "1px solid #E5E2DD", borderRadius: 10, padding: "10px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Quitar foto</button>}
                <div style={{ fontSize: 11, color: "#7F7973", textAlign: "center" }}>Se recorta en cuadrado y la ve todo el equipo.</div>
              </>
            ) : <div style={{ fontSize: 12, color: "#6B665F", textAlign: "center" }}>Las cuentas de visitante no pueden poner foto.</div>}
            {err && <div style={{ color: "#B91C1C", fontSize: 12, textAlign: "center" }}>{err}</div>}
            <button onClick={() => sb.auth.signOut()}
              style={{ marginTop: 4, background: "transparent", border: "none", color: "#A8341F", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cerrar sesión</button>
          </div>
        </div>
      )}
    </>
  );
}

// Aviso dentro de la app (no es una notificación del móvil) con lo que ha cambiado
// en la última actualización. Sale 5 segundos, una sola vez por versión y persona.
import { useState, useEffect } from "react";
import { NOVEDADES } from "./novedades.js";

const CLAVE = "keia_novedades_vistas";
const DURACION = 5000;

function pendientes(){
  if(!NOVEDADES.length) return [];
  let vista = null;
  try{ vista = localStorage.getItem(CLAVE); }catch{}
  if(vista === NOVEDADES[0].id) return [];
  const i = vista ? NOVEDADES.findIndex(n => n.id === vista) : -1;
  // Todas las que no ha visto (máx. 3); si no sabemos cuál vio, solo la última
  return (i === -1 ? NOVEDADES.slice(0, 1) : NOVEDADES.slice(0, i)).slice(0, 3);
}

export default function Novedades({ font }){
  const [lista] = useState(pendientes);
  const [fase, setFase] = useState(lista.length ? "entra" : "fuera"); // entra → visible → sale → fuera

  useEffect(() => {
    if(!lista.length) return;
    try{ localStorage.setItem(CLAVE, NOVEDADES[0].id); }catch{}
    const a = setTimeout(() => setFase("visible"), 30);
    const b = setTimeout(() => setFase("sale"), DURACION);
    const c = setTimeout(() => setFase("fuera"), DURACION + 400);
    return () => { clearTimeout(a); clearTimeout(b); clearTimeout(c); };
  }, []);

  if(fase === "fuera") return null;
  const cerrar = () => { setFase("sale"); setTimeout(() => setFase("fuera"), 400); };
  const visible = fase === "visible";
  const cambios = lista.flatMap(n => n.cambios);
  const titulo = lista.length === 1 && lista[0].titulo ? lista[0].titulo : "Novedades";

  return (
    <div role="status" aria-live="polite" onClick={cerrar}
      style={{
        position: "fixed", left: "50%", bottom: 24, zIndex: 2000, width: "calc(100% - 32px)", maxWidth: 420,
        transform: `translate(-50%, ${visible ? "0" : "24px"})`, opacity: visible ? 1 : 0,
        transition: "transform .35s cubic-bezier(.2,.8,.2,1), opacity .35s",
        background: "#171717", color: "#FFFFFF", borderRadius: 14, overflow: "hidden", cursor: "pointer",
        boxShadow: "0 18px 48px -12px rgba(23,23,23,.55)", fontFamily: font,
      }}>
      <style>{`@keyframes keiaNovBarra { from { transform: scaleX(1) } to { transform: scaleX(0) } }`}</style>
      <div style={{ padding: "14px 16px 13px", display: "flex", gap: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: "#D94A32", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>✨</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, fontFamily: "'Manrope','Inter',sans-serif" }}>App actualizada · {titulo}</div>
            <div style={{ fontSize: 10.5, color: "#A8A29E", whiteSpace: "nowrap" }}>{lista[0]?.fecha}</div>
          </div>
          <ul style={{ margin: "6px 0 0", padding: "0 0 0 16px", fontSize: 12.5, lineHeight: 1.45, color: "#E7E5E4" }}>
            {cambios.slice(0, 6).map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      </div>
      <div style={{ height: 3, background: "rgba(255,255,255,.1)" }}>
        <div style={{ height: "100%", background: "#D94A32", transformOrigin: "left", animation: `keiaNovBarra ${DURACION}ms linear forwards` }}/>
      </div>
    </div>
  );
}

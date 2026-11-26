// ─────────────────────────────────────────────────────────────────────────────
//  ESTILO "GLASS" — fondo cálido difuminado, cristal esmerilado, menú en píldora
//  y cifras que se animan al cambiar de pestaña. Solo es apariencia: no toca datos.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from "react";

export const NARANJA = "#D94A32";

// Número que "cuenta" hasta su valor (como en los paneles del vídeo)
export function Contador({ valor, decimales = 0, sufijo = "", duracion = 1100, atenuarDecimales = true }){
  const [v, setV] = useState(0);
  const desde = useRef(0);
  useEffect(()=>{
    const objetivo = Number(valor) || 0;
    const inicio = performance.now();
    const origen = desde.current;
    let raf;
    const paso = (t)=>{
      const p = Math.min(1, (t - inicio) / duracion);
      const e = 1 - Math.pow(1 - p, 3);
      const actual = origen + (objetivo - origen) * e;
      setV(actual);
      if(p < 1) raf = requestAnimationFrame(paso); else desde.current = objetivo;
    };
    raf = requestAnimationFrame(paso);
    return ()=>{ cancelAnimationFrame(raf); desde.current = objetivo; };
  },[valor]);
  const txt = v.toLocaleString("es-ES", { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
  if(!decimales || !atenuarDecimales) return <span>{txt}{sufijo}</span>;
  const i = txt.lastIndexOf(",");
  return <span>{txt.slice(0, i)}<span style={{ opacity: .45 }}>{txt.slice(i)}</span>{sufijo}</span>;
}

// Cabecera grande de cada pestaña: frase pequeña, título, botones blancos, chips y la cifra destacada
export function Hero({ antetitulo, titulo, acciones = [], chips = [], destacada, font, fontTit }){
  return (
    <div className="keia-hero">
      <div className="keia-hero-izq">
        <div className="keia-hero-ante">{antetitulo}</div>
        <h1 className="keia-hero-titulo" style={{ fontFamily: fontTit }}>{titulo}</h1>
        {acciones.length > 0 && (
          <div className="keia-hero-acciones">
            {acciones.map(a => (
              <button key={a.label} className="keia-pildora-blanca" onClick={a.onClick} style={{ fontFamily: font }}>
                <span aria-hidden="true">{a.icono}</span>{a.label}
              </button>
            ))}
          </div>
        )}
        {chips.length > 0 && (
          <div className="keia-chips">
            {chips.map(c => (
              <div key={c.label} className="keia-chip">
                <span className="keia-chip-icono" aria-hidden="true">{c.icono}</span>
                <div>
                  <div className="keia-chip-valor" style={{ fontFamily: fontTit }}><Contador valor={c.valor} sufijo={c.sufijo || ""}/></div>
                  <div className="keia-chip-label">{c.label}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {destacada && (
        <div className="keia-destacada">
          <div className="keia-destacada-top">
            <span><span className="keia-punto" style={{ background: destacada.color || NARANJA }}/>{destacada.etiqueta}</span>
            <span className="keia-destacada-marca" style={{ fontFamily: fontTit }}>{destacada.marca}</span>
          </div>
          <div className="keia-destacada-valor" style={{ fontFamily: fontTit }}>
            <Contador valor={destacada.valor} decimales={destacada.decimales || 0} sufijo={destacada.sufijo || ""}/>
          </div>
          {destacada.detalle && <div className="keia-destacada-pill">{destacada.detalle}</div>}
          {destacada.pie && <div className="keia-destacada-pie">{destacada.pie}</div>}
        </div>
      )}
    </div>
  );
}

// Todo el CSS del estilo glass. Las tarjetas blancas de cada pestaña pasan a ser cristal
// con selectores de atributo (así no hay que tocar las 12.000 líneas de App.jsx una a una).
// OJO: el desenfoque (backdrop-filter) va siempre en un ::before, nunca en el contenedor,
// para no romper las ventanas emergentes con position:fixed que hay dentro.
export const CSS_GLASS = (FONT_TITULOS) => `
  html { background:#3a2a1f; } body { background:transparent !important; }
  .keia-fondo { position:fixed; inset:-40px; z-index:-2; background:#5a4232 url('/fondo-keia.jpg') center/cover no-repeat; filter:saturate(1.05); }
  .keia-fondo::after { content:""; position:absolute; inset:0; background:linear-gradient(180deg, rgba(28,20,15,.42) 0%, rgba(28,20,15,.18) 38%, rgba(20,14,10,.45) 100%); }

  /* ── Cabecera flotante de cristal ── */
  .keia-header { position:sticky; top:12px; z-index:100; margin:12px 18px 0; border-radius:22px; }
  .keia-header::before { content:""; position:absolute; inset:0; z-index:-1; border-radius:inherit;
    background:linear-gradient(180deg, rgba(48,36,28,.62), rgba(36,27,21,.55));
    -webkit-backdrop-filter:blur(22px) saturate(1.4); backdrop-filter:blur(22px) saturate(1.4);
    border:1px solid rgba(255,255,255,.14); box-shadow:inset 0 1px 0 rgba(255,255,255,.12), 0 18px 40px -18px rgba(0,0,0,.55); }
  .keia-header-fila { display:flex; align-items:center; justify-content:space-between; gap:14px; height:64px; padding:0 14px 0 20px; }
  .keia-nav { display:flex; gap:2px; padding:4px; border-radius:999px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.08); overflow-x:auto; scrollbar-width:none; max-width:100%; }
  .keia-nav::-webkit-scrollbar { display:none; }
  .keia-tab { position:relative; background:transparent; border:none; color:rgba(255,255,255,.66); padding:8px 15px; border-radius:999px; font-size:13px; font-weight:500;
    cursor:pointer; white-space:nowrap; font-family:inherit; transition:color .2s, background-color .25s, box-shadow .25s; }
  .keia-tab:hover { color:#FFFFFF; background:rgba(255,255,255,.08); }
  .keia-tab.activa { color:#FFFFFF; font-weight:600;
    background:linear-gradient(180deg, rgba(240,120,92,.95), rgba(217,74,50,.92));
    box-shadow:inset 0 1px 0 rgba(255,255,255,.35), 0 6px 16px -6px rgba(217,74,50,.8); }
  .keia-tab.activa::after { content:""; position:absolute; left:50%; bottom:-9px; width:4px; height:4px; margin-left:-2px; border-radius:50%; background:#fff; opacity:.9; }
  .keia-header-der { display:flex; align-items:center; gap:8px; }
  .keia-salir { background:rgba(255,255,255,.08); color:#F2EEE9; border:1px solid rgba(255,255,255,.14); border-radius:999px; padding:8px 14px;
    font-size:12px; font-weight:500; cursor:pointer; font-family:inherit; white-space:nowrap; }
  .keia-salir:hover { background:rgba(255,255,255,.16) !important; }

  /* ── Hero ── */
  .keia-hero { display:flex; justify-content:space-between; align-items:center; gap:24px; padding:34px 40px 26px; max-width:1400px; margin:0 auto; color:#fff; }
  .keia-hero-izq { min-width:0; }
  .keia-hero-ante { font-size:12.5px; color:rgba(255,255,255,.72); margin-bottom:8px; text-shadow:0 1px 8px rgba(0,0,0,.25); }
  .keia-hero-titulo { font-size:44px; line-height:1.05; font-weight:700; letter-spacing:-1.2px; margin:0 0 18px; color:#fff; text-shadow:0 2px 24px rgba(0,0,0,.25); }
  .keia-hero-acciones { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
  .keia-pildora-blanca { display:inline-flex; align-items:center; gap:8px; background:rgba(255,255,255,.94); color:#2A211B; border:none; border-radius:999px;
    padding:10px 18px; font-size:13px; font-weight:600; cursor:pointer; box-shadow:0 8px 20px -10px rgba(0,0,0,.5), inset 0 -1px 0 rgba(0,0,0,.06);
    transition:transform .2s, box-shadow .2s, background-color .2s; }
  .keia-pildora-blanca:hover { transform:translateY(-1px); background:#fff; box-shadow:0 12px 26px -10px rgba(0,0,0,.55); }
  .keia-chips { display:inline-flex; flex-wrap:wrap; gap:4px; padding:6px; border-radius:20px; position:relative; }
  .keia-chips::before { content:""; position:absolute; inset:0; z-index:-1; border-radius:inherit; background:rgba(255,255,255,.10);
    border:1px solid rgba(255,255,255,.16); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); }
  .keia-chip { display:flex; align-items:center; gap:10px; padding:6px 14px 6px 6px; border-radius:14px; }
  .keia-chip + .keia-chip { border-left:1px solid rgba(255,255,255,.12); border-radius:0 14px 14px 0; padding-left:12px; }
  .keia-chip-icono { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:15px; background:rgba(255,255,255,.14); }
  .keia-chip-valor { font-size:16px; font-weight:700; color:#fff; line-height:1.1; }
  .keia-chip-label { font-size:10.5px; color:rgba(255,255,255,.65); }

  .keia-destacada { position:relative; flex-shrink:0; width:330px; padding:18px 22px 18px; border-radius:24px; color:#fff; }
  .keia-destacada::before { content:""; position:absolute; inset:0; z-index:-1; border-radius:inherit;
    background:linear-gradient(160deg, rgba(70,54,44,.55), rgba(30,22,17,.62));
    border:1px solid rgba(255,255,255,.18); -webkit-backdrop-filter:blur(20px) saturate(1.3); backdrop-filter:blur(20px) saturate(1.3);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.18), 0 30px 50px -24px rgba(0,0,0,.7); }
  .keia-destacada::after { content:""; position:absolute; left:14px; right:14px; top:-8px; height:16px; z-index:-2; border-radius:18px 18px 0 0;
    background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.10); border-bottom:none; }
  .keia-destacada-top { display:flex; justify-content:space-between; align-items:center; font-size:11px; color:rgba(255,255,255,.75); }
  .keia-punto { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:7px; vertical-align:middle; }
  .keia-destacada-marca { font-style:italic; font-weight:800; letter-spacing:.5px; font-size:14px; color:rgba(255,255,255,.75); text-transform:uppercase; }
  .keia-destacada-valor { font-size:38px; font-weight:700; letter-spacing:-1px; margin:14px 0 10px; text-align:center; font-variant-numeric:tabular-nums; }
  .keia-destacada-pill { display:table; margin:0 auto; font-size:11px; padding:4px 12px; border-radius:99px; background:rgba(255,255,255,.12); color:rgba(255,255,255,.85); }
  .keia-destacada-pie { text-align:center; font-size:10.5px; color:rgba(255,255,255,.55); margin-top:10px; }

  /* ── Hoja de contenido: cristal claro ── */
  .keia-hoja { position:relative; margin:0 18px 28px; border-radius:30px; }
  .keia-hoja::before { content:""; position:absolute; inset:0; z-index:-1; border-radius:inherit;
    background:linear-gradient(180deg, rgba(246,242,237,.70), rgba(240,236,231,.80));
    border:1px solid rgba(255,255,255,.55); -webkit-backdrop-filter:blur(30px) saturate(1.2); backdrop-filter:blur(30px) saturate(1.2);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.7), 0 40px 80px -40px rgba(0,0,0,.6); }
  .keia-entrar { animation:keiaEntrar .55s cubic-bezier(.2,.7,.2,1); }
  @keyframes keiaEntrar { from { opacity:0; filter:blur(14px); transform:translateY(10px) scale(.995); } to { opacity:1; filter:none; transform:none; } }

  /* Tarjetas blancas → cristal esmerilado */
  .blesk-content div[style*="background: rgb(255, 255, 255)"][style*="border-radius"] {
    background:linear-gradient(180deg, rgba(255,255,255,.80), rgba(255,255,255,.64)) !important;
    border-color:rgba(255,255,255,.85) !important;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.9), 0 1px 2px rgba(40,28,20,.05), 0 14px 34px -20px rgba(40,28,20,.35);
    transition:box-shadow .25s, transform .25s; }
  .blesk-content div[style*="background: rgb(255, 255, 255)"][style*="border-radius"]:hover {
    box-shadow:inset 0 1px 0 rgba(255,255,255,.95), 0 2px 4px rgba(40,28,20,.05), 0 22px 44px -22px rgba(40,28,20,.45); }
  /* Rellenos suaves (cabeceras de tabla, cajitas) un poco transparentes */
  .blesk-content [style*="background: rgb(247, 246, 244)"] { background:rgba(250,248,245,.62) !important; }
  .blesk-content [style*="background: rgb(242, 240, 237)"] { background:rgba(236,232,226,.55) !important; }
  .blesk-content [style*="background: rgb(237, 235, 232)"] { background:rgba(230,225,218,.50) !important; }
  .blesk-content table { background:transparent; }
  /* Paneles oscuros (carbón) → cristal ahumado, como la tarjeta grande del vídeo */
  .blesk-content div[style*="background: rgb(23, 23, 23)"][style*="border-radius"] {
    background:linear-gradient(160deg, rgba(62,47,38,.90), rgba(28,21,17,.92)) !important;
    border:1px solid rgba(255,255,255,.10);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.12), 0 20px 40px -22px rgba(0,0,0,.6); }

  h1,h2,h3 { font-family:${FONT_TITULOS}; }

  @media (max-width: 900px) {
    .keia-hero { flex-direction:column; align-items:stretch; padding:24px 20px 20px; }
    .keia-destacada { width:auto; }
    .keia-hero-titulo { font-size:34px; }
  }
  @media (max-width: 768px) {
    .keia-header { margin:8px 8px 0; top:8px; border-radius:20px; }
    .keia-header-fila { flex-wrap:wrap; height:auto; padding:10px 10px 10px 14px; row-gap:10px; }
    .keia-nav { order:3; width:100%; }
    .keia-salir-texto { display:none; }
    .keia-hero { padding:20px 14px 16px; }
    .keia-hero-titulo { font-size:30px; letter-spacing:-.8px; }
    .keia-chips { display:grid; grid-template-columns:1fr 1fr; }
    .keia-chip + .keia-chip { border-left:none; }
    .keia-destacada { padding:14px 18px; }
    .keia-destacada-valor { font-size:30px; margin:8px 0 8px; }
    .keia-hoja { margin:0 8px 20px; border-radius:24px; }
  }
  @media (prefers-reduced-motion: reduce) { .keia-entrar { animation:none; } }
`;

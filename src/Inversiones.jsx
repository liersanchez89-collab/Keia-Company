// ── 📈 INVERSIONES (pestaña de Finanzas) ─────────────────────────────────────
// Registro de todo lo que KEIA invierte: compras para usar mucho tiempo (máquinas,
// material, web…), dinero metido en algo (depósito, fondo…) o lo que aporta cada socio.
// Tabla "inversiones" en Supabase (supabase/inversiones.sql). Cualquier miembro añade y
// gestiona; los visitantes solo ven. Es solo registro: no suma ni resta en la cuenta de resultados.
import { useState, useEffect, useCallback } from "react";
import { sb } from "./supabase.js";
import { perfil, puedoGestionar } from "./perfil.js";

export const TIPOS_INVERSION = [
  { id: "equipo",     label: "Equipo / material", icono: "🛠" },
  { id: "digital",    label: "Web / software",    icono: "💻" },
  { id: "financiera", label: "Financiera",        icono: "📈" },
  { id: "socio",      label: "Aportación de socio", icono: "🤝" },
  { id: "otra",       label: "Otra",              icono: "📦" },
];
const tipoDe = id => TIPOS_INVERSION.find(t => t.id === id) || TIPOS_INVERSION[4];
const num = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? null : n; };
const eur = n => (n || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const hoyISO = () => new Date().toISOString().slice(0, 10);
const fechaTxt = f => { if(!f) return "—"; const [y, m, d] = String(f).split("-"); return d ? `${d}/${m}/${y}` : f; };
const nuevoId = () => (crypto?.randomUUID?.() || `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

const VACIA = { concepto: "", tipo: "equipo", fecha: hoyISO(), importe: "", valor_actual: "", proyecto: "", persona: "", notas: "" };

const lbl = { fontSize: 10.5, fontWeight: 600, color: "#6B665F", marginBottom: 4 };
const inp = { width: "100%", boxSizing: "border-box", border: "1px solid #E5E2DD", borderRadius: 10, padding: "9px 11px", fontSize: 13, fontFamily: "inherit", outline: "none", color: "#171717", background: "#FFFFFF" };
const tarjeta = { background: "#FFFFFF", borderRadius: 16, border: "1px solid #E5E2DD", padding: "16px 18px" };
const pildora = (on) => ({ background: on ? "#171717" : "transparent", color: on ? "#FFFFFF" : "#57534E", border: `1px solid ${on ? "#171717" : "#E5E2DD"}`, borderRadius: 99, padding: "6px 13px", fontSize: 12, fontWeight: on ? 600 : 500, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const btnNegro = { background: "#171717", color: "#FFF", border: "none", borderRadius: 99, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const btnBlanco = { background: "#FFFFFF", color: "#3D3A36", border: "1px solid #E5E2DD", borderRadius: 99, padding: "10px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };

export default function InversionesTab({ projects, miembros, fontTit }){
  const [lista, setLista] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [filtro, setFiltro] = useState("todas");
  const [form, setForm] = useState(null);       // null = cerrado; {…} = nueva o editando
  const [guardando, setGuardando] = useState(false);
  const gestiona = puedoGestionar();

  const cargar = useCallback(async () => {
    const { data, error } = await sb.from("inversiones").select("*").order("fecha", { ascending: false });
    if(error){ setError("No se han podido cargar las inversiones."); console.error("❌ inversiones", error); }
    else { setLista(data || []); setError(""); }
    setCargando(false);
  }, []);
  useEffect(() => {
    cargar();
    window.addEventListener("keia:refresco", cargar);
    const canal = sb.channel?.("rt:inversiones")?.on?.("postgres_changes", { event: "*", schema: "public", table: "inversiones" }, cargar)?.subscribe?.();
    return () => { window.removeEventListener("keia:refresco", cargar); try{ canal?.unsubscribe?.(); }catch{} };
  }, [cargar]);

  async function guardar(e){
    e.preventDefault();
    if(!form.concepto.trim()) return alert("Pon qué es la inversión.");
    const importe = num(form.importe);
    if(importe === null || importe <= 0) return alert("Pon cuánto se ha invertido (un número mayor que 0).");
    const fila = {
      id: form.id || nuevoId(), concepto: form.concepto.trim(), tipo: form.tipo, fecha: form.fecha || hoyISO(),
      importe, valor_actual: num(form.valor_actual), proyecto: form.proyecto || null, persona: form.persona || null,
      notas: form.notas.trim() || null, creado_por: form.creado_por || perfil.nombre || null,
    };
    setGuardando(true);
    const { error } = await sb.from("inversiones").upsert(fila);
    setGuardando(false);
    if(error){ console.error("❌ inversiones guardar", error); return alert("No se ha guardado la inversión. Vuelve a intentarlo."); }
    setForm(null); cargar();
  }
  async function borrar(r){
    if(!window.confirm(`¿Borrar la inversión "${r.concepto}"? No se puede deshacer.`)) return;
    const { error } = await sb.from("inversiones").delete().eq("id", r.id);
    if(error){ console.error("❌ inversiones borrar", error); return alert("No se ha podido borrar."); }
    setLista(l => l.filter(x => x.id !== r.id));
  }

  const vista = filtro === "todas" ? lista : lista.filter(r => r.tipo === filtro);
  const totInvertido = vista.reduce((s, r) => s + (Number(r.importe) || 0), 0);
  const conValor = vista.filter(r => r.valor_actual !== null && r.valor_actual !== undefined && r.valor_actual !== "");
  const totValor = vista.reduce((s, r) => s + (conValor.includes(r) ? Number(r.valor_actual) || 0 : Number(r.importe) || 0), 0);
  const dif = totValor - totInvertido;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div>
      <div style={{ background: "#F7F6F4", border: "1px solid #E5E2DD", borderRadius: 10, padding: "10px 14px", fontSize: 12, color: "#57534E", marginBottom: 16 }}>
        📈 Aquí se apunta todo lo que invierte KEIA: máquinas y material, web o software, dinero metido en algo (depósito, fondo…) o lo que aporta cada socio.
        Es un <b>registro</b>: no suma ni resta en 💰 Ingresos y gastos. Si algo cambia de valor, actualiza su <b>valor actual</b>.
      </div>

      {/* Resumen */}
      <div className="blesk-grid-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
        {[
          { t: "Total invertido", v: eur(totInvertido), c: "#171717", s: `${vista.length} inversión${vista.length === 1 ? "" : "es"}` },
          { t: "Valor actual", v: eur(totValor), c: "#171717", s: conValor.length < vista.length ? "Si no hay valor actual, cuenta lo invertido" : "Según el último valor apuntado" },
          { t: dif >= 0 ? "Ganancia" : "Pérdida", v: (dif >= 0 ? "+" : "−") + eur(Math.abs(dif)), c: dif > 0 ? "#047857" : dif < 0 ? "#B91C1C" : "#171717", s: totInvertido ? `${((dif / totInvertido) * 100).toFixed(1).replace(".", ",")} % sobre lo invertido` : "—" },
        ].map(k => (
          <div key={k.t} style={tarjeta}>
            <div style={{ fontSize: 11, color: "#6B665F", fontWeight: 600 }}>{k.t}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: k.c, fontFamily: fontTit, letterSpacing: "-0.5px", margin: "4px 0 2px" }}>{k.v}</div>
            <div style={{ fontSize: 10.5, color: "#7F7973" }}>{k.s}</div>
          </div>
        ))}
      </div>

      {/* Filtros + añadir */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button style={pildora(filtro === "todas")} onClick={() => setFiltro("todas")}>Todas</button>
          {TIPOS_INVERSION.map(t => (
            <button key={t.id} style={pildora(filtro === t.id)} onClick={() => setFiltro(t.id)}>{t.icono} {t.label}</button>
          ))}
        </div>
        {gestiona && !form && <button style={btnNegro} onClick={() => setForm({ ...VACIA, tipo: filtro !== "todas" ? filtro : "equipo" })}>+ Añadir inversión</button>}
      </div>

      {/* Formulario */}
      {form && (
        <form onSubmit={guardar} style={{ ...tarjeta, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, fontFamily: fontTit, marginBottom: 12 }}>{form.id ? "Editar inversión" : "Nueva inversión"}</div>
          <div className="blesk-grid-2" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10, marginBottom: 10 }}>
            <div><div style={lbl}>¿Qué es?</div><input style={inp} value={form.concepto} onChange={e => set("concepto", e.target.value)} placeholder="Ej.: Cortadora láser, dominio web, depósito a 6 meses…" autoFocus/></div>
            <div><div style={lbl}>Tipo</div>
              <select style={inp} value={form.tipo} onChange={e => set("tipo", e.target.value)}>
                {TIPOS_INVERSION.map(t => <option key={t.id} value={t.id}>{t.icono} {t.label}</option>)}
              </select>
            </div>
          </div>
          <div className="blesk-grid-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div><div style={lbl}>Fecha</div><input type="date" style={inp} value={form.fecha} onChange={e => set("fecha", e.target.value)}/></div>
            <div><div style={lbl}>Invertido (€)</div><input style={inp} inputMode="decimal" value={form.importe} onChange={e => set("importe", e.target.value)} placeholder="0,00"/></div>
            <div><div style={lbl}>Valor actual (€) · opcional</div><input style={inp} inputMode="decimal" value={form.valor_actual ?? ""} onChange={e => set("valor_actual", e.target.value)} placeholder="Lo que vale hoy"/></div>
          </div>
          <div className="blesk-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div><div style={lbl}>Proyecto · opcional</div>
              <select style={inp} value={form.proyecto || ""} onChange={e => set("proyecto", e.target.value)}>
                <option value="">— Toda la empresa —</option>
                {(projects || []).map(p => <option key={p.id ?? p.name} value={p.name}>{p.name}</option>)}
              </select>
            </div>
            <div><div style={lbl}>{form.tipo === "socio" ? "¿Quién lo aporta?" : "¿Quién lo pagó / gestiona? · opcional"}</div>
              <select style={inp} value={form.persona || ""} onChange={e => set("persona", e.target.value)}>
                <option value="">— KEIA —</option>
                {(miembros || []).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 14 }}><div style={lbl}>Notas · opcional</div>
            <textarea style={{ ...inp, minHeight: 60, resize: "vertical" }} value={form.notas || ""} onChange={e => set("notas", e.target.value)} placeholder="Dónde está, condiciones, vencimiento…"/>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" style={btnBlanco} onClick={() => setForm(null)}>Cancelar</button>
            <button style={{ ...btnNegro, opacity: guardando ? .6 : 1 }} disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</button>
          </div>
        </form>
      )}

      {/* Lista */}
      {error && <div style={{ ...tarjeta, color: "#B91C1C", fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
      {cargando ? (
        <div style={{ ...tarjeta, textAlign: "center", fontSize: 12.5, color: "#7F7973" }}>Cargando…</div>
      ) : vista.length === 0 ? (
        <div style={{ ...tarjeta, textAlign: "center", fontSize: 12.5, color: "#7F7973", fontStyle: "italic", padding: "22px 18px" }}>
          Todavía no hay inversiones{filtro !== "todas" ? " de este tipo" : ""}.{gestiona ? " Pulsa “Añadir inversión” para apuntar la primera." : ""}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {vista.map(r => {
            const t = tipoDe(r.tipo);
            const va = r.valor_actual !== null && r.valor_actual !== undefined ? Number(r.valor_actual) : null;
            const d = va !== null ? va - Number(r.importe) : null;
            return (
              <div key={r.id} style={{ ...tarjeta, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: "#F2F0ED", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{t.icono}</div>
                <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#171717" }}>{r.concepto}</div>
                  <div style={{ fontSize: 11, color: "#7F7973", marginTop: 2 }}>
                    {t.label} · {fechaTxt(r.fecha)}{r.proyecto ? ` · ${r.proyecto}` : ""}{r.persona ? ` · ${r.persona}` : ""}
                  </div>
                  {r.notas && <div style={{ fontSize: 11.5, color: "#57534E", marginTop: 4 }}>{r.notas}</div>}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: fontTit, color: "#171717" }}>{eur(Number(r.importe))}</div>
                  {va !== null ? (
                    <div style={{ fontSize: 11, color: d > 0 ? "#047857" : d < 0 ? "#B91C1C" : "#7F7973" }}>
                      Vale {eur(va)} ({d >= 0 ? "+" : "−"}{eur(Math.abs(d))})
                    </div>
                  ) : <div style={{ fontSize: 11, color: "#A19B93" }}>Sin valor actual</div>}
                </div>
                {gestiona && (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button title="Editar" onClick={() => { setForm({ ...VACIA, ...r, importe: String(r.importe ?? ""), valor_actual: r.valor_actual ?? "", notas: r.notas || "" }); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                      style={{ ...btnBlanco, padding: "6px 12px", fontSize: 12 }}>Editar</button>
                    <button title="Borrar" onClick={() => borrar(r)} style={{ ...btnBlanco, padding: "6px 12px", fontSize: 12, color: "#B91C1C" }}>Borrar</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

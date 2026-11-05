import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { EMPRESA, EMPRESA_SUB, MIEMBROS, MIEMBROS_ANTIGUOS, EXTERNOS, PROYECTOS_INICIALES, CLAVE_EDICION, CLAVE_CHAT_PRIVADO } from "./config.js";
import { sb } from "./supabase.js";
import { perfil, puedoEditar, puedoGestionar } from "./perfil.js";

// ── Clockify ──────────────────────────────────────────────────────────────────
const CLOCKIFY_KEY = ""; // la clave de Clockify va en la variable CLOCKIFY_KEY de Vercel (api/clockify.js)
const CLOCKIFY_WS  = import.meta.env.VITE_CLOCKIFY_WS || "";
const CLOCKIFY_HEADERS = {"X-Api-Key": CLOCKIFY_KEY};

const CLOCKIFY_PROXY = "/api/clockify";
// Clockify ya no se usa: los proyectos se gestionan en el dashboard y las horas en ⏱ Horas.
// (La API solo se usa para traer las horas antiguas desde ⏱ Horas → "Traer de Clockify".)
const USAR_CLOCKIFY = false;

// Returns signed base — FRC can be positive or negative
function signedBase(r){ const b=parseFloat(r.base)||0; const sign=r.frcSign||r.frc_sign||"+"; return (r.ref||"").startsWith("FRC")&&sign==="-"?-b:b; }
// Parte de un miembro en una factura, con signo (FRC "−" resta)
function repImporte(r, member){ const rep=r.reparto?.find(x=>x.member===member); const v=Math.abs(parseFloat(rep?.importe)||0); return signedBase(r)<0?-v:v; }
function isFRCNeg(r){ return (r.ref||"").startsWith("FRC")&&(r.frcSign||r.frc_sign||"+")==="-"; }
// Año y mes de una fecha "D/M/AAAA", "DD/MM/AA" o "AAAA-MM-DD" → {y,m} (m de 1 a 12) o null
function fechaYM(f){
  if(!f) return null;
  const s=String(f).trim();
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m) return {y:+m[1],m:+m[2]};
  m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if(m) return {y:m[3].length===2?2000+(+m[3]):+m[3],m:+m[2]};
  return null;
}
// Reparto de una hoja de gasto por proyecto → [{proyecto,importe}]
function hojaPorProyecto(r){
  const prows=r.proyectos&&r.proyectos.length>0?r.proyectos:[{proyecto:r.proyecto||"",importe:r.importe_proyecto||r.importe||""}];
  return prows.map(p=>({proyecto:p.proyecto||"",importe:parseFloat(p.importe)||0}));
}
// ── OTROS GASTOS (movimientos del banco sin factura) ──
const OTROS_CATS = [
  {id:"comision",  label:"Comisiones bancarias"},
  {id:"impuestos", label:"Impuestos y tasas"},
  {id:"hacienda",  label:"Pago a Hacienda (IVA / sociedades)", excluye:true},
  {id:"personal",  label:"Personal / Seg. Social"},
  {id:"servicios", label:"Suscripciones y servicios"},
  {id:"otros",     label:"Otros"},
  {id:"traspaso",  label:"Traspaso / no computa", excluye:true},
  {id:"yacontado", label:"Cobro/pago de factura ya contada", excluye:true},
];
// Pagos a Hacienda que NO son gasto: liquidaciones de IVA (Diputación Foral / AEAT) e impuesto de sociedades
const RE_HACIENDA=/hacienda|aeat|diputaci[oó]n foral|impto\.?\s*sociedades|impuesto (de |sobre )?sociedades|\biva\b|modelo\s*\d/i;
const RE_SOCIEDADES=/sociedades|modelo\s*20[02]\b/i;
function otroCatDefault(m){
  const t=`${m.concepto||""} ${m.nota||""}`.toLowerCase();
  if(RE_HACIENDA.test(t)) return "hacienda";
  if(/comisi|mantenimiento|cuota tarjeta/.test(t)) return "comision";
  if(/hacienda|aeat|impuesto|tasa|iva\b|modelo \d/.test(t)) return "impuestos";
  if(/n[oó]mina|seguridad social|tgss/.test(t)) return "personal";
  return "otros";
}
// Lista de otros gastos/ingresos a partir de los movimientos del banco marcados como "otro"
// + la parte de un movimiento justificada sin factura (m.just = {importe, nota, categoria, proyecto, persona}),
//   que lleva id "<idMovimiento>#just"
// Lo que creó el cuadre del banco no es "otros": va a la partida de la cuenta de resultados que toca
// (entrada → facturas emitidas; salida → hojas de gastos si el movimiento es de hojas, si no facturas recibidas)
function partidaCuadre(m,importe,nota){
  if(!/\(cuadre \d/.test(nota||"")) return null;
  if(importe>0) return "emitidas";
  const ks=Array.isArray(m.matches)?m.matches:[];
  const hojas=ks.filter(k=>String(k).startsWith("hoja:")).length, facts=ks.filter(k=>String(k).startsWith("gas:")).length;
  return (hojas>facts||/^\s*hg\b/i.test(m.concepto||""))?"hojas":"recibidas";
}
function otrosDeBanco(movs){
  const completos=(movs||[]).filter(m=>!!m.otro||m.match==="otro").map(m=>{
    let categoria=m.categoria||otroCatDefault(m);
    if(categoria==="impuestos"&&!m.catManual&&RE_HACIENDA.test(`${m.concepto||""} ${m.nota||""}`)) categoria="hacienda";
    return {...m,categoria,proyecto:m.proyecto||"",persona:m.persona||"",computa:!OTROS_CATS.find(c=>c.id===categoria)?.excluye,partida:m.partida||partidaCuadre(m,m.importe,m.nota)};
  });
  const partes=(movs||[]).filter(m=>m.just&&!(m.otro||m.match==="otro")).map(m=>{
    const j=m.just;
    let categoria=j.categoria||otroCatDefault({concepto:m.concepto,nota:j.nota});
    if(categoria==="impuestos"&&!j.catManual&&RE_HACIENDA.test(`${m.concepto||""} ${j.nota||""}`)) categoria="hacienda";
    return {id:`${m.id}#just`,fecha:m.fecha,concepto:m.concepto,importe:j.importe,nota:j.nota||"",categoria,proyecto:j.proyecto||"",persona:j.persona||"",
      computa:!OTROS_CATS.find(c=>c.id===categoria)?.excluye,parcial:true,importeMov:m.importe,partida:j.partida||partidaCuadre(m,j.importe,j.nota)};
  });
  return [...completos,...partes];
}
async function clockifyFetch(path){
  const res = await fetch(`${CLOCKIFY_PROXY}?path=${encodeURIComponent(path)}`);
  if(!res.ok) return null;
  return res.json();
}

async function fetchClockifyHours(projectId){
  // Use summary report endpoint — gives total duration per project
  const end = new Date().toISOString();
  const start = new Date(Date.now()-365*24*60*60*1000).toISOString();
  const path = `workspaces/${CLOCKIFY_WS}/reports/summary`;
  const res = await fetch(`/api/clockify?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      dateRangeStart: start,
      dateRangeEnd: end,
      summaryFilter: {groups:["PROJECT"]},
      projects: {ids:[projectId]}
    })
  });
  if(!res.ok) return 0;
  const data = await res.json();
  const totalSec = data?.totals?.[0]?.totalTime || 0;
  return totalSec / 3600;
}

async function fetchClockifyProjects(){
  const data = await clockifyFetch(`workspaces/${CLOCKIFY_WS}/projects?page-size=100`);
  return Array.isArray(data) ? data : [];
}

async function renameClockifyProject(projectId, newName){
  try{
    const path = "workspaces/"+CLOCKIFY_WS+"/projects/"+projectId;
    const res = await fetch(CLOCKIFY_PROXY+"?path="+encodeURIComponent(path), {
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({name: newName})
    });
    const data = await res.json();
    console.log("Clockify rename result:", data?.name||data);
    return data;
  }catch(e){ console.error("Clockify rename error",e); }
}

async function archiveClockifyProject(projectId){
  try{
    const pathA = "workspaces/"+CLOCKIFY_WS+"/projects/"+projectId;
    const res = await fetch(CLOCKIFY_PROXY+"?path="+encodeURIComponent(pathA), {
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({archived:true})
    });
    return await res.json();
  }catch(e){ console.error("Clockify archive error",e); return null; }
}

async function createClockifyProject(name){
  try{
    const path = "workspaces/"+CLOCKIFY_WS+"/projects";
    const res = await fetch(CLOCKIFY_PROXY+"?path="+encodeURIComponent(path), {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({name, isPublic:false, billable:true})
    });
    const data = await res.json();
    console.log("Clockify create result:", data?.name||data);
    return data;
  }catch(e){ console.error("Clockify create error",e); return null; }
}

async function fetchClockifyUsers(){
  const data = await clockifyFetch(`workspaces/${CLOCKIFY_WS}/users?page-size=100`);
  return Array.isArray(data) ? data : [];
}

async function fetchHoursPerUserPerProject(startDate, endDate){
  // Summary report grouped by USER + PROJECT
  const path = `workspaces/${CLOCKIFY_WS}/reports/summary`;
  const res = await fetch(`/api/clockify?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      dateRangeStart: startDate,
      dateRangeEnd: endDate,
      summaryFilter: { groups: ["USER","PROJECT"] },
    })
  });
  if(!res.ok) return [];
  const data = await res.json();
  return data?.groupOne || [];
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
// Convert flat DB rows → state shape { member: [rows] }
const parseDD = f => { if(!f) return 0; const [d,m,y]=f.split('/'); return new Date(y,m-1,d).getTime(); };
const toDateInput = f => { if(!f) return ""; const p=f.split('/'); return p.length===3?`${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`:""; };
const fromDateInput = v => { if(!v) return ""; const p=v.split('-'); return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:""; };
function rowsToByMember(rows){ return INIT_MEMBERS.reduce((a,m)=>({...a,[m.name]:rows.filter(r=>r.member===m.name).map(r=>({...r,id:r.id,companeros:typeof r.companeros==="string"?JSON.parse(r.companeros||"[]"):r.companeros||[],linkedFrom:r.linked_from||null,linkedOwner:r.linked_owner||null})).sort((a,b)=>parseDD(a.fecha)-parseDD(b.fecha))}),{}); }
// Convert flat DB rows → CRM shape { project: { g1:{name,rows}, g2:{name,rows} } }
function rowsToCRM(rows, projects){
  return projects.reduce((a,p)=>{
    const pr=rows.filter(r=>r.proyecto===p.name);
    const g1rows=pr.filter(r=>r.grupo_key==="g1");
    const g2rows=pr.filter(r=>r.grupo_key==="g2");
    const g1name=g1rows[0]?.grupo_name||"GRUPO 1";
    const g2name=g2rows[0]?.grupo_name||"GRUPO 2";
    return {...a,[p.name]:{g1:{name:g1name,rows:g1rows},g2:{name:g2name,rows:g2rows}}};
  },{});
}

// Modo oscuro: los colores muy oscuros (de miembros y proyectos) se aclaran para que se lean
function aClaro(hex){
  const h=String(hex||"").replace("#","").slice(0,6);
  if(!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  let [r,g,b]=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255);
  const L=0.2126*r+0.7152*g+0.0722*b;
  if(L>=0.28) return "#"+h;
  const t=Math.min(0.6,(0.36-L)/(1-L)+0.12);           // mezcla con blanco lo justo
  [r,g,b]=[r,g,b].map(c=>c+(1-c)*t);
  return "#"+[r,g,b].map(c=>Math.round(c*255).toString(16).padStart(2,"0")).join("").toUpperCase();
}
const conTinte=x=>({...x,color:aClaro(x.color),light:aClaro(x.color)+"24"});
const INIT_MEMBERS = MIEMBROS.map(conTinte);   // se edita en src/config.js

// Personas que ya no están: se ocultan en el panel de Inicio,
// pero siguen en INIT_MEMBERS para que sus facturas, repartos y datos cuadren (src/config.js)
const MIEMBROS_OCULTOS = MIEMBROS_ANTIGUOS;
const MIEMBROS_VISIBLES = INIT_MEMBERS.filter(m=>!MIEMBROS_OCULTOS.includes(m.name));

// Números de un miembro (misma fórmula que la pestaña Equipo)
function statsMiembro(name, {bp, cv, ing, gas, hojas, otros}){
  const mbp=(bp||{})[name]||[], mcv=(cv||{})[name]||[];
  const ming=(ing||[]).filter(r=>r.reparto?.some(x=>x.member===name&&parseFloat(x.importe)>0));
  const mgas=(gas||[]).filter(r=>r.reparto?.some(x=>x.member===name&&parseFloat(x.importe)>0));
  const pts=mbp.reduce((s,r)=>s+(parseFloat(r.puntos)||0),0);
  const cvCount=mcv.filter(r=>r.cat==="CV").length;
  const lvCount=mcv.filter(r=>r.cat==="LV").length;
  // Facturación = FC+FS+FRP+FRC (sin OI); OI cuenta para beneficio pero no facturación
  const totFact=ming.reduce((s,r)=>(r.ref||"").startsWith("OI")?s:s+repImporte(r,name),0);
  const totOI=ming.reduce((s,r)=>(r.ref||"").startsWith("OI")?s+repImporte(r,name):s,0);
  const totGasFacturas=mgas.reduce((s,r)=>s+repImporte(r,name),0);
  const totGasHojas=(hojas||[]).reduce((s,r)=>{
    if(r.reparto?.some(x=>parseFloat(x.importe)>0)) return s+repImporte(r,name);
    if(r.responsable===name) return s+(parseFloat(r.importe)||0);
    return s;
  },0);
  // Otros gastos / ingresos del banco asignados a esta persona (los traspasos no cuentan)
  const mOtros=(otros||[]).filter(o=>o.computa&&o.persona===name);
  const totOtrosGas=mOtros.filter(o=>o.importe<0).reduce((s,o)=>s-o.importe,0);
  const totOtrosIng=mOtros.filter(o=>o.importe>0).reduce((s,o)=>s+o.importe,0);
  const totGas=totGasFacturas+totGasHojas+totOtrosGas;
  return {pts,cvCount,lvCount,tot:cvCount+lvCount,totIng:totFact,totOI:totOI+totOtrosIng,totGas,neto:totFact+totOI+totOtrosIng-totGas};
}

const EXTERNAL_MEMBERS = EXTERNOS; // src/config.js
const EMPRESA_REPARTO = { name:"EMPRESA", color:"#D5D9E0", light:"#262B34" };

const INIT_PROJECTS = PROYECTOS_INICIALES; // src/config.js

const PROJ_PALETTE = [
  ["#323844","#262B34"],["#3A414D","#262B34"],["#48484A","#262B34"],
  ["#636366","#262B34"],["#8E8E93","#262B34"],["#2C2C2E","#262B34"],
  ["#D5D9E0","#262B34"],["#C3C8D0","#262B34"],["#48484A","#262B34"],
  ["#636366","#262B34"],
];

const TOPICS   = ["Individual learning","Team learning","Leadership","Finances","Innovation","Otros"];
const ESTADOS  = ["Contactado","Propuesta","CV cerrada","Venta cerrada","Volver a contactar","NO"];
const CC_OPTS  = ["✅ Aprobado","🔄 Revisión","❌ Rechazado","⏳ Pendiente"];

const EDIT_PASSWORD = CLAVE_EDICION; // src/config.js
const PENALTY_MSGS = [
  "🚨 SE TE HAN QUITADO -50€ DEL CONTADOR POR FALLAR 3 VECES",
  "💀 -50€ descontados de tu neto. Espero que haya merecido la pena intentarlo",
  "🤡 Tres intentos fallidos. Tómate un descanso y reflexiona sobre tus decisiones.",
  "😤 -50€. Directamente al fondo común por intentar hackear el sistema.",
];

function EditLockModal({onUnlock, onClose}){
  const [input, setInput] = useState("");
  const [tries, setTries] = useState(0);
  const [penalty, setPenalty] = useState(false);
  const [shake, setShake] = useState(false);

  function tryPassword(){
    if(input===EDIT_PASSWORD){ onUnlock(); return; }
    const newTries = tries+1;
    setTries(newTries);
    setInput("");
    setShake(true);
    setTimeout(()=>setShake(false),500);
    if(newTries>=3) setPenalty(true);
  }

  if(penalty) return(
    <div style={{position:"fixed",inset:0,background:"#000C",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#323844",borderRadius:16,padding:32,maxWidth:380,width:"95%",textAlign:"center",boxShadow:"0 20px 60px #000"}}>
        <div style={{fontSize:48,marginBottom:16}}>🚨</div>
        <div style={{color:"#FFF",fontWeight:700,fontSize:16,marginBottom:8,letterSpacing:"-0.3px"}}>
          {PENALTY_MSGS[Math.floor(Math.random()*PENALTY_MSGS.length)]}
        </div>
        <div style={{color:"#9AA1AC",fontSize:11,marginBottom:24}}>Siguiente intento disponible cuando te lo merezcas.</div>
        <button onClick={onClose} style={{background:"#15181D",color:"#D5D9E0",border:"none",borderRadius:8,padding:"10px 24px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
          Entendido 😔
        </button>
      </div>
    </div>
  );

  return(
    <div style={{position:"fixed",inset:0,background:"#0008",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#1F232B",borderRadius:14,padding:28,maxWidth:340,width:"95%",boxShadow:"0 8px 24px rgba(0,0,0,0.12)",textAlign:"center",
        animation:shake?"shake 0.4s":"none",
      }}>
        <style>{`@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}`}</style>
        <div style={{fontSize:32,marginBottom:12}}>🔒</div>
        <div style={{fontWeight:700,fontSize:14,color:"#ECEEF2",marginBottom:4}}>Modo edición</div>
        <div style={{fontSize:11,color:"#9AA1AC",marginBottom:20}}>Introduce la contraseña para editar{tries>0?` (${3-tries} intentos restantes)`:""}</div>
        <input
          type="password" value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&tryPassword()}
          placeholder="••••"
          autoFocus
          style={{width:"100%",border:`2px solid ${tries>0?"#DC2626":"#2E343E"}`,borderRadius:8,padding:"10px 14px",fontSize:16,textAlign:"center",fontFamily:"inherit",letterSpacing:4,outline:"none",marginBottom:12,boxSizing:"border-box"}}
        />
        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{flex:1,background:"#15181D",color:"#D5D9E0",border:"1px solid #2E343E",borderRadius:8,padding:"9px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
          <button onClick={tryPassword} style={{flex:1,background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Entrar</button>
        </div>
      </div>
    </div>
  );
}

const ESTADO_COLORS = {
  "Contactado":         {bg:"#112845",text:"#D5D9E0"},
  "Propuesta":          {bg:"#454111",text:"#EFA880"},
  "CV cerrada":         {bg:"#452F11",text:"#ED9D82"},
  "Venta cerrada":      {bg:"#11452B",text:"#8CE3AF"},
  "Volver a contactar": {bg:"#451111",text:"#E48B8B"},
  "NO":                 {bg:"#451111",text:"#E48B8B"},
};
const CC_COLORS = {
  "✅ Aprobado":  {bg:"#11452B",text:"#8CE3AF"},
  "🔄 Revisión":  {bg:"#454111",text:"#EFA880"},
  "❌ Rechazado": {bg:"#451111",text:"#E48B8B"},
  "⏳ Pendiente": {bg:"#453B11",text:"#F3A97D"},
};

const META_BP = 80;
const META_CV = 100;

const initByMember = (members) => members.reduce((a,m)=>({...a,[m.name]:[]}),{});
// CRM state: per project, per group: { rows: [], name: "GRUPO 1" }
const initCRM = (projects) => projects.reduce((a,p)=>({
  ...a,
  [p.name]:{ g1:{name:"GRUPO 1",rows:[]}, g2:{name:"GRUPO 2",rows:[]} }
}),{});

// ── Micro UI ──────────────────────────────────────────────────────────────────
function Badge({label,colors}){
  if(!label)return null;
  return <span style={{background:colors?.bg||"#262B34",color:colors?.text||"#C3C8D0",padding:"2px 8px",borderRadius:99,fontSize:10,fontWeight:500,whiteSpace:"nowrap"}}>{label}</span>;
}
function Inp({value,onChange,placeholder,w,bold,color}){
  return <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
    style={{border:"1px solid #2E343E",borderRadius:5,padding:"3px 6px",fontSize:11,fontFamily:"inherit",
    width:w||"100%",background:"#232831",outline:"none",color:color||"#D5D9E0",fontWeight:bold?"600":"400",minWidth:0}}
    onFocus={e=>e.target.style.borderColor="#E8501C"} onBlur={e=>e.target.style.borderColor="#2E343E"}/>;
}
function InpBlur({value,onChange,placeholder,w,bold,color,locked,onLock}){
  const [local,setLocal] = useState(value);
  const focused = useRef(false);
  const dirty = useRef(false);
  useEffect(()=>{ if(!focused.current) setLocal(value); },[value]);
  function handleChange(e){
    if(locked){
      // Revertir al valor original y abrir modal
      setLocal(value);
      e.target.blur();
      if(onLock) onLock();
      return;
    }
    dirty.current=true;
    setLocal(e.target.value);
  }
  function handleBlur(e){
    focused.current=false;
    e.target.style.borderColor="#2E343E";
    if(dirty.current&&!locked){ onChange(e.target.value); dirty.current=false; }
    else if(locked){ setLocal(value); }
  }
  return <input value={local}
    onChange={handleChange}
    onFocus={e=>{ focused.current=true; dirty.current=false; e.target.style.borderColor="#E8501C"; }}
    onBlur={handleBlur}
    placeholder={placeholder}
    style={{border:"1px solid #2E343E",borderRadius:5,padding:"3px 6px",fontSize:11,fontFamily:"inherit",
    width:w||"100%",background:"#232831",outline:"none",color:color||"#D5D9E0",fontWeight:bold?"600":"400",minWidth:0}}/>;
}
function DateInp({value,onChange,w,locked,onLock}){
  // value es DD/MM/YYYY, input type=date usa YYYY-MM-DD.
  // Estado local: mientras se teclea el año (0002, 0020, 0202...) no se propaga
  // ni se re-renderiza el valor del padre; solo se guarda cuando la fecha es completa y válida.
  const [local,setLocal]=useState(toDateInput(value||""));
  const focused=useRef(false);
  useEffect(()=>{ if(!focused.current) setLocal(toDateInput(value||"")); },[value]);
  const validYear = v => { const y=parseInt((v||"").split("-")[0],10); return y>=1900 && y<=2100; };
  function commit(v){
    if(v===""){ if(toDateInput(value||"")!=="") onChange(""); return; }
    if(validYear(v) && v!==toDateInput(value||"")) onChange(fromDateInput(v));
  }
  function handleChange(e){
    if(locked){ if(onLock) onLock(); return; }
    const v=e.target.value;
    setLocal(v);
    // Año completo (4 dígitos, ≥1900) → guardar ya (p.ej. al elegir del calendario)
    if(v!=="" && validYear(v) && (v.split("-")[0]||"").length===4) commit(v);
  }
  function handleBlur(e){
    focused.current=false;
    e.target.style.borderColor="#2E343E";
    if(locked) return;
    if(local===""||validYear(local)) commit(local);
    else setLocal(toDateInput(value||"")); // año incompleto/inválido → vuelve al valor anterior
  }
  return <input type="date" value={local} onChange={handleChange}
    min="1900-01-01" max="2100-12-31"
    onKeyDown={e=>{ if(e.key==="Enter") e.target.blur(); }}
    style={{border:"1px solid #2E343E",borderRadius:5,padding:"4px 8px",fontSize:12,fontFamily:"inherit",
    width:w||"130px",minWidth:"130px",background:"#232831",outline:"none",color:"#D5D9E0",cursor:"pointer",colorScheme:"dark"}}
    onFocus={e=>{ focused.current=true; e.target.style.borderColor="#E8501C"; }} onBlur={handleBlur}/>;
}
function LinkInp({value,onChange,placeholder}){
  return(
    <div style={{display:"flex",alignItems:"center",gap:3}}>
      <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder||"https://..."}
        style={{border:"1px solid #2E343E",borderRadius:5,padding:"4px 7px",fontSize:11,fontFamily:"inherit",
        width:"100%",background:"#232831",outline:"none",color:"#E8501C",minWidth:0}}
        onFocus={e=>e.target.style.borderColor="#E8501C"} onBlur={e=>e.target.style.borderColor="#2E343E"}/>
      {value&&<a href={value} target="_blank" rel="noreferrer" style={{color:"#E8501C",fontSize:13,lineHeight:1,flexShrink:0}} title="Abrir link">↗</a>}
    </div>
  );
}
async function uploadFacturaPdf(file){
  const safe=(file.name||"factura.pdf").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^\w.\-]+/g,"_");
  const path=`facturas/${Date.now()}_${safe}`;
  const {error}=await sb.storage.from("hoja_gasto").upload(path,file,{contentType:file.type||"application/pdf"});
  if(error) throw error;
  return sb.storage.from("hoja_gasto").getPublicUrl(path).data.publicUrl;
}
function PdfCell({value,onChange,locked,onLock}){
  const [subiendo,setSubiendo]=useState(false);
  const ref=useRef(null);
  function pick(){ if(locked){ onLock&&onLock(); return; } ref.current?.click(); }
  async function onFile(e){
    const file=e.target.files?.[0]; e.target.value="";
    if(!file) return;
    if(file.type!=="application/pdf"&&!/\.pdf$/i.test(file.name)){ alert("La factura tiene que ser un PDF"); return; }
    setSubiendo(true);
    try{ onChange(await uploadFacturaPdf(file)); }
    catch(err){ console.error(err); alert("Error subiendo el PDF: "+err.message); }
    setSubiendo(false);
  }
  return(
    <div style={{display:"flex",alignItems:"center",gap:4,whiteSpace:"nowrap"}}>
      <input ref={ref} type="file" accept="application/pdf,.pdf" style={{display:"none"}} onChange={onFile}/>
      {value?(<>
        <a href={value} target="_blank" rel="noreferrer" style={{background:"#452311",color:"#4F46E5",borderRadius:6,padding:"3px 8px",fontSize:10,fontWeight:700,textDecoration:"none"}} title="Abrir PDF">📄 PDF ↗</a>
        <button onClick={pick} disabled={subiendo} title="Reemplazar PDF" style={{background:"none",border:"none",color:"#7F8692",cursor:"pointer",fontSize:11,padding:0,fontFamily:"inherit"}}>{subiendo?"…":"↻"}</button>
      </>):(
        <button onClick={pick} disabled={subiendo} style={{background:"#451111",color:"#EC8383",border:"1px solid #FCA5A5",borderRadius:6,padding:"3px 8px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
          {subiendo?"Subiendo…":"⚠️ Subir PDF"}
        </button>
      )}
    </div>
  );
}
function Sel({value,onChange,options,placeholder}){
  return <select value={value} onChange={e=>onChange(e.target.value)}
    style={{border:"1px solid #2E343E",borderRadius:5,padding:"4px 7px",fontSize:11,fontFamily:"inherit",
    background:"#232831",outline:"none",color:value?"#D5D9E0":"#7F8692",cursor:"pointer"}}>
    <option value="">{placeholder||"—"}</option>
    {options.map(o=><option key={o} value={o}>{o}</option>)}
  </select>;
}
function AddBtn({onClick,label="+ Añadir"}){
  const [h,setH]=useState(false);
  return <button onClick={onClick} onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)}
    style={{background:"transparent",border:`1.5px dashed ${h?"#E8501C":"#3A414D"}`,
    color:h?"#E8501C":"#7F8692",borderRadius:7,padding:"5px 14px",fontSize:11,
    cursor:"pointer",fontFamily:"inherit",transition:"all .15s"}}>{label}</button>;
}
function ConfirmDeleteModal({onConfirm, onCancel}){
  return(
    <div style={{position:"fixed",inset:0,background:"#0006",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}
      onClick={onCancel}>
      <div style={{background:"#1F232B",borderRadius:12,padding:"22px 28px",boxShadow:"0 8px 32px #0003",textAlign:"center",minWidth:240}}
        onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:24,marginBottom:8}}>🗑️</div>
        <div style={{fontWeight:700,fontSize:13,marginBottom:6,color:"#ECEEF2"}}>¿Borrar esta fila?</div>
        <div style={{fontSize:11,color:"#9AA1AC",marginBottom:18}}>Esta acción no se puede deshacer</div>
        <div style={{display:"flex",gap:8,justifyContent:"center"}}>
          <button onClick={onCancel}
            style={{background:"#262B34",color:"#B4BAC4",border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            Cancelar
          </button>
          <button onClick={onConfirm}
            style={{background:"#EF4444",color:"#FFF",border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            Sí, borrar
          </button>
        </div>
      </div>
    </div>
  );
}
function DelBtn({onClick}){
  const [open,setOpen]=useState(false);
  return(
    <>
      {open&&<ConfirmDeleteModal onConfirm={()=>{setOpen(false);onClick();}} onCancel={()=>setOpen(false)}/>}
      <button onClick={()=>setOpen(true)}
        style={{background:"transparent",border:"none",color:"#5C6370",cursor:"pointer",fontSize:13,padding:"0 3px",lineHeight:1}}>✕</button>
    </>
  );
}
function THead({cols,color}){
  return <thead><tr>{cols.map(c=><th key={c} style={{padding:"5px 8px",background:color,color:"#FFF",fontWeight:500,fontSize:10,textAlign:"left",whiteSpace:"nowrap",letterSpacing:"0.3px"}}>{c}</th>)}</tr></thead>;
}
function ProgressBar({val,max,color}){
  const pct=Math.min(Math.round(val/max*100),100);
  const c=val>=max?"#22C55E":val>=max*0.5?color||"#F59E0B":"#969CA6";
  return(
    <div>
      <div style={{background:"#2E343E",borderRadius:99,height:7,overflow:"hidden"}}>
        <div style={{width:`${pct}%`,height:"100%",background:c,borderRadius:99,transition:"width .4s"}}/>
      </div>
      <div style={{fontSize:9,color:"#7F8692",marginTop:2}}>{val}/{max} · {pct}%</div>
    </div>
  );
}
function Block({name,color,light,badge,children,defaultOpen=false}){
  const [open,setOpen]=useState(defaultOpen);
  return(
    <div style={{marginBottom:6,borderRadius:12,overflow:"hidden"}}>
      <button onClick={()=>setOpen(o=>!o)} style={{width:"100%",background:color,border:"none",padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",fontFamily:"inherit"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{color:"#FFF",fontWeight:700,fontSize:14,letterSpacing:"-0.2px"}}>{name}</span>
          {badge&&<span style={{background:"#FFFFFF22",color:"#FFF",fontSize:10,padding:"2px 9px",borderRadius:99,fontWeight:500}}>{badge}</span>}
        </div>
        <span style={{color:"#FFFFFF88",fontSize:9,transform:open?"rotate(180deg)":"rotate(0)",transition:"transform .2s",display:"inline-block"}}>▼</span>
      </button>
      {open&&<div style={{background:color+"12",padding:"12px 14px",borderTop:`2px solid ${color}`}}>{children}</div>}
    </div>
  );
}

// ── PROYECTOS TAB ─────────────────────────────────────────────────────────────
function ProjectModal({p, pCVs, pIng, pGas, pHojas, totIng, totGas, sortRef, onClose, pCRM}){
  const [innerTab, setInnerTab] = useState("facturas");
  const neto = totIng - totGas;
  return(
    <div style={{position:"fixed",inset:0,background:"#0007",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#1F232B",borderRadius:16,width:"min(860px,95vw)",maxHeight:"88vh",display:"flex",flexDirection:"column",boxShadow:"0 16px 40px rgba(0,0,0,0.14)"}}>
        {/* Header */}
        <div style={{background:p.color,padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",borderRadius:"16px 16px 0 0",flexShrink:0}}>
          <div>
            <div style={{color:"#FFF",fontWeight:700,fontSize:17,letterSpacing:"-0.4px"}}>{p.name}</div>
            <div style={{color:"#FFFFFF77",fontSize:10,marginTop:1}}>Ficha de proyecto</div>
          </div>
          <button onClick={onClose} style={{background:"#FFFFFF22",border:"none",color:"#FFF",borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✕ Cerrar</button>
        </div>

        {/* KPIs */}
        <div style={{padding:"16px 24px 0",flexShrink:0}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:16}}>
            {[
              {label:"CV",        val:pCVs.filter(r=>r.cat==="CV").length},
              {label:"LV",        val:pCVs.filter(r=>r.cat==="LV").length},
              {label:"Ingresos",  val:`${totIng.toFixed(0)}€`},
              {label:"Gastos",    val:`${totGas.toFixed(0)}€`},
              {label:"Neto",      val:`${neto.toFixed(0)}€`},
            ].map(k=>(
              <div key={k.label} style={{background:"#15181D",borderRadius:9,padding:"9px 12px",border:"1px solid #2E343E",textAlign:"center"}}>
                <div style={{fontSize:9,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:3}}>{k.label}</div>
                <div style={{fontSize:15,fontWeight:700,color:"#ECEEF2"}}>{k.val}</div>
              </div>
            ))}
          </div>

          {/* Inner tabs */}
          <div style={{display:"flex",gap:0,borderBottom:"1px solid #2E343E"}}>
            {[
              {id:"facturas", label:`💰 Facturas (${pIng.length+pGas.length})`},
              {id:"cv",       label:`🤝 CV / LV (${pCVs.length})`},
              {id:"crm",      label:`📊 CRM (${pCRM?.length||0})`},
              {id:"equipo",   label:`👥 Equipo`},
            ].map(t=>(
              <button key={t.id} onClick={()=>setInnerTab(t.id)} style={{
                background:"transparent",color:innerTab===t.id?"#D5D9E0":"#9AA1AC",
                border:"none",borderBottom:innerTab===t.id?"2px solid #1C1C1E":"2px solid transparent",
                padding:"8px 16px",fontSize:11,fontWeight:innerTab===t.id?700:400,
                cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",
              }}>{t.label}</button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div style={{overflowY:"auto",padding:"16px 24px 24px",flex:1}}>
          {innerTab==="facturas"&&(
            <>
              {/* Ingresos */}
              {pIng.length>0&&(
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",letterSpacing:"0.3px",marginBottom:8}}>Facturas emitidas · {totIng.toFixed(0)}€</div>
                  <div style={{background:"#15181D",borderRadius:10,overflow:"hidden"}}>
                    {sortRef(pIng).map((r,i)=>(
                      <div key={r.id} style={{display:"flex",gap:12,padding:"8px 14px",borderBottom:i<pIng.length-1?"1px solid #636336":"none",fontSize:11,alignItems:"center"}}>
                        <span style={{color:"#9AA1AC",width:90,flexShrink:0}}>{r.ref||"—"}</span>
                        <span style={{color:"#9AA1AC",width:70,flexShrink:0}}>{r.fecha||"—"}</span>
                        <span style={{flex:1,color:"#D5D9E0"}}>{r.descripcion||"—"}</span>
                        <span style={{fontWeight:700,color:"#ECEEF2",whiteSpace:"nowrap"}}>{parseFloat(r.base||0).toFixed(0)}€</span>
                      </div>
                    ))}
                    <div style={{display:"flex",justifyContent:"flex-end",padding:"8px 14px",fontWeight:700,fontSize:11,color:"#D5D9E0",borderTop:"1px solid #2E343E"}}>
                      Total: {totIng.toFixed(2)}€
                    </div>
                  </div>
                </div>
              )}
              {/* Gastos */}
              {(pGas.length>0||pHojas.length>0)&&(
                <div>
                  <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",letterSpacing:"0.3px",marginBottom:8}}>Gastos · {totGas.toFixed(0)}€</div>
                  <div style={{background:"#15181D",borderRadius:10,overflow:"hidden"}}>
                    {sortRef(pGas).map((r,i)=>(
                      <div key={r.id} style={{display:"flex",gap:12,padding:"8px 14px",borderBottom:"1px solid #636336",fontSize:11,alignItems:"center"}}>
                        <span style={{color:"#9AA1AC",width:90,flexShrink:0}}>{r.ref||"—"}</span>
                        <span style={{color:"#9AA1AC",width:70,flexShrink:0}}>{r.fecha||"—"}</span>
                        <span style={{flex:1,color:"#D5D9E0"}}>{r.descripcion||"—"}</span>
                        <span style={{fontWeight:700,color:"#EB8484",whiteSpace:"nowrap"}}>{parseFloat(r.base||0).toFixed(0)}€</span>
                      </div>
                    ))}
                    {pHojas.map((r,i)=>(
                      <div key={r.id} style={{display:"flex",gap:12,padding:"8px 14px",borderBottom:i<pHojas.length-1?"1px solid #636336":"none",fontSize:11,alignItems:"center"}}>
                        <span style={{color:"#9AA1AC",width:90,flexShrink:0}}>HG</span>
                        <span style={{color:"#9AA1AC",width:70,flexShrink:0}}>{r.fecha||"—"}</span>
                        <span style={{flex:1,color:"#D5D9E0"}}>{r.concepto||"—"} · {r.responsable}</span>
                        <span style={{fontWeight:700,color:"#EB8484",whiteSpace:"nowrap"}}>{parseFloat(r.importe||0).toFixed(0)}€</span>
                      </div>
                    ))}
                    <div style={{display:"flex",justifyContent:"flex-end",padding:"8px 14px",fontWeight:700,fontSize:11,color:"#EB8484",borderTop:"1px solid #2E343E"}}>
                      Total: {totGas.toFixed(2)}€
                    </div>
                  </div>
                </div>
              )}
              {pIng.length===0&&pGas.length===0&&pHojas.length===0&&(
                <div style={{textAlign:"center",padding:40,color:"#9AA1AC",fontSize:12}}>Sin facturas en este proyecto</div>
              )}
            </>
          )}

          {innerTab==="cv"&&(
            <>
              {pCVs.length>0?(
                <div style={{background:"#15181D",borderRadius:10,overflow:"hidden"}}>
                  {pCVs.map((r,i)=>(
                    <div key={r.id} style={{display:"flex",gap:12,padding:"9px 14px",borderBottom:i<pCVs.length-1?"1px solid #636336":"none",fontSize:11,alignItems:"center"}}>
                      <span style={{color:"#9AA1AC",width:70,flexShrink:0}}>{r.fecha||"—"}</span>
                      <span style={{fontWeight:600,color:"#ECEEF2",flex:1}}>{r.cliente||"—"}</span>
                      <span style={{background:"#2E343E",color:"#C3C8D0",fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:99}}>{r.cat}</span>
                      <span style={{color:"#9AA1AC",fontSize:10}}>{r.member}</span>
                    </div>
                  ))}
                </div>
              ):(
                <div style={{textAlign:"center",padding:40,color:"#9AA1AC",fontSize:12}}>Sin CV/LV en este proyecto</div>
              )}
            </>
          )}
          {innerTab==="equipo"&&(
            <ProyectoEquipoTab pname={p.name} color={p.color}/>
          )}

          {innerTab==="crm"&&(
            <>
              {pCRM&&pCRM.length>0?(
                <div style={{background:"#15181D",borderRadius:10,overflow:"hidden"}}>
                  {pCRM.map((r,i)=>(
                    <div key={r.id} style={{display:"flex",gap:12,padding:"9px 14px",borderBottom:i<pCRM.length-1?"1px solid #636336":"none",fontSize:11,alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{fontWeight:600,color:"#ECEEF2",flex:1,minWidth:120}}>{r.cliente||"—"}</span>
                      <span style={{color:"#9AA1AC",width:80,flexShrink:0}}>{r.ubicacion||"—"}</span>
                      <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:99,background:
                        r.estado==="Venta cerrada"?"#11452B":r.estado==="NO"?"#451111":r.estado==="CV cerrada"?"#452311":"#15181D",
                        color:r.estado==="Venta cerrada"?"#059669":r.estado==="NO"?"#EC8383":r.estado==="CV cerrada"?"#948EE1":"#636366"
                      }}>{r.estado||"—"}</span>
                      {r.tlf&&<a href={`tel:${r.tlf}`} style={{color:"#9AA1AC",fontSize:10,textDecoration:"none"}}>{r.tlf}</a>}
                    </div>
                  ))}
                </div>
              ):(
                <div style={{textAlign:"center",padding:40,color:"#9AA1AC",fontSize:12}}>Sin contactos CRM en este proyecto</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ROLES POR PROYECTO ───────────────────────────────────────────────────────
const ROLES_PROYECTO = [
  "Participante","Líder de proyecto","Encargado de ventas","Encargado financiero",
  "Diseño / Comunicación","Desarrollo / Producto","Soporte operativo","Asesor externo",
];

function ProyectoEquipoTab({pname, color}){
  const [roles, setRoles] = useState({}); // {memberName: rol}
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(()=>{
    sb.from("proyecto_roles").select("*").eq("proyecto", pname)
      .then(({data})=>{
        if(data&&data.length){
          const m={};
          data.forEach(r=>{ m[r.miembro]=r.rol; });
          setRoles(m);
        }
        setLoading(false);
      });
  },[pname]);

  async function setRol(miembro, rol){
    setRoles(prev=>({...prev,[miembro]:rol}));
    setSaving(true);
    try {
      await sb.from("proyecto_roles").upsert({proyecto:pname, miembro, rol},{onConflict:"proyecto,miembro"});
    } catch(e){ console.error(e); }
    setSaving(false);
  }

  if(loading) return <div style={{padding:20,color:"#7F8692",fontSize:11}}>Cargando...</div>;

  const asignados = INIT_MEMBERS.filter(m=>roles[m.name]);
  const sinAsignar = INIT_MEMBERS.filter(m=>!roles[m.name]);

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:11,color:"#9AA1AC"}}>Asigna un rol a cada miembro del equipo en este proyecto</div>
        {saving&&<span style={{fontSize:10,color:"#F59E0B",fontWeight:600}}>💾 Guardando...</span>}
      </div>

      {/* Miembros asignados */}
      {asignados.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:10,fontWeight:700,color:"#C3C8D0",letterSpacing:"0",marginBottom:8}}>En el proyecto</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
            {asignados.map(m=>(
              <div key={m.name} style={{background:m.light||"#262B34",border:`1.5px solid ${m.color}44`,borderRadius:10,padding:"10px 12px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <div style={{width:28,height:28,borderRadius:99,background:m.color,color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{m.name[0]}</div>
                  <span style={{fontWeight:700,fontSize:12,color:m.color}}>{m.name}</span>
                </div>
                <select value={roles[m.name]||""} onChange={e=>setRol(m.name,e.target.value)}
                  style={{width:"100%",border:`1px solid ${m.color}44`,borderRadius:7,padding:"5px 8px",fontSize:11,fontFamily:"inherit",background:"#1F232B",color:m.color,fontWeight:600}}>
                  <option value="">— Sin rol —</option>
                  {ROLES_PROYECTO.map(r=><option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sin asignar */}
      {sinAsignar.length>0&&(
        <div>
          <div style={{fontSize:10,fontWeight:700,color:"#7F8692",letterSpacing:"0",marginBottom:8}}>Sin rol asignado</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
            {sinAsignar.map(m=>(
              <div key={m.name} style={{background:"#232831",border:"1px solid #2E343E",borderRadius:10,padding:"10px 12px",opacity:.7}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <div style={{width:28,height:28,borderRadius:99,background:"#969CA6",color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{m.name[0]}</div>
                  <span style={{fontWeight:600,fontSize:12,color:"#C3C8D0"}}>{m.name}</span>
                </div>
                <select value="" onChange={e=>setRol(m.name,e.target.value)}
                  style={{width:"100%",border:"1px solid #2E343E",borderRadius:7,padding:"5px 8px",fontSize:11,fontFamily:"inherit",background:"#1F232B",color:"#7F8692"}}>
                  <option value="">— Asignar rol —</option>
                  {ROLES_PROYECTO.map(r=><option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ESTRATEGIA PROYECTOS ─────────────────────────────────────────────────────
const ETIQUETAS_PROY = [
  {id:"investigacion", label:"🔬 Investigación", color:"#7C3AED", bg:"#1B1145"},
  {id:"por_arrancar",  label:"🚀 Por arrancar",  color:"#D97706", bg:"#453B11"},
  {id:"activo",        label:"✅ Activo",         color:"#059669", bg:"#11452B"},
  {id:"pausado",       label:"⏸ Pausado",         color:"#9AA1AC", bg:"#262B34"},
];

function getWeeksVerano(){
  const weeks=[]; let d=new Date(2026,5,15);
  const end=new Date(2026,8,7);
  while(d<=end){ weeks.push(d.toISOString().slice(0,10)); d=new Date(d); d.setDate(d.getDate()+7); }
  return weeks;
}
const SEMANAS_VERANO=getWeeksVerano();

function EstrategiaProyectosTab({projects,ing,cv,bp,hojas}){
  const [estrategia,setEstrategia]=useState(null);
  const [loading,setLoading]=useState(true);
  const [activos,setActivos]=useState(null);
  const [addModal,setAddModal]=useState(false);
  const [selected,setSelected]=useState(null);
  const [vistaTab,setVistaTab]=useState("estrategia");

  useEffect(()=>{
    async function load(){
      try{
        const [{data:de},{data:da}]=await Promise.all([
          sb.from("estrategia").select("*"),
          sb.from("estrategia_activos").select("proyecto"),
        ]);
        const m={};
        (de||[]).forEach(r=>{
          if(r.key.endsWith("_proy")){
            try{ m[r.key]=JSON.parse(r.val); }catch(e){ m[r.key]=r.val?[r.val]:[]; }
          } else { m[r.key]=r.val; }
        });
        setEstrategia(m);
        if(da&&da.length) setActivos(da.map(r=>r.proyecto));
        else{
          const defaults=projects.slice(0,4).map(p=>p.name); setActivos(defaults);
          for(const pn of defaults){ try{ await sb.from("estrategia_activos").delete().eq("proyecto",pn); await sb.from("estrategia_activos").insert({proyecto:pn}); }catch(e){} }
        }
      }catch(e){ setEstrategia({}); setActivos(projects.slice(0,4).map(p=>p.name)); }
      setLoading(false);
    }
    load();
  },[]);

  function save(key,val){
    const stored = Array.isArray(val) ? JSON.stringify(val) : val;
    setEstrategia(prev=>({...prev,[key]:val}));
    sb.from("estrategia").upsert({key,val:stored},{onConflict:"key",ignoreDuplicates:false})
      .then(({error})=>{ if(error) console.error("estrategia save",key,error); })
      .catch(e=>console.error(e));
  }

  async function addProyecto(pn){
    if(!pn||activos.includes(pn)) return;
    setActivos(prev=>[...prev,pn]);
    try{ await sb.from("estrategia_activos").delete().eq("proyecto",pn); await sb.from("estrategia_activos").insert({proyecto:pn}); }catch(e){console.error(e);}
    setAddModal(false);
  }

  async function removeProyecto(pn){
    setActivos(prev=>prev.filter(p=>p!==pn));
    if(selected===pn) setSelected(null);
    try{ await sb.from("estrategia_activos").delete().eq("proyecto",pn); }catch(e){console.error(e);}
  }

  function inVerano(fecha){
    if(!fecha) return false;
    let yy,mm,dd;
    if(fecha.includes("/")){ [dd,mm,yy]=fecha.split("/"); }
    else if(fecha.includes("-")){ [yy,mm,dd]=fecha.split("-"); }
    else return false;
    const d=new Date(+yy,+mm-1,+dd);
    return d>=new Date(2026,5,15)&&d<=new Date(2026,8,7);
  }

  function getWeekKey(fecha){
    if(!fecha) return null;
    let d;
    if(fecha.includes("/")){ const[dd,mm,yy]=fecha.split("/"); d=new Date(yy,mm-1,dd); }
    else d=new Date(fecha);
    if(isNaN(d)) return null;
    const mon=new Date(d); mon.setDate(d.getDate()-(d.getDay()===0?6:d.getDay()-1));
    return mon.toISOString().slice(0,10);
  }

  if(loading||!activos||!estrategia) return <div style={{padding:40,textAlign:"center",color:"#7F8692"}}>Cargando...</div>;

  const disponibles=projects.filter(p=>!activos.includes(p.name));

  // ── VISTA VERANO ────────────────────────────────────────────────────────────
  function renderVerano(){
    return(
      <div>
        <div style={{marginBottom:16}}>
          <div style={{fontWeight:700,fontSize:14,color:"#ECEEF2"}}>☀️ Planificación verano 2026</div>
          <div style={{fontSize:11,color:"#9AA1AC",marginTop:2}}>Del <b>15 junio</b> al <b>7 septiembre</b></div>
        </div>
        <div style={{marginBottom:20}}>
          <div style={{fontWeight:600,fontSize:10,color:"#C3C8D0",letterSpacing:"0",marginBottom:10}}>Estado de proyectos</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
            {activos.map(pn=>{
              const proj=projects.find(p=>p.name===pn);
              const etiq=ETIQUETAS_PROY.find(e=>e.id===estrategia[`p_${pn}_etiqueta`]);
              return(
                <div key={pn} style={{background:etiq?etiq.bg+"88":"#1F232B",border:`1.5px solid ${etiq?etiq.color+"44":"#2E343E"}`,borderRadius:10,padding:"10px 12px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:7}}>
                    <div style={{width:9,height:9,borderRadius:99,background:proj?.color||"#3A414D"}}/>
                    <span style={{fontWeight:600,fontSize:11,color:"#ECEEF2",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{pn}</span>
                  </div>
                  <select value={estrategia[`p_${pn}_etiqueta`]||""} onChange={e=>save(`p_${pn}_etiqueta`,e.target.value)}
                    style={{width:"100%",border:`1px solid ${etiq?etiq.color+"44":"#2E343E"}`,borderRadius:7,padding:"5px 8px",fontSize:11,fontFamily:"inherit",background:etiq?etiq.bg:"white",color:etiq?etiq.color:"#9AA1AC",fontWeight:etiq?700:400,outline:"none"}}>
                    <option value="">— Sin etiqueta —</option>
                    {ETIQUETAS_PROY.map(e=><option key={e.id} value={e.id}>{e.label}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{fontWeight:600,fontSize:10,color:"#C3C8D0",letterSpacing:"0",marginBottom:12}}>Asignación por persona</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10,marginBottom:24}}>
          {INIT_MEMBERS.map(m=>{
            const asignados=(estrategia[`verano_${m.name}_proy`]||[]).filter(pn=>activos.includes(pn));
            return(
              <div key={m.name} style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:12,overflow:"hidden"}}>
                <div style={{background:m.color,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:30,height:30,borderRadius:99,background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,color:"#FFF",fontSize:12}}>{m.name[0]}</div>
                  <span style={{fontWeight:700,fontSize:13,color:"#FFF"}}>{m.name}</span>
                </div>
                <div style={{padding:"12px 14px"}}>
                  <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:8,minHeight:28}}>
                    {asignados.length===0
                      ? <span style={{fontSize:11,color:"#7F8692",fontStyle:"italic"}}>Sin asignar</span>
                      : asignados.map(pn=>{
                          const proj=projects.find(p=>p.name===pn);
                          return(
                            <div key={pn} style={{display:"flex",alignItems:"center",gap:4,background:proj?.color+"18",border:`1px solid ${proj?.color+"44"}`,borderRadius:6,padding:"3px 8px"}}>
                              <span style={{fontSize:10,fontWeight:600,color:proj?.color||"#C3C8D0"}}>{pn}</span>
                              <button onClick={()=>{
                                const cur=estrategia[`verano_${m.name}_proy`]||[];
                                save(`verano_${m.name}_proy`,cur.filter(x=>x!==pn));
                              }} style={{background:"none",border:"none",color:"#5C6370",cursor:"pointer",fontSize:11,padding:0,lineHeight:1}}>✕</button>
                            </div>
                          );
                        })
                    }
                  </div>
                  <select value="" onChange={e=>{
                    if(!e.target.value) return;
                    const cur=estrategia[`verano_${m.name}_proy`]||[];
                    if(!cur.includes(e.target.value)) save(`verano_${m.name}_proy`,[...cur,e.target.value]);
                  }} style={{width:"100%",border:"1px dashed #3A414D",borderRadius:7,padding:"5px 8px",fontSize:11,fontFamily:"inherit",color:"#9AA1AC",background:"#232831",outline:"none"}}>
                    <option value="">+ Añadir proyecto...</option>
                    {activos.filter(pn=>!asignados.includes(pn)).map(pn=>(
                      <option key={pn} value={pn}>{pn}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{fontWeight:600,fontSize:10,color:"#C3C8D0",letterSpacing:"0",marginBottom:12}}>Por proyecto</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:10}}>
          {activos.map(pn=>{
            const proj=projects.find(p=>p.name===pn);
            const color=proj?.color||"#C3C8D0";
            const etiq=ETIQUETAS_PROY.find(e=>e.id===estrategia[`p_${pn}_etiqueta`]);
            const personas=INIT_MEMBERS.filter(m=>(estrategia[`verano_${m.name}_proy`]||[]).includes(pn));
            return(
              <div key={pn} style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:12,overflow:"hidden"}}>
                <div style={{background:color,padding:"9px 14px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{color:"#FFF",fontWeight:700,fontSize:12}}>{pn}</span>
                  {etiq&&<span style={{background:"rgba(255,255,255,0.2)",color:"white",fontSize:9,fontWeight:600,padding:"2px 7px",borderRadius:99}}>{etiq.label}</span>}
                </div>
                <div style={{padding:"10px 14px"}}>
                  {personas.length===0
                    ? <div style={{fontSize:11,color:"#7F8692",fontStyle:"italic"}}>Sin personas asignadas</div>
                    : <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                        {personas.map(m=>(
                          <div key={m.name} style={{display:"flex",alignItems:"center",gap:5,background:m.light||"#262B34",border:`1px solid ${m.color}44`,borderRadius:99,padding:"3px 9px"}}>
                            <div style={{width:16,height:16,borderRadius:99,background:m.color,color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700}}>{m.name[0]}</div>
                            <span style={{fontSize:10,fontWeight:600,color:m.color}}>{m.name}</span>
                          </div>
                        ))}
                      </div>
                  }
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── VISTA ESTRATEGIA ────────────────────────────────────────────────────────
  function renderEstrategia(){
    return(
      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
          <div style={{fontSize:11,color:"#9AA1AC"}}>OKRs, KPIs y tracking semanal por proyecto</div>
          <button onClick={()=>setAddModal(true)}
            style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"7px 14px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            + Añadir proyecto
          </button>
        </div>
        {activos.length===0&&<div style={{textAlign:"center",padding:"40px 0",color:"#7F8692"}}>Pulsa "+ Añadir proyecto" para empezar.</div>}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12,marginBottom:selected?20:0}}>
          {activos.map(pn=>{
            const proj=projects.find(p=>p.name===pn);
            const color=proj?.color||"#C3C8D0";
            const pCV=Object.values(cv||{}).flat().filter(r=>r.proyecto===pn&&r.cat==="CV"&&!r.linkedFrom&&inVerano(r.fecha)).length;
            const pIng=(ing||[]).filter(r=>r.proyecto===pn&&inVerano(r.fecha)).reduce((s,r)=>s+signedBase(r),0);
            const objCV=parseFloat(estrategia[`p_${pn}_cv`])||0;
            const objIng=parseFloat(estrategia[`p_${pn}_ing`])||0;
            const etiq=ETIQUETAS_PROY.find(e=>e.id===estrategia[`p_${pn}_etiqueta`]);
            const hasOKR=!!(estrategia[`p_${pn}_okrs`]||"").trim();
            const isSelected=selected===pn;
            const pctCV=objCV>0?Math.min((pCV/objCV)*100,100):0;
            const pctIng=objIng>0?Math.min((pIng/objIng)*100,100):0;
            const r2=20,circ=2*Math.PI*r2;
            function ring(val,obj,col){
              if(obj<=0) return null;
              const pct=Math.min((val/obj)*100,100);
              const dash=(pct/100)*circ;
              return(
                <div style={{position:"relative",width:48,height:48,flexShrink:0}}>
                  <svg width="48" height="48" viewBox="0 0 48 48" style={{transform:"rotate(-90deg)"}}>
                    <circle cx="24" cy="24" r={r2} fill="none" stroke="#2E343E" strokeWidth="5"/>
                    <circle cx="24" cy="24" r={r2} fill="none" stroke={pct>=100?"#059669":col} strokeWidth="5" strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"/>
                  </svg>
                  <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:pct>=100?"#059669":col}}>{pct.toFixed(0)}%</div>
                </div>
              );
            }
            return(
              <div key={pn} style={{background:"#1F232B",borderRadius:14,border:`2px solid ${isSelected?color:"#4A515D"}`,overflow:"hidden",cursor:"pointer",boxShadow:isSelected?`0 4px 20px ${color}22`:"0 1px 3px rgba(0,0,0,0.06)",transition:"all .2s"}}
                onClick={()=>setSelected(isSelected?null:pn)}>
                <div style={{height:4,background:color}}/>
                <div style={{padding:"14px 16px"}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:10}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:13,color:"#ECEEF2",marginBottom:4}}>{pn}</div>
                      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                        {etiq&&<span style={{background:etiq.bg,color:etiq.color,fontSize:9,fontWeight:600,padding:"2px 7px",borderRadius:99}}>{etiq.label}</span>}
                        {hasOKR&&<span style={{background:"#452311",color:"#E8501C",fontSize:9,fontWeight:600,padding:"2px 7px",borderRadius:99}}>OKRs ✓</span>}
                      </div>
                    </div>
                    <button onClick={e=>{e.stopPropagation();removeProyecto(pn);}}
                      style={{background:"none",border:"none",color:"#5C6370",cursor:"pointer",fontSize:14,padding:"0 0 0 8px"}}>✕</button>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                    <div style={{background:"#113145",borderRadius:9,padding:"8px 10px",display:"flex",alignItems:"center",gap:8}}>
                      {ring(pCV,objCV,"#0EA5E9")}
                      <div>
                        <div style={{fontSize:9,color:"#0369A1",fontWeight:600}}>CV</div>
                        <div style={{fontSize:16,fontWeight:700,color:"#0369A1",lineHeight:1}}>{pCV}</div>
                        <div style={{fontSize:9,color:"#7DD3FC"}}>obj: {objCV||"—"}</div>
                      </div>
                    </div>
                    <div style={{background:"#114521",borderRadius:9,padding:"8px 10px",display:"flex",alignItems:"center",gap:8}}>
                      {ring(pIng,objIng,"#059669")}
                      <div style={{minWidth:0}}>
                        <div style={{fontSize:9,color:"#7BF4D2",fontWeight:600}}>Ingresos</div>
                        <div style={{fontSize:14,fontWeight:700,color:"#7BF4D2",lineHeight:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{pIng.toFixed(0)}€</div>
                        <div style={{fontSize:9,color:"#6EE7B7"}}>obj: {objIng>0?objIng+"€":"—"}</div>
                      </div>
                    </div>
                  </div>
                  <div style={{fontSize:10,color,fontWeight:500,textAlign:"right"}}>{isSelected?"▲ Cerrar":"▼ Editar"}</div>
                </div>
              </div>
            );
          })}
        </div>

        {selected&&(()=>{
          const proj=projects.find(p=>p.name===selected);
          const color=proj?.color||"#C3C8D0";
          const pCV=Object.values(cv||{}).flat().filter(r=>r.proyecto===selected&&r.cat==="CV"&&!r.linkedFrom&&inVerano(r.fecha)).length;
          const pIng=(ing||[]).filter(r=>r.proyecto===selected&&inVerano(r.fecha)).reduce((s,r)=>s+signedBase(r),0);
          const pBP=Object.values(bp||{}).flat().filter(r=>r.proyecto===selected).reduce((s,r)=>s+(parseFloat(r.puntos)||0),0);
          const etiq=ETIQUETAS_PROY.find(e=>e.id===estrategia[`p_${selected}_etiqueta`]);
          return(
            <div style={{background:"#1F232B",border:`2px solid ${color}`,borderRadius:16,overflow:"hidden",boxShadow:`0 8px 32px ${color}22`}}>
              <div style={{background:color,padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{color:"#FFF",fontWeight:700,fontSize:14}}>{selected}</div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {etiq&&<span style={{background:"rgba(255,255,255,0.2)",color:"white",fontSize:10,fontWeight:600,padding:"3px 10px",borderRadius:99}}>{etiq.label}</span>}
                  <button onClick={()=>setSelected(null)}
                    style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#FFF",borderRadius:7,padding:"4px 10px",cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>✕ Cerrar</button>
                </div>
              </div>
              <div style={{padding:"20px 22px"}}>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:20}}>
                  <div style={{background:"#113145",border:"1.5px solid #1F5B7A",borderRadius:10,padding:"10px 12px",flex:1,minWidth:0}}>
                    <div style={{fontSize:9,fontWeight:700,color:"#0EA5E9",letterSpacing:"0",marginBottom:3}}>CV (verano)</div>
                    <div style={{fontSize:18,fontWeight:800,color:"#0EA5E9",lineHeight:1,letterSpacing:"-1px"}}>{pCV}</div>
                    <div style={{fontSize:9,color:"#7F8692",marginTop:2}}>obj: {estrategia[`p_${selected}_cv`]||"—"}</div>
                  </div>
                  <div style={{background:"#114521",border:"1.5px solid #1F7A50",borderRadius:10,padding:"10px 12px",flex:1,minWidth:0}}>
                    <div style={{fontSize:9,fontWeight:700,color:"#059669",letterSpacing:"0",marginBottom:3}}>Ingresos (verano)</div>
                    <div style={{fontSize:18,fontWeight:800,color:"#059669",lineHeight:1,letterSpacing:"-1px"}}>{pIng.toFixed(0)}€</div>
                    <div style={{fontSize:9,color:"#7F8692",marginTop:2}}>obj: {estrategia[`p_${selected}_ing`]||"—"}€</div>
                  </div>
                  <div style={{background:"#452311",border:"1.5px solid #1F317A",borderRadius:10,padding:"10px 12px",flex:1,minWidth:0}}>
                    <div style={{fontSize:9,fontWeight:700,color:"#E8501C",letterSpacing:"0",marginBottom:3}}>Bookpoints</div>
                    <div style={{fontSize:18,fontWeight:800,color:"#E8501C",lineHeight:1,letterSpacing:"-1px"}}>{pBP}</div>
                    <div style={{fontSize:9,color:"#7F8692",marginTop:2}}>total acumulado</div>
                  </div>
                  <div style={{background:"#453B11",border:"1.5px solid #7A681F",borderRadius:10,padding:"10px 12px",flex:1,minWidth:0}}>
                    <div style={{fontSize:9,fontWeight:700,color:"#F59E0B",letterSpacing:"0",marginBottom:3}}>Facturas</div>
                    <div style={{fontSize:18,fontWeight:800,color:"#F59E0B",lineHeight:1,letterSpacing:"-1px"}}>{(ing||[]).filter(r=>r.proyecto===selected&&inVerano(r.fecha)).length}</div>
                    <div style={{fontSize:9,color:"#7F8692",marginTop:2}}>en verano</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"auto 1fr 1fr",gap:12,marginBottom:20,alignItems:"start"}}>
                  <div>
                    <div style={{fontSize:10,fontWeight:600,color:"#9AA1AC",marginBottom:6}}>🏷 Estado</div>
                    <select value={estrategia[`p_${selected}_etiqueta`]||""} onChange={e=>save(`p_${selected}_etiqueta`,e.target.value)}
                      style={{border:`1.5px solid ${etiq?etiq.color+"44":"#2E343E"}`,borderRadius:8,padding:"6px 10px",fontSize:11,fontFamily:"inherit",background:etiq?etiq.bg:"white",color:etiq?etiq.color:"#9AA1AC",fontWeight:etiq?700:400,cursor:"pointer",outline:"none"}}>
                      <option value="">— Sin etiqueta —</option>
                      {ETIQUETAS_PROY.map(e=><option key={e.id} value={e.id}>{e.label}</option>)}
                    </select>
                  </div>
                  <div style={{background:"#113145",borderRadius:10,padding:"12px"}}>
                    <div style={{fontSize:10,fontWeight:600,color:"#0369A1",marginBottom:6}}>🤝 Objetivo CV</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <input type="number" value={estrategia[`p_${selected}_cv`]||""} onChange={e=>save(`p_${selected}_cv`,e.target.value)}
                        style={{width:70,border:"2px solid #1F5B7A",borderRadius:8,padding:"5px 8px",fontSize:15,fontWeight:700,fontFamily:"inherit",color:"#0369A1",textAlign:"center",outline:"none",background:"#1F232B"}}/>
                      <span style={{fontSize:11,color:"#7DD3FC"}}>CV</span>
                    </div>
                  </div>
                  <div style={{background:"#114521",borderRadius:10,padding:"12px"}}>
                    <div style={{fontSize:10,fontWeight:600,color:"#7BF4D2",marginBottom:6}}>💰 Objetivo ingresos</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <input type="number" value={estrategia[`p_${selected}_ing`]||""} onChange={e=>save(`p_${selected}_ing`,e.target.value)}
                        style={{width:90,border:"2px solid #1F7A50",borderRadius:8,padding:"5px 8px",fontSize:15,fontWeight:700,fontFamily:"inherit",color:"#7BF4D2",textAlign:"center",outline:"none",background:"#1F232B"}}/>
                      <span style={{fontSize:11,color:"#6EE7B7"}}>€</span>
                    </div>
                  </div>
                </div>
                <div style={{marginBottom:20}}>
                  <div style={{fontWeight:700,fontSize:11,color:"#C3C8D0",letterSpacing:"0",marginBottom:8}}>🎯 OKRs del proyecto</div>
                  <textarea value={estrategia[`p_${selected}_okrs`]||""} onChange={e=>save(`p_${selected}_okrs`,e.target.value)}
                    placeholder="Objetivo 1: ... | KR1: ... | KR2: ..."
                    style={{width:"100%",border:"1.5px solid #1F337A",borderRadius:9,padding:"10px 12px",fontSize:11,fontFamily:"inherit",resize:"vertical",minHeight:80,color:"#C3C8D0",lineHeight:1.7,boxSizing:"border-box",outline:"none",background:"#232831"}}/>
                </div>
                <div style={{fontWeight:700,fontSize:11,color:"#C3C8D0",letterSpacing:"0",marginBottom:10}}>📅 Tracking semanal (verano)</div>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {SEMANAS_VERANO.map(wk=>{
                    const wkFacts=(ing||[]).filter(r=>r.proyecto===selected&&getWeekKey(r.fecha)===wk);
                    const wkCVs=Object.values(cv||{}).flat().filter(r=>{
                      if(r.proyecto!==selected||r.linkedFrom) return false;
                      if(!r.fecha) return false;
                      const[dd,mm]=r.fecha.split("/");
                      return getWeekKey(`${dd}/${mm}/2026`)===wk;
                    });
                    const wkIng=wkFacts.reduce((s,r)=>s+signedBase(r),0);
                    const wkEvi=estrategia[`tracking_${selected}_${wk}`]||"";
                    const d=new Date(wk);
                    const de=new Date(d); de.setDate(d.getDate()+6);
                    const fmtD=x=>`${String(x.getDate()).padStart(2,"0")}/${String(x.getMonth()+1).padStart(2,"0")}`;
                    const hasActivity=wkFacts.length>0||wkCVs.length>0;
                    const today=new Date(); today.setHours(0,0,0,0);
                    const isPast=de<today;
                    const isCurrent=d<=today&&de>=today;
                    return(
                      <div key={wk} style={{borderRadius:12,overflow:"hidden",border:`2px solid ${isCurrent?"#262B34":hasActivity?"#1F7A3F":"#2E343E"}`,opacity:isPast&&!hasActivity&&!wkEvi?0.45:1}}>
                        <div style={{background:isCurrent?"#323844":hasActivity?"#065F46":"#262B34",padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:6}}>
                          <div style={{display:"flex",alignItems:"center",gap:10}}>
                            {isCurrent&&<span style={{fontSize:10,background:"#453911",color:"#F3A97D",fontWeight:700,padding:"2px 8px",borderRadius:99}}>Esta semana</span>}
                            <span style={{fontWeight:700,fontSize:12,color:isCurrent||hasActivity?"white":"#C3C8D0"}}>{fmtD(d)} — {fmtD(de)}</span>
                          </div>
                          <div style={{display:"flex",gap:8}}>
                            {wkIng>0&&<div style={{background:"rgba(255,255,255,0.2)",borderRadius:8,padding:"4px 12px",textAlign:"center"}}>
                              <div style={{fontSize:8,color:"rgba(255,255,255,0.8)",fontWeight:600}}>FACTURADO</div>
                              <div style={{fontSize:16,fontWeight:800,color:"white",lineHeight:1}}>{wkIng.toFixed(0)}€</div>
                            </div>}
                            {wkCVs.length>0&&<div style={{background:"rgba(255,255,255,0.2)",borderRadius:8,padding:"4px 12px",textAlign:"center"}}>
                              <div style={{fontSize:8,color:"rgba(255,255,255,0.8)",fontWeight:600}}>CV</div>
                              <div style={{fontSize:16,fontWeight:800,color:"white",lineHeight:1}}>{wkCVs.length}</div>
                            </div>}
                          </div>
                        </div>
                        <div style={{padding:"12px 16px",background:"#1F232B"}}>
                          {wkFacts.length>0&&(
                            <div style={{marginBottom:10}}>
                              <div style={{fontSize:10,fontWeight:700,color:"#059669",letterSpacing:"0",marginBottom:6}}>💰 Facturas</div>
                              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                                {wkFacts.map((f,fi)=>(
                                  <div key={fi} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#114521",borderRadius:8,padding:"8px 12px",border:"1px solid #1F7A3F"}}>
                                    <div>
                                      <div style={{fontWeight:600,fontSize:12,color:"#7BF4D2"}}>{f.ref||"Sin ref"}</div>
                                      <div style={{fontSize:10,color:"#9AA1AC"}}>{f.descripcion||"—"}</div>
                                    </div>
                                    <div style={{fontSize:18,fontWeight:800,color:"#059669"}}>{parseFloat(f.base||0).toFixed(0)}€</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {wkCVs.length>0&&(
                            <div style={{marginBottom:10}}>
                              <div style={{fontSize:10,fontWeight:700,color:"#0EA5E9",letterSpacing:"0",marginBottom:6}}>🤝 Visitas de venta</div>
                              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                                {wkCVs.map((cv,ci)=>(
                                  <div key={ci} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#113145",borderRadius:8,padding:"8px 12px",border:"1px solid #1F5B7A"}}>
                                    <div>
                                      <div style={{fontWeight:600,fontSize:12,color:"#0369A1"}}>{cv.cliente||"—"}</div>
                                      <div style={{fontSize:10,color:"#9AA1AC"}}>{cv.member}{cv.proyecto?` · ${cv.proyecto}`:""}</div>
                                    </div>
                                    <span style={{background:"#0EA5E9",color:"white",fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:99}}>CV</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {!hasActivity&&<div style={{fontSize:11,color:"#7F8692",fontStyle:"italic",marginBottom:8}}>{isPast?"Sin actividad":"Próximamente"}</div>}
                          <textarea value={wkEvi} onChange={e=>{
                            const v=e.target.value;
                            setEstrategia(prev=>({...prev,[`tracking_${selected}_${wk}`]:v}));
                            sb.from("estrategia").upsert({key:`tracking_${selected}_${wk}`,val:v},{onConflict:"key"}).catch(()=>{});
                          }} placeholder="Notas, hitos, próximos pasos..."
                            style={{width:"100%",border:"1px solid #2E343E",borderRadius:8,padding:"8px 12px",fontSize:11,fontFamily:"inherit",resize:"vertical",minHeight:50,color:"#C3C8D0",lineHeight:1.5,boxSizing:"border-box",outline:"none",background:"#232831"}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    );
  }

  return(
    <div>
      {addModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={e=>{if(e.target===e.currentTarget)setAddModal(false);}}>
          <div style={{background:"#1F232B",borderRadius:14,padding:"24px 28px",width:340,boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}}>
            <div style={{fontWeight:800,fontSize:14,color:"#ECEEF2",marginBottom:4}}>+ Añadir proyecto</div>
            <div style={{fontSize:11,color:"#9AA1AC",marginBottom:16}}>Elige un proyecto para añadirlo a la estrategia.</div>
            {disponibles.length===0
              ? <div style={{fontSize:11,color:"#7F8692",textAlign:"center",padding:"20px 0"}}>Todos los proyectos ya están añadidos</div>
              : <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {disponibles.map(p=>(
                    <button key={p.name} onClick={()=>addProyecto(p.name)}
                      style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:9,border:"1px solid #2E343E",background:"#232831",cursor:"pointer",fontFamily:"inherit",width:"100%",textAlign:"left"}}>
                      <div style={{width:12,height:12,borderRadius:99,background:p.color,flexShrink:0}}/>
                      <span style={{fontWeight:600,fontSize:12,color:"#ECEEF2"}}>{p.name}</span>
                    </button>
                  ))}
                </div>
            }
            <button onClick={()=>setAddModal(false)}
              style={{marginTop:14,width:"100%",padding:"8px",borderRadius:8,border:"1px solid #2E343E",background:"#1F232B",fontSize:11,cursor:"pointer",fontFamily:"inherit",color:"#9AA1AC"}}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      <div style={{display:"flex",gap:0,borderBottom:"1px solid #2E343E",marginBottom:20}}>
        {[{id:"estrategia",label:"🎯 Estrategia"},{id:"verano",label:"☀️ Planificación verano"}].map(t=>(
          <button key={t.id} onClick={()=>setVistaTab(t.id)} style={{
            background:"transparent",color:vistaTab===t.id?"#ECEEF2":"#9AA1AC",
            border:"none",borderBottom:vistaTab===t.id?"2px solid #ECEEF2":"2px solid transparent",
            padding:"8px 16px",fontSize:12,fontWeight:vistaTab===t.id?700:400,
            cursor:"pointer",fontFamily:"inherit",
          }}>{t.label}</button>
        ))}
      </div>
      {vistaTab==="estrategia"&&renderEstrategia()}
      {vistaTab==="verano"&&renderVerano()}
    </div>
  );
}

// ── ESTRATEGIA TAB ────────────────────────────────────────────────────────────
function EstrategiaTab({projects, ing, cv}){
  const [estrategia, setEstrategia] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [seccion, setSeccion] = useState("equipo"); // equipo | proyectos

  useEffect(()=>{
    sb.from("estrategia").select("*")
      .then(({data})=>{
        const m={};
        (data||[]).forEach(r=>{ m[r.key]=r.val; });
        setEstrategia(m);
        setLoading(false);
      }).catch(()=>{ setEstrategia({}); setLoading(false); });
  },[]);

  async function save(key, val){
    setEstrategia(prev=>({...prev,[key]:val}));
    setSaving(true);
    try {
      await sb.from("estrategia").upsert({key, val},{onConflict:"key"});
    } catch(e){ console.error(e); }
    setSaving(false);
  }

  if(loading||!estrategia) return <div style={{padding:40,textAlign:"center",color:"#7F8692"}}>Cargando estrategia...</div>;

  // Reales del equipo
  const realCV = Object.values(cv).flat().filter(r=>r.cat==="CV"&&!r.linkedFrom).length;
  const realIng = ing.reduce((s,r)=>s+signedBase(r),0);
  const realProy = projects.length;

  // Objetivo equipo
  const objCV  = parseFloat(estrategia["eq_obj_cv"])||0;
  const objIng = parseFloat(estrategia["eq_obj_ing"])||0;
  const objProy = parseFloat(estrategia["eq_obj_proy"])||0;

  function PctBar({val,obj,color}){
    const pct = obj>0 ? Math.min((val/obj)*100,100) : 0;
    return(
      <div>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:3}}>
          <span style={{color:"#9AA1AC"}}>{val.toFixed(val%1===0?0:0)} / {obj}</span>
          <span style={{fontWeight:700,color:pct>=100?"#059669":color}}>{pct.toFixed(0)}%</span>
        </div>
        <div style={{background:"#2E343E",borderRadius:99,height:7,overflow:"hidden"}}>
          <div style={{width:`${pct}%`,height:"100%",background:pct>=100?"#059669":color,borderRadius:99,transition:"width .5s"}}/>
        </div>
      </div>
    );
  }

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontWeight:800,fontSize:17,color:"#ECEEF2"}}>🎯 Estrategia {EMPRESA}</div>
          <div style={{fontSize:11,color:"#9AA1AC",marginTop:2}}>Define objetivos del equipo y de cada proyecto. El progreso se calcula automáticamente.</div>
        </div>
        {saving&&<span style={{fontSize:10,color:"#F59E0B",fontWeight:600}}>💾 Guardando...</span>}
      </div>

      {/* Sub-tabs */}
      <div style={{display:"flex",gap:0,borderBottom:"1px solid #2E343E",marginBottom:20}}>
        {[{id:"equipo",label:"🏢 Equipo"},{id:"proyectos",label:"📁 Proyectos"}].map(t=>(
          <button key={t.id} onClick={()=>setSeccion(t.id)} style={{
            background:"transparent",color:seccion===t.id?"#ECEEF2":"#9AA1AC",
            border:"none",borderBottom:seccion===t.id?"2px solid #ECEEF2":"2px solid transparent",
            padding:"8px 16px",fontSize:12,fontWeight:seccion===t.id?700:400,
            cursor:"pointer",fontFamily:"inherit",
          }}>{t.label}</button>
        ))}
      </div>

      {seccion==="equipo"&&(
        <div>
          {/* Misión / Visión */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>
            {[
              {key:"eq_mision",label:"🌟 Misión",placeholder:"¿Para qué existe la empresa? ¿Cuál es vuestro propósito?"},
              {key:"eq_vision",label:"🔭 Visión",placeholder:"¿Dónde queréis estar en 3 años? ¿Cómo os imagináis a futuro?"},
            ].map(f=>(
              <div key={f.key} style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:12,padding:"14px 16px"}}>
                <div style={{fontWeight:700,fontSize:12,color:"#ECEEF2",marginBottom:8}}>{f.label}</div>
                <textarea value={estrategia[f.key]||""} onChange={e=>save(f.key,e.target.value)}
                  placeholder={f.placeholder}
                  style={{width:"100%",border:"none",outline:"none",fontSize:12,fontFamily:"inherit",resize:"vertical",minHeight:70,color:"#C3C8D0",lineHeight:1.6,boxSizing:"border-box"}}/>
              </div>
            ))}
          </div>

          {/* Valores */}
          <div style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:12,padding:"14px 16px",marginBottom:20}}>
            <div style={{fontWeight:700,fontSize:12,color:"#ECEEF2",marginBottom:8}}>💎 Valores del equipo</div>
            <textarea value={estrategia["eq_valores"]||""} onChange={e=>save("eq_valores",e.target.value)}
              placeholder="Ej: Transparencia, aprendizaje continuo, trabajo en equipo, impacto social..."
              style={{width:"100%",border:"none",outline:"none",fontSize:12,fontFamily:"inherit",resize:"vertical",minHeight:50,color:"#C3C8D0",lineHeight:1.6,boxSizing:"border-box"}}/>
          </div>

          {/* Objetivos equipo */}
          <div style={{fontWeight:700,fontSize:13,color:"#ECEEF2",marginBottom:12}}>📊 Objetivos del equipo 2026</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:20}}>
            {[
              {key:"eq_obj_cv",  label:"🤝 Objetivo CV",        real:realCV,  color:"#0EA5E9", unit:"CV",   desc:"Visitas de ventas cerradas"},
              {key:"eq_obj_ing", label:"💰 Objetivo ingresos",   real:realIng, color:"#059669", unit:"€",    desc:"Facturación total del equipo"},
              {key:"eq_obj_proy",label:"📁 Objetivo proyectos",  real:realProy,color:"#7C3AED", unit:"proy", desc:"Proyectos activos con facturación"},
            ].map(k=>(
              <div key={k.key} style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:12,padding:"14px 16px"}}>
                <div style={{fontWeight:700,fontSize:11,color:"#C3C8D0",marginBottom:10}}>{k.label}</div>
                <div style={{fontSize:10,color:"#7F8692",marginBottom:8}}>{k.desc}</div>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
                  <span style={{fontSize:10,color:"#9AA1AC"}}>Objetivo:</span>
                  <input type="number" value={estrategia[k.key]||""} onChange={e=>save(k.key,e.target.value)}
                    placeholder="0"
                    style={{width:80,border:"1px solid #2E343E",borderRadius:7,padding:"4px 8px",fontSize:13,fontWeight:700,fontFamily:"inherit",color:k.color,textAlign:"right",outline:"none"}}/>
                  <span style={{fontSize:10,color:"#9AA1AC"}}>{k.unit}</span>
                </div>
                <PctBar val={k.real} obj={parseFloat(estrategia[k.key])||0} color={k.color}/>
                <div style={{fontSize:10,color:"#7F8692",marginTop:5}}>Real: <b style={{color:k.color}}>{k.real.toFixed(k.real%1===0?0:0)}{k.unit==="€"?"€":""}</b></div>
              </div>
            ))}
          </div>

          {/* OKRs del equipo */}
          <div style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:12,padding:"14px 16px",marginBottom:20}}>
            <div style={{fontWeight:700,fontSize:12,color:"#ECEEF2",marginBottom:8}}>🎯 OKRs del equipo</div>
            <textarea value={estrategia["eq_okrs"]||""} onChange={e=>save("eq_okrs",e.target.value)}
              placeholder="Objetivo 1: ... | KR1: ... | KR2: ... | Objetivo 2: ..."
              style={{width:"100%",border:"none",outline:"none",fontSize:12,fontFamily:"inherit",resize:"vertical",minHeight:120,color:"#C3C8D0",lineHeight:1.8,boxSizing:"border-box",fontVariantNumeric:"tabular-nums"}}/>
          </div>

          {/* Notas estratégicas */}
          <div style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:12,padding:"14px 16px"}}>
            <div style={{fontWeight:700,fontSize:12,color:"#ECEEF2",marginBottom:8}}>📝 Notas estratégicas</div>
            <textarea value={estrategia["eq_notas"]||""} onChange={e=>save("eq_notas",e.target.value)}
              placeholder="Reflexiones, decisiones clave, próximos pasos del equipo..."
              style={{width:"100%",border:"none",outline:"none",fontSize:12,fontFamily:"inherit",resize:"vertical",minHeight:80,color:"#C3C8D0",lineHeight:1.6,boxSizing:"border-box"}}/>
          </div>
        </div>
      )}

      {seccion==="proyectos"&&(
        <EstrategiaProyectosTab projects={projects} ing={ing} cv={cv}/>
      )}
    </div>
  );
}

// ── Proyectos ocultos: compartidos por todo el equipo (audit_progress "proyectos_ocultos") y al momento ──
function useProyectosOcultos(){
  const [ocultos,setOcultosRaw]=useState(()=>{ try{ return JSON.parse(localStorage.getItem("blesk_hidden_projects")||"[]"); }catch{ return []; } });
  useEffect(()=>{
    let vivo=true;
    const cargar=()=>sb.from("audit_progress").select("val").eq("key","proyectos_ocultos").maybeSingle().then(({data,error})=>{
      if(!vivo||error) return;
      if(Array.isArray(data?.val)){ setOcultosRaw(data.val); try{ localStorage.setItem("blesk_hidden_projects",JSON.stringify(data.val)); }catch{} }
      else if(data==null){
        // Primera vez: se sube la lista que hubiera en este ordenador
        let local=[]; try{ local=JSON.parse(localStorage.getItem("blesk_hidden_projects")||"[]"); }catch{}
        if(local.length) sb.from("audit_progress").upsert({key:"proyectos_ocultos",val:local},{onConflict:"key"}).then(()=>{});
      }
    });
    cargar();
    const ch=sb.channel("rt:proyectos_ocultos_"+Math.random().toString(36).slice(2,7))
      .on("postgres_changes",{event:"*",schema:"public",table:"audit_progress",filter:"key=eq.proyectos_ocultos"},p=>{ if(Array.isArray(p.new?.val)) setOcultosRaw(p.new.val); })
      .subscribe();
    const t=setInterval(cargar,20000);
    const vis=()=>{ if(document.visibilityState==="visible") cargar(); };
    document.addEventListener("visibilitychange",vis);
    return ()=>{ vivo=false; clearInterval(t); document.removeEventListener("visibilitychange",vis); try{ sb.removeChannel(ch); }catch{} };
  },[]);
  function setOcultos(upd){
    setOcultosRaw(prev=>{
      const next=typeof upd==="function"?upd(prev):upd;
      try{ localStorage.setItem("blesk_hidden_projects",JSON.stringify(next)); }catch{}
      sb.from("audit_progress").upsert({key:"proyectos_ocultos",val:next},{onConflict:"key"}).then(({error})=>{ if(error) console.error("❌ proyectos ocultos",error); });
      return next;
    });
  }
  return [ocultos,setOcultos];
}

function ProyectosTab({projects,setProjects,setProjectsDirectly,crm,setCRM,customers,ingresos,gastos,hojas,ing,cv,bp}){
  const [subTabProy,setSubTabProy]=useState("proyectos");
  // Participantes: se eligen al crear el proyecto y salen en cada tarjeta
  const [participantes,setParticipantes]=useState(()=>perfil.nombre?[perfil.nombre]:[]);
  const [equipos,setEquipos]=useState({}); // {proyecto:[miembros]}
  useEffect(()=>{
    sb.from("proyecto_roles").select("proyecto,miembro").then(({data})=>{
      const m={}; (data||[]).forEach(r=>{ (m[r.proyecto]=m[r.proyecto]||[]).push(r.miembro); }); setEquipos(m);
    });
  },[]);
  const toggleParticipante=n=>setParticipantes(ps=>ps.includes(n)?ps.filter(x=>x!==n):[...ps,n]);
  const [newName,setNewName]=useState("");
  const [newColor,setNewColor]=useState("#0F3460");
  const [newLight,setNewLight]=useState("#112845");
  const [err,setErr]=useState("");
  const [selectedProject,setSelectedProject]=useState(null);
  const [renameModal,setRenameModal]=useState(null); // {proj, tmpName, tmpColor, tmpLight}
  const [renaming,setRenaming]=useState(false);

  async function addProject(){
    const name=newName.trim();
    if(!name){setErr("Escribe un nombre");return;}
    if(projects.find(p=>p.name.toLowerCase()===name.toLowerCase())){setErr("Ya existe ese proyecto");return;}
    if(!participantes.length){setErr("Elige quién va a participar en el proyecto");return;}
    const idx=projects.length%PROJ_PALETTE.length;
    const [dc,lc]=PROJ_PALETTE[idx];
    const color=newColor||dc, light=newLight||lc;
    // Create in Clockify first to get the ID
    let clockifyId = null;
    if(USAR_CLOCKIFY) try {
      const cpResult = await createClockifyProject(name);
      clockifyId = cpResult?.id || null;
    } catch(e){ console.warn("Clockify create failed", e); }
    const equipo=MIEMBROS_VISIBLES.map(m=>m.name).filter(n=>participantes.includes(n));
    setProjects(ps=>[...ps,{name,color,light,clockifyId,participantes:equipo}]);
    setEquipos(e=>({...e,[name]:equipo}));
    setCRM(d=>({...d,[name]:{g1:{name:"GRUPO 1",rows:[]},g2:{name:"GRUPO 2",rows:[]}}}));
    setNewName("");setErr("");setParticipantes(perfil.nombre?[perfil.nombre]:[]);
  }

  const [confirmDelete,setConfirmDelete]=useState(null);
  const [hiddenProjects,setHiddenProjects]=useProyectosOcultos();
  const [showVisibilityPanel,setShowVisibilityPanel]=useState(false);
  function toggleHide(name){
    setHiddenProjects(prev=>prev.includes(name)?prev.filter(n=>n!==name):[...prev,name]);
  }
  const all1Projects    = projects.filter(p=>p.name&&p.name.trim()!=="");
  const visibleProjects = all1Projects.filter(p=>!hiddenProjects.includes(p.name));

  async function confirmAndDelete(){
    const pname=confirmDelete;
    const proj=projects.find(p=>p.name===pname);
    setConfirmDelete(null);
    // Archive in Clockify if linked
    if(USAR_CLOCKIFY&&proj?.clockifyId){
      try{ await archiveClockifyProject(proj.clockifyId); }
      catch(e){ console.warn("Clockify archive failed",e); }
    }
    setProjects(ps=>ps.filter(p=>p.name!==pname));
    sb.from("proyecto_roles").delete().eq("proyecto",pname).then(()=>{});
    setEquipos(e=>{ const n={...e}; delete n[pname]; return n; });
    setCRM(d=>{const nd={...d};delete nd[pname];return nd;});
  }

  async function doRename(){
    if(!renameModal) return;
    const newN = renameModal.tmpName.trim();
    if(!newN){ setRenameModal(null); return; }
    if(projects.find(p=>p.name.toLowerCase()===newN.toLowerCase()&&p.name!==renameModal.proj.name)){
      alert("Ya existe un proyecto con ese nombre"); return;
    }
    setRenaming(true);
    const oldName = renameModal.proj.name;
    const newColor = renameModal.tmpColor;
    const newLight = renameModal.tmpLight;
    // Update in Supabase directly
    await sb.from("projects").update({name:newN,color:newColor,light:newLight}).eq("name",oldName);
    if(newN!==oldName){
      await sb.from("proyecto_roles").update({proyecto:newN}).eq("proyecto",oldName);
      setEquipos(e=>{ const n={...e}; if(n[oldName]){ n[newN]=n[oldName]; delete n[oldName]; } return n; });
    }
    // Participantes: añade los nuevos (rol "Participante") y quita los desmarcados
    {
      const antes=equipos[oldName]||[], ahora=renameModal.tmpEquipo||antes;
      const nuevos=ahora.filter(n=>!antes.includes(n)), fuera=antes.filter(n=>!ahora.includes(n));
      if(nuevos.length) await sb.from("proyecto_roles").upsert(nuevos.map(miembro=>({proyecto:newN,miembro,rol:"Participante"})),{onConflict:"proyecto,miembro",ignoreDuplicates:true});
      if(fuera.length) await sb.from("proyecto_roles").delete().eq("proyecto",newN).in("miembro",fuera);
      setEquipos(e=>({...e,[newN]:MIEMBROS_VISIBLES.map(m=>m.name).filter(n=>ahora.includes(n))}));
    }
    // Update local state
    setProjectsDirectly(ps=>ps.map(p=>p.name===oldName?{...p,name:newN,color:newColor,light:newLight}:p));
    // Update CRM keys
    setCRM(d=>{
      const nd={...d};
      if(nd[oldName]){ nd[newN]=nd[oldName]; delete nd[oldName]; }
      return nd;
    });
    // Las horas registradas en ⏱ Horas pasan al nombre nuevo
    try{
      const hs=(await horasLoad()).filter(e=>e.proyecto===oldName).map(e=>({...e,proyecto:newN}));
      if(hs.length) await horasGuardar(hs);
    }catch(e){ console.warn("Horas rename failed",e); }
    // Sync to Clockify if we can find the project
    if(USAR_CLOCKIFY) try{
      const cprojs = await fetchClockifyProjects();
      const cp = cprojs.find(p=>p.name===oldName||p.name.toLowerCase()===oldName.toLowerCase());
      if(cp) await renameClockifyProject(cp.id, newN);
    }catch(e){ console.warn("Clockify rename failed",e); }
    setRenaming(false);
    setRenameModal(null);
    if(selectedProject===oldName) setSelectedProject(newN);
  }

  function projStats(pname){
    const allCust=Object.values(customers).flat().filter(r=>r.proyecto===pname);
    const allIng=(ingresos||[]).filter(r=>r.proyecto===pname);
    const allGas=(gastos||[]).filter(r=>r.proyecto===pname);
    const allHojas=(hojas||[]).filter(r=>r.proyecto===pname);
    const crmAll=[...(crm[pname]?.g1?.rows||[]),...(crm[pname]?.g2?.rows||[])];
    return{
      cv:allCust.filter(r=>r.cat==="CV"&&!r.linkedFrom).length,
      lv:allCust.filter(r=>r.cat==="LV"&&!r.linkedFrom).length,
      ing:allIng.reduce((s,r)=>s+signedBase(r),0),
      gas:allGas.reduce((s,r)=>s+signedBase(r),0)+allHojas.reduce((s,r)=>{
        const prows=r.proyectos&&r.proyectos.length>0?r.proyectos:[{proyecto:r.proyecto||"",importe:r.importe_proyecto||r.importe||""}];
        const match=prows.find(p=>p.proyecto===pname);
        return s+(match?parseFloat(match.importe)||0:0);
      },0),
      ventas:crmAll.filter(r=>r.estado==="Venta cerrada").length,
      contactos:crmAll.filter(r=>r.estado).length,
    };
  }

  return(
    <div>
      {/* Sub-tabs */}
      <div style={{display:"flex",gap:0,borderBottom:"1px solid #2E343E",marginBottom:20}}>
        {[{id:"proyectos",label:"📁 Proyectos"},{id:"estrategia",label:"🎯 Estrategia"}].map(t=>(
          <button key={t.id} onClick={()=>setSubTabProy(t.id)} style={{
            background:"transparent",color:subTabProy===t.id?"#ECEEF2":"#9AA1AC",
            border:"none",borderBottom:subTabProy===t.id?"2px solid #ECEEF2":"2px solid transparent",
            padding:"8px 16px",fontSize:12,fontWeight:subTabProy===t.id?700:400,
            cursor:"pointer",fontFamily:"inherit",
          }}>{t.label}</button>
        ))}
      </div>
      {subTabProy==="estrategia"&&<EstrategiaProyectosTab projects={projects} ing={ing||ingresos} cv={cv||customers} bp={bp||{}} hojas={hojas}/>}
      {subTabProy==="proyectos"&&<div>
      {/* Rename modal */}
      {renameModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#1F232B",borderRadius:16,padding:"28px 32px",maxWidth:480,width:"92%",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 24px 64px rgba(0,0,0,0.5)"}}>
            <div style={{fontWeight:700,fontSize:14,color:"#ECEEF2",marginBottom:2,letterSpacing:"-0.3px"}}>Editar proyecto</div>
            <div style={{fontSize:11,color:"#7F8692",marginBottom:20}}>Las horas registradas en este proyecto pasan al nombre nuevo</div>
            
            <div style={{fontSize:11,fontWeight:600,color:"#9AA1AC",letterSpacing:"0",marginBottom:6}}>Nombre</div>
            <input value={renameModal.tmpName} onChange={e=>setRenameModal(r=>({...r,tmpName:e.target.value}))}
              onKeyDown={e=>e.key==="Enter"&&doRename()}
              autoFocus
              style={{width:"100%",border:"1.5px solid #2E343E",borderRadius:8,padding:"10px 12px",fontSize:13,fontFamily:"inherit",outline:"none",boxSizing:"border-box",marginBottom:20,color:"#ECEEF2"}}/>

            <div style={{fontSize:11,fontWeight:600,color:"#9AA1AC",letterSpacing:"0",marginBottom:10}}>Color de la tarjeta</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
              {["#D5D9E0","#0F4C75","#1A1A2E","#2D6A4F","#1B4332","#4A1942","#7B2D00","#1D3557","#003049","#370617","#3D405B","#2C3E50"].map(c=>(
                <button key={c} onClick={()=>setRenameModal(r=>({...r,tmpColor:c,tmpLight:c+"18"}))}
                  style={{width:26,height:26,borderRadius:6,background:c,border:renameModal.tmpColor===c?"3px solid #111":"2px solid #2E343E",cursor:"pointer",transition:"transform .1s",transform:renameModal.tmpColor===c?"scale(1.15)":"scale(1)"}}/>
              ))}
              {["#E8501C","#8B5CF6","#EC4899","#EF4444","#F97316","#EAB308","#22C55E","#14B8A6","#0EA5E9","#9AA1AC"].map(c=>(
                <button key={c} onClick={()=>setRenameModal(r=>({...r,tmpColor:c,tmpLight:c+"22"}))}
                  style={{width:26,height:26,borderRadius:6,background:c,border:renameModal.tmpColor===c?"3px solid #111":"2px solid #2E343E",cursor:"pointer",transition:"transform .1s",transform:renameModal.tmpColor===c?"scale(1.15)":"scale(1)"}}/>
              ))}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:20}}>
              <div style={{fontSize:10,color:"#7F8692"}}>Personalizado:</div>
              <input type="color" value={renameModal.tmpColor} onChange={e=>setRenameModal(r=>({...r,tmpColor:e.target.value,tmpLight:e.target.value+"22"}))}
                style={{width:32,height:26,border:"1.5px solid #2E343E",borderRadius:6,padding:2,cursor:"pointer",background:"none"}}/>
              <div style={{width:60,height:26,borderRadius:6,background:renameModal.tmpColor,border:"1px solid #2E343E"}}/>
            </div>

            <div style={{fontSize:11,fontWeight:600,color:"#9AA1AC",marginBottom:8}}>Participantes</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:22,maxHeight:180,overflowY:"auto"}}>
              {MIEMBROS_VISIBLES.map(m=>{
                const on=(renameModal.tmpEquipo||[]).includes(m.name);
                return(
                  <button key={m.name} type="button" aria-pressed={on}
                    onClick={()=>setRenameModal(r=>({...r,tmpEquipo:on?(r.tmpEquipo||[]).filter(x=>x!==m.name):[...(r.tmpEquipo||[]),m.name]}))}
                    style={{display:"inline-flex",alignItems:"center",gap:6,background:on?m.color+"2E":"transparent",color:on?m.color:"#9AA1AC",
                      border:`1px solid ${on?m.color+"88":"#2E343E"}`,borderRadius:99,padding:"4px 10px 4px 4px",fontSize:11.5,fontWeight:on?600:500,cursor:"pointer",fontFamily:"inherit"}}>
                    <span style={{width:18,height:18,borderRadius:99,background:on?m.color:"#2E343E",color:on?"#15181D":"#9AA1AC",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700}}>{on?"✓":m.name[0]}</span>
                    {m.name}
                  </button>
                );
              })}
            </div>

            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>setRenameModal(null)} style={{background:"#262B34",color:"#C3C8D0",border:"none",borderRadius:8,padding:"9px 18px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
              <button onClick={doRename} disabled={renaming} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"9px 20px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:renaming?0.6:1,letterSpacing:"0.1px"}}>
                {renaming?"Guardando...":"Guardar cambios"}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDelete&&confirmDelete.trim()&&(
        <div style={{position:"fixed",inset:0,background:"#0008",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#1F232B",borderRadius:14,padding:"28px 28px 22px",maxWidth:360,width:"90%",boxShadow:"0 8px 40px #0004"}}>
            <div style={{fontSize:22,marginBottom:10}}>⚠️</div>
            <div style={{fontWeight:700,fontSize:14,color:"#ECEEF2",marginBottom:8}}>¿Eliminar proyecto?</div>
            <div style={{fontSize:12,color:"#9AA1AC",marginBottom:22,lineHeight:1.6}}>
              Vas a eliminar <strong>"{confirmDelete}"</strong>. Se borrarán todos sus datos del CRM y no podrás recuperarlos.
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
              <button onClick={()=>setConfirmDelete(null)} style={{background:"#262B34",color:"#B4BAC4",border:"none",borderRadius:8,padding:"9px 20px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
              <button onClick={confirmAndDelete} style={{background:"#EF4444",color:"#FFF",border:"none",borderRadius:8,padding:"9px 20px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Sí, eliminar</button>
            </div>
          </div>
        </div>
      )}
      {/* Visibility panel */}
      {showVisibilityPanel&&(
        <div style={{background:"#1F232B",borderRadius:12,padding:"16px 18px",marginBottom:12,border:"1px solid #2E343E"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontWeight:700,fontSize:13,color:"#ECEEF2"}}>👁 Visibilidad de proyectos</div>
            <button onClick={()=>setShowVisibilityPanel(false)} style={{background:"none",border:"none",fontSize:12,color:"#9AA1AC",cursor:"pointer",fontFamily:"inherit"}}>✕ Cerrar</button>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {all1Projects.map(p=>{
              const hidden=hiddenProjects.includes(p.name);
              return(
                <button key={p.name} onClick={()=>toggleHide(p.name)} style={{
                  background:hidden?"#15181D":p.color,
                  color:hidden?"#9AA1AC":"#FFF",
                  border:`1.5px solid ${hidden?"#2E343E":p.color}`,
                  borderRadius:8,padding:"6px 14px",fontSize:11,fontWeight:700,
                  cursor:"pointer",fontFamily:"inherit",
                  opacity:hidden?0.6:1,
                  textDecoration:hidden?"line-through":"none",
                  transition:"all .15s",
                }}>
                  {hidden?"🚫 ":""}{p.name}
                </button>
              );
            })}
          </div>
          {hiddenProjects.length>0&&(
            <button onClick={()=>setHiddenProjects([])}
              style={{marginTop:10,background:"none",border:"none",fontSize:10,color:"#9AA1AC",cursor:"pointer",fontFamily:"inherit",textDecoration:"underline"}}>
              Mostrar todos
            </button>
          )}
        </div>
      )}
      <div style={{background:"#1F232B",borderRadius:12,padding:"16px 18px",marginBottom:16,border:"1px solid #2E343E"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontWeight:700,fontSize:13,color:"#ECEEF2"}}>➕ Nuevo proyecto</div>
          <button onClick={()=>setShowVisibilityPanel(v=>!v)} style={{background:"#15181D",border:"1px solid #2E343E",borderRadius:7,padding:"5px 12px",fontSize:11,fontWeight:600,color:"#C3C8D0",cursor:"pointer",fontFamily:"inherit"}}>
            👁 Visibilidad {hiddenProjects.length>0?`(${hiddenProjects.length} ocultos)`:""}
          </button>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
          <div style={{flex:1,minWidth:160}}>
            <div style={{fontSize:10,color:"#9AA1AC",marginBottom:4}}>Nombre</div>
            <Inp value={newName} onChange={v=>{setNewName(v);setErr("");}} placeholder="Nombre del proyecto"/>
          </div>
          <div>
            <div style={{fontSize:10,color:"#9AA1AC",marginBottom:4}}>Color principal</div>
            <input type="color" value={newColor} onChange={e=>setNewColor(e.target.value)} style={{width:44,height:32,border:"1px solid #2E343E",borderRadius:5,cursor:"pointer",padding:2}}/>
          </div>
          <div>
            <div style={{fontSize:10,color:"#9AA1AC",marginBottom:4}}>Color fondo</div>
            <input type="color" value={newLight} onChange={e=>setNewLight(e.target.value)} style={{width:44,height:32,border:"1px solid #2E343E",borderRadius:5,cursor:"pointer",padding:2}}/>
          </div>
          <button onClick={addProject} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>Crear proyecto</button>
        </div>
        <div style={{marginTop:14}}>
          <div style={{fontSize:12,color:"#C3C8D0",fontWeight:600,marginBottom:2}}>¿Quién participa?</div>
          <div style={{fontSize:11,color:"#7F8692",marginBottom:8}}>Toca los nombres de las personas que van a trabajar en este proyecto.</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {MIEMBROS_VISIBLES.map(m=>{
              const on=participantes.includes(m.name);
              return(
                <button key={m.name} type="button" aria-pressed={on} onClick={()=>{toggleParticipante(m.name);setErr("");}}
                  style={{display:"inline-flex",alignItems:"center",gap:6,background:on?m.color+"2E":"transparent",color:on?m.color:"#9AA1AC",
                    border:`1px solid ${on?m.color+"88":"#2E343E"}`,borderRadius:99,padding:"5px 12px 5px 6px",fontSize:12,fontWeight:on?600:500,cursor:"pointer",fontFamily:"inherit"}}>
                  <span style={{width:20,height:20,borderRadius:99,background:on?m.color:"#2E343E",color:on?"#15181D":"#9AA1AC",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700}}>{on?"✓":m.name[0]}</span>
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>
        {err&&<div style={{color:"#F26D6D",fontSize:11,marginTop:8}}>⚠ {err}</div>}
        {newName&&<div style={{marginTop:10,display:"inline-flex",alignItems:"center",gap:8,background:newLight,border:`2px solid ${newColor}`,borderRadius:8,padding:"6px 14px"}}>
          <div style={{width:10,height:10,borderRadius:99,background:newColor}}/>
          <span style={{fontWeight:700,fontSize:12,color:newColor}}>{newName}</span>
        </div>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
        {visibleProjects.map(p=>{
          const s=projStats(p.name),neto=s.ing-s.gas;
          const bg=p.color+"18"||"#2A2F38";
          const textColor=p.color||"#ECEEF2";
          return(
            <div key={p.name}
              style={{background:bg,borderRadius:16,padding:"18px 20px",cursor:"pointer",position:"relative",transition:"transform .15s",border:"none"}}
              onMouseEnter={e=>e.currentTarget.style.transform="translateY(-2px)"}
              onMouseLeave={e=>e.currentTarget.style.transform="translateY(0)"}>
              {/* Actions - completely separate from card click */}
              {puedoGestionar()&&<div style={{position:"absolute",top:12,right:12,display:"flex",gap:4,zIndex:2}}>
                <button
                  onPointerDown={e=>e.stopPropagation()}
                  onClick={e=>{e.preventDefault();e.stopPropagation();setRenameModal({proj:p,tmpName:p.name,tmpColor:p.color||"#ECEEF2",tmpLight:p.light||"#2A2F38",tmpEquipo:[...(equipos[p.name]||[])]});}}
                  style={{background:"rgba(255,255,255,0.08)",border:"none",color:textColor,borderRadius:6,width:28,height:28,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button
                  onPointerDown={e=>e.stopPropagation()}
                  onClick={e=>{e.preventDefault();e.stopPropagation();if(p.name&&p.name.trim())setConfirmDelete(p.name);}}
                  style={{background:"rgba(255,255,255,0.08)",border:"none",color:textColor,borderRadius:6,width:28,height:28,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>}
              {/* Clickable body */}
              <div style={{cursor:"pointer"}} onClick={()=>setSelectedProject(p.name)}>
              {/* Header */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,color:textColor,fontWeight:600,letterSpacing:"0",opacity:0.7,marginBottom:4}}>{p.name}</div>
                <div style={{fontSize:28,fontWeight:500,color:textColor,letterSpacing:"-1.5px",lineHeight:1}}>{s.ing>0?s.ing.toFixed(0)+"€":s.cv+" CV"}</div>
                <div style={{fontSize:11,color:textColor,opacity:0.6,marginTop:4}}>
                  {s.ing>0?`Neto ${neto>=0?"+":""}${neto.toFixed(0)}€ · ${s.cv} CV`:`Sin ingresos registrados`}
                </div>
              </div>
              {/* Mini stats */}
              <div style={{display:"flex",gap:16}}>
                {[
                  {label:"CV",val:s.cv},
                  {label:"Gastos",val:s.gas>0?s.gas.toFixed(0)+"€":"—"},
                  {label:"CRM",val:s.ventas},
                ].map(k=>(
                  <div key={k.label} style={{textAlign:"center"}}>
                    <div style={{fontSize:14,fontWeight:500,color:textColor}}>{k.val}</div>
                    <div style={{fontSize:9,color:textColor,opacity:0.55,letterSpacing:"0.3px"}}>{k.label}</div>
                  </div>
                ))}
              </div>
              {(equipos[p.name]||[]).length>0&&(
                <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:14,paddingTop:12,borderTop:`1px solid ${textColor}22`}}>
                  {(equipos[p.name]||[]).map(n=>{
                    const mc=INIT_MEMBERS.find(x=>x.name===n)?.color||"#9AA1AC";
                    return <span key={n} style={{display:"inline-flex",alignItems:"center",gap:5,background:"rgba(0,0,0,.22)",borderRadius:99,padding:"3px 9px 3px 4px",fontSize:11,color:"#ECEEF2",fontWeight:500}}>
                      <span style={{width:16,height:16,borderRadius:99,background:mc,color:"#15181D",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700}}>{n[0]}</span>{n}
                    </span>;
                  })}
                </div>
              )}
              </div>{/* end clickable body */}
            </div>
          );
        })}
      </div>

      {/* Project detail modal */}
      {selectedProject&&(()=>{
        const p = projects.find(x=>x.name===selectedProject);
        if(!p) return null;
        const pCVs = Object.values(customers).flat().filter(r=>r.proyecto===selectedProject&&!r.linkedFrom);
        const pIng = ingresos.filter(r=>r.proyecto===selectedProject);
        const pGas = gastos.filter(r=>r.proyecto===selectedProject);
        const pHojas = hojas.filter(r=>r.proyecto===selectedProject);
        const pCRM = [...(crm[selectedProject]?.g1?.rows||[]),...(crm[selectedProject]?.g2?.rows||[])];
        const totIng = pIng.reduce((s,r)=>s+signedBase(r),0);
        const totGas = pGas.reduce((s,r)=>s+signedBase(r),0)+pHojas.reduce((s,r)=>{
          const prows=r.proyectos&&r.proyectos.length>0?r.proyectos:[{proyecto:r.proyecto||"",importe:r.importe_proyecto||r.importe||""}];
          const match=prows.find(p=>p.proyecto===selectedProject);
          return s+(match?parseFloat(match.importe)||0:0);
        },0);
        const sortRef = arr=>[...arr].sort((a,b)=>{const m=s=>s?.ref?.match(/(\d+)$/);const na=m(a)?parseInt(m(a)[1]):9999,nb=m(b)?parseInt(m(b)[1]):9999;return na-nb;});
        return(
          <ProjectModal p={p} pCVs={pCVs} pIng={pIng} pGas={pGas} pHojas={pHojas} totIng={totIng} totGas={totGas} sortRef={sortRef} onClose={()=>setSelectedProject(null)} pCRM={pCRM}/>
        );
      })()}
      </div>}
    </div>
  );
}


// ── CHECKPOINTS TAB ───────────────────────────────────────────────────────────
function CheckpointsTab({bp,setBP,bpGroups,setBPGroups,cv,setCV,cvGroups,setCVGroups,projects,ing,gas,hojas}){
  const [sub,setSub]=useState("bookpoints");
  return(
    <div>
      <div style={{display:"flex",gap:0,borderBottom:"1px solid #2E343E",marginBottom:20}}>
        {[{id:"bookpoints",label:"📚 Bookpoints"},{id:"customers",label:"🤝 Customers"}].map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)} style={{
            background:"transparent",color:sub===t.id?"#D5D9E0":"#9AA1AC",border:"none",
            borderBottom:sub===t.id?"2px solid #1C1C1E":"2px solid transparent",
            padding:"8px 14px",fontSize:11,fontWeight:sub===t.id?700:400,
            cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",
          }}>{t.label}</button>
        ))}
      </div>
      {sub==="bookpoints"&&<BookpointsTab data={bp} setData={setBP} groups={bpGroups} setGroups={setBPGroups}/>}
      {sub==="customers" &&<CustomersTab  data={cv} setData={setCV} projects={projects} groups={cvGroups} setGroups={setCVGroups}/>}
    </div>
  );
}

// ── BOOKPOINTS — link motorola en cada libro ───────────────────────────────────
function GroupManager({groups,setGroups,color}){
  const [editing,setEditing]=useState(null);
  const [newName,setNewName]=useState("");
  function addGroup(){
    const n=newName.trim();
    if(!n)return;
    setGroups(gs=>[...gs,{id:Date.now(),name:n}]);
    setNewName("");
  }
  function renameGroup(id,name){setGroups(gs=>gs.map(g=>g.id===id?{...g,name}:g));}
  function deleteGroup(id){
    if(!window.confirm&&true){
      setGroups(gs=>gs.filter(g=>g.id!==id));
    } else {
      setGroups(gs=>gs.filter(g=>g.id!==id));
    }
  }
  return(
    <div style={{background:"#232831",borderRadius:9,padding:"10px 12px",marginBottom:12,border:"1px solid #2E343E"}}>
      <div style={{fontSize:10,fontWeight:700,color:"#B4BAC4",marginBottom:8,letterSpacing:"0"}}>GRUPOS</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
        {groups.map(g=>(
          <div key={g.id} style={{display:"flex",alignItems:"center",gap:4,background:"#1F232B",border:`1.5px solid ${color}44`,borderRadius:7,padding:"3px 8px"}}>
            {editing===g.id
              ? <input autoFocus value={g.name} onChange={e=>renameGroup(g.id,e.target.value)}
                  onBlur={()=>setEditing(null)} onKeyDown={e=>{if(e.key==="Enter")setEditing(null);}}
                  style={{border:"none",outline:"none",fontSize:11,fontWeight:700,color:color,width:90,background:"transparent",fontFamily:"inherit"}}/>
              : <span onClick={()=>setEditing(g.id)} style={{fontSize:11,fontWeight:700,color:color,cursor:"text"}}>{g.name}</span>
            }
            <button onClick={()=>deleteGroup(g.id)} style={{background:"none",border:"none",color:"#5C6370",cursor:"pointer",fontSize:11,padding:"0 2px",lineHeight:1}}>✕</button>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:6}}>
        <input value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addGroup();}}
          placeholder="Nuevo grupo..." style={{border:"1px solid #2E343E",borderRadius:6,padding:"4px 9px",fontSize:11,fontFamily:"inherit",outline:"none",flex:1}}/>
        <button onClick={addGroup} style={{background:color,color:"#FFF",border:"none",borderRadius:6,padding:"4px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Añadir</button>
      </div>
    </div>
  );
}

function BookpointsTab({data,setData,groups,setGroups}){
  const add=(m,grp)=>setData(d=>({...d,[m]:[...d[m],{id:Date.now(),grupo:grp||"",autor:"",libro:"",topic:"",puntos:"",fecha:"",essay:"",linkMotorola:"",cc:""}]}));
  const upd=(m,id,f,v)=>setData(d=>({...d,[m]:d[m].map(r=>r.id===id?{...r,[f]:v}:r)}));
  const del=(m,id)=>setData(d=>({...d,[m]:d[m].filter(r=>r.id!==id)}));
  const groupOptions=groups.map(g=>g.name);

  return(
    <div>
      <GroupManager groups={groups} setGroups={setGroups} color="#E8501C"/>
      {INIT_MEMBERS.map(m=>{
        const rows=data[m.name]||[],pts=rows.reduce((s,r)=>s+(parseFloat(r.puntos)||0),0);
        // group rows
        const noGroup=rows.filter(r=>!r.grupo||!groups.find(g=>g.name===r.grupo));
        const byGroup=groups.map(g=>({g,rows:rows.filter(r=>r.grupo===g.name)}));
        return(
          <Block key={m.name} name={m.name} color={m.color} light={m.light} badge={`${pts}/${META_BP} pts`}>
            <div style={{marginBottom:10}}><ProgressBar val={pts} max={META_BP} color="#E8501C"/></div>
            {/* Grouped rows */}
            {byGroup.map(({g,rows:grows})=>(
              <div key={g.id} style={{marginBottom:10}}>
                <div style={{fontSize:10,fontWeight:700,color:"#E8501C",marginBottom:5,display:"flex",alignItems:"center",gap:6}}>
                  <span style={{background:"#452311",borderRadius:5,padding:"2px 9px"}}>{g.name}</span>
                  <span style={{color:"#7F8692",fontWeight:400}}>({grows.length} libros · {grows.reduce((s,r)=>s+(parseFloat(r.puntos)||0),0)} pts)</span>
                </div>
                {grows.length>0&&<BPTable rows={grows} mname={m.name} mcolor={m.color} upd={upd} del={del} groupOptions={groupOptions}/>}
                <AddBtn onClick={()=>add(m.name,g.name)} label={`+ Añadir en ${g.name}`}/>
              </div>
            ))}
            {/* Unassigned rows */}
            {noGroup.length>0&&(
              <div style={{marginBottom:8}}>
                <div style={{fontSize:10,fontWeight:700,color:"#7F8692",marginBottom:5}}>Sin grupo</div>
                <BPTable rows={noGroup} mname={m.name} mcolor={m.color} upd={upd} del={del} groupOptions={groupOptions}/>
              </div>
            )}
            <AddBtn onClick={()=>add(m.name,"")}/>
          </Block>
        );
      })}
    </div>
  );
}

function BPTable({rows,mname,mcolor,upd,del,groupOptions}){
  const parseD=f=>{if(!f)return 0;const[d,m,y]=f.split("/");return new Date(y,m-1,d).getTime();};
  const sorted=[...rows].sort((a,b)=>parseD(b.fecha)-parseD(a.fecha));
  return(
    <div style={{overflowX:"auto",marginBottom:6}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <THead cols={["Grupo","Autor","Libro","Topic","Pts","Fecha","Essay","CC",""]} color={mcolor}/>
        <tbody>
          {sorted.map((r,i)=>(
            <tr key={r.id} style={{background:i%2===0?"#FFFFFF88":"transparent"}}>
              <td style={{padding:"3px 5px"}}><Sel value={r.grupo} onChange={v=>upd(mname,r.id,"grupo",v)} options={groupOptions} placeholder="Sin grupo"/></td>
              <td style={{padding:"3px 5px"}}><Inp value={r.autor}       onChange={v=>upd(mname,r.id,"autor",v)}       placeholder="Autor"/></td>
              <td style={{padding:"3px 5px"}}><Inp value={r.libro}       onChange={v=>upd(mname,r.id,"libro",v)}       placeholder="Título"/></td>
              <td style={{padding:"3px 5px"}}><Sel value={r.topic}       onChange={v=>upd(mname,r.id,"topic",v)}       options={TOPICS}/></td>
              <td style={{padding:"3px 5px"}}><Inp value={r.puntos}      onChange={v=>upd(mname,r.id,"puntos",v)}      placeholder="0" w="50px" bold color="#1D4ED8"/></td>
              <td style={{padding:"3px 5px"}}><DateInp value={r.fecha||""} onChange={v=>upd(mname,r.id,"fecha",v)} w="110px"/></td>
              <td style={{padding:"3px 5px"}}><LinkInp value={r.essay}   onChange={v=>upd(mname,r.id,"essay",v)}       placeholder="Essay link"/></td>
              <td style={{padding:"3px 5px"}}><Sel value={r.cc}          onChange={v=>upd(mname,r.id,"cc",v)}          options={CC_OPTS}/></td>
              <td style={{padding:"3px 5px"}}><DelBtn onClick={()=>del(mname,r.id)}/></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── CUSTOMERS — link motorola por visita ──────────────────────────────────────
function CompanerosPopup({selected, exclude, onChange}){
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({top:0,left:0,openUp:false});
  const btnRef = useRef(null);
  const count = selected.length;

  function handleOpen(){
    if(!open && btnRef.current){
      const rect = btnRef.current.getBoundingClientRect();
      const openUp = rect.top > window.innerHeight / 2;
      setPos({top: rect.bottom, bottom: window.innerHeight - rect.top, left: Math.min(rect.left, window.innerWidth-180), openUp});
    }
    setOpen(o=>!o);
  }

  return(
    <div style={{position:"relative",display:"inline-block"}}>
      <button ref={btnRef} onClick={handleOpen}
        style={{background:count>0?"#452311":"#232831",border:`1.5px solid ${count>0?"#E8501C":"#2E343E"}`,
          borderRadius:8,padding:"4px 9px",cursor:"pointer",fontFamily:"inherit",
          display:"flex",alignItems:"center",gap:5,fontSize:11,fontWeight:700,
          color:count>0?"#E8501C":"#7F8692"}}>
        <span>👥</span>
        {count>0?(
          <span style={{display:"flex",gap:2}}>
            {selected.map(name=>{
              const m=INIT_MEMBERS.find(x=>x.name===name);
              return <span key={name} style={{background:m?.color,color:"#FFF",borderRadius:99,padding:"1px 6px",fontSize:9,fontWeight:700}}>{name.slice(0,3)}</span>;
            })}
          </span>
        ):<span>Añadir</span>}
      </button>
      {open&&(
        <>
          <div style={{position:"fixed",inset:0,zIndex:9998}} onClick={()=>setOpen(false)}/>
          <div style={{
            position:"fixed",
            top: pos.openUp ? "auto" : pos.top+4,
            bottom: pos.openUp ? (window.innerHeight - pos.top + 4) : "auto",
            left: Math.min(pos.left, window.innerWidth-180),
            background:"#1F232B",borderRadius:10,boxShadow:"0 8px 32px #0003",
            padding:"10px",minWidth:160,zIndex:9999,maxHeight:300,overflowY:"auto"
          }} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:8,paddingBottom:6,borderBottom:"1px solid #2E343E"}}>
              Seleccionar compañeros
            </div>
            {INIT_MEMBERS.filter(m=>m.name!==exclude).map(m=>{
              const sel=selected.includes(m.name);
              return(
                <div key={m.name} onClick={()=>{
                  const next=sel?selected.filter(x=>x!==m.name):[...selected,m.name];
                  onChange(next);
                }} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",borderRadius:7,
                  cursor:"pointer",background:sel?m.light:"transparent",marginBottom:2,
                  border:`1px solid ${sel?m.color+"44":"transparent"}`}}>
                  <div style={{width:24,height:24,borderRadius:99,background:m.color,
                    display:"flex",alignItems:"center",justifyContent:"center",
                    color:"#FFF",fontSize:10,fontWeight:700,flexShrink:0}}>
                    {m.name[0]}
                  </div>
                  <span style={{fontSize:12,fontWeight:sel?700:500,color:sel?m.color:"#B4BAC4"}}>{m.name}</span>
                  {sel&&<span style={{marginLeft:"auto",color:m.color,fontSize:12}}>✓</span>}
                </div>
              );
            })}
            <button onClick={()=>setOpen(false)}
              style={{width:"100%",marginTop:8,background:"#323844",color:"#FFF",border:"none",
                borderRadius:7,padding:"6px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
              Listo
            </button>
          </div>
        </>
      )}
    </div>
  );
}
function CVTable({rows,mname,mcolor,upd,del,projects,groupOptions}){
  const parseD=f=>{if(!f)return 0;const[d,m,y]=f.split("/");return new Date(y,m-1,d).getTime();};
  const sorted=[...rows].sort((a,b)=>parseD(b.fecha)-parseD(a.fecha));
  return(
    <div style={{overflowX:"auto",marginBottom:6}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <THead cols={["Grupo","Fecha","CV/LV","Motorola","Cliente","Link Motorola","Proyecto","👥",""]} color={mcolor}/>
        <tbody>
          {sorted.map((r,i)=>(
            <tr key={r.id} style={{background:i%2===0?"#FFFFFF88":"transparent"}}>
              <td style={{padding:"3px 5px"}}><Sel value={r.grupo} onChange={v=>upd(mname,r.id,"grupo",v)} options={groupOptions} placeholder="Sin grupo"/></td>
              <td style={{padding:"3px 5px"}}><DateInp value={r.fecha||""} onChange={v=>upd(mname,r.id,"fecha",v)} w="110px"/></td>
              <td style={{padding:"3px 5px"}}><Sel value={r.cat}            onChange={v=>upd(mname,r.id,"cat",v)}            options={["CV","LV"]}/></td>
              <td style={{padding:"3px 5px"}}><Sel value={r.motorola}       onChange={v=>upd(mname,r.id,"motorola",v)}       options={["Sí","No"]}/></td>
              <td style={{padding:"3px 5px"}}><Inp value={r.cliente}        onChange={v=>upd(mname,r.id,"cliente",v)}        placeholder="Empresa"/></td>
              <td style={{padding:"3px 5px"}}><LinkInp value={r.linkMotorola} onChange={v=>upd(mname,r.id,"linkMotorola",v)} placeholder="Link motorola"/></td>
              <td style={{padding:"3px 5px"}}><Sel value={r.proyecto}       onChange={v=>upd(mname,r.id,"proyecto",v)}       options={projects.map(p=>p.name)}/></td>
              <td style={{padding:"3px 5px",position:"relative"}}>
                {r.linkedFrom?(
                  <span style={{fontSize:9,color:"#7F8692",fontStyle:"italic"}}>↗ {r.linkedOwner}</span>
                ):(
                  <CompanerosPopup
                    selected={r.companeros||[]}
                    exclude={mname}
                    onChange={v=>upd(mname,r.id,"companeros",v)}
                  />
                )}
              </td>
              <td style={{padding:"3px 5px"}}><DelBtn onClick={()=>del(mname,r.id)}/></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CustomersTab({data,setData,projects,groups,setGroups}){
  // When adding a CV, also add a linked copy to teammates
  function add(m, grp){
    const newId = Date.now();
    const newRow = {id:newId, grupo:grp||"", fecha:"", cat:"", motorola:"", quien:"", cliente:"", linkMotorola:"", proyecto:"", companeros:[], linkedFrom:null};
    setData(d=>({...d,[m]:[...d[m],newRow]}));
  }
  function upd(m, id, f, v){
    setData(d=>{
      const next = {...d,[m]:d[m].map(r=>r.id===id?{...r,[f]:v}:r)};
      // If updating companeros, sync linked rows to teammates
      if(f==="companeros"){
        const row = next[m].find(r=>r.id===id);
        const prevRow = d[m].find(r=>r.id===id);
        const prevComp = prevRow?.companeros||[];
        const newComp = v||[];
        // Remove from teammates no longer selected
        prevComp.filter(c=>!newComp.includes(c)).forEach(c=>{
          next[c] = (next[c]||[]).filter(r=>r.linkedFrom!==id);
        });
        // Add to new teammates
        newComp.filter(c=>!prevComp.includes(c)).forEach(c=>{
          const linked = {...row, id:Math.floor(Date.now()+Math.random()*1000), companeros:[], linkedFrom:id, linkedOwner:m};
          next[c] = [...(next[c]||[]), linked];
        });
        // Update existing linked rows with latest data
        newComp.filter(c=>prevComp.includes(c)).forEach(c=>{
          next[c] = (next[c]||[]).map(r=>r.linkedFrom===id?{...row,id:r.id,companeros:[],linkedFrom:id,linkedOwner:m}:r);
        });
      }
      // If updating any other field, sync to linked copies
      if(f!=="companeros"){
        const row = next[m].find(r=>r.id===id);
        if(row?.companeros?.length){
          row.companeros.forEach(c=>{
            next[c] = (next[c]||[]).map(r=>r.linkedFrom===id?{...r,[f]:v}:r);
          });
        }
      }
      return next;
    });
  }
  function del(m, id){
    setData(d=>{
      const row = d[m].find(r=>r.id===id);
      const next = {...d,[m]:d[m].filter(r=>r.id!==id)};
      // Remove linked copies from teammates
      if(row?.companeros?.length){
        row.companeros.forEach(c=>{
          next[c] = (next[c]||[]).filter(r=>r.linkedFrom!==id);
        });
      }
      return next;
    });
  }

  const groupOptions=groups.map(g=>g.name);
  return(
    <div>
      <GroupManager groups={groups} setGroups={setGroups} color="#0EA5E9"/>
      {INIT_MEMBERS.map(m=>{
        const rows=data[m.name]||[];
        const cv=rows.filter(r=>r.cat==="CV").length,lv=rows.filter(r=>r.cat==="LV").length,tot=cv+lv;
        const noGroup=rows.filter(r=>!r.grupo||!groups.find(g=>g.name===r.grupo));
        const byGroup=groups.map(g=>({g,rows:rows.filter(r=>r.grupo===g.name)}));
        return(
          <Block key={m.name} name={m.name} color={m.color} light={m.light} badge={`CV:${cv} · LV:${lv} · ${cv}/${META_CV}`}>
            <div style={{marginBottom:10}}><ProgressBar val={cv} max={META_CV} color="#0EA5E9"/></div>
            {byGroup.map(({g,rows:grows})=>(
              <div key={g.id} style={{marginBottom:10}}>
                <div style={{fontSize:10,fontWeight:700,color:"#0EA5E9",marginBottom:5,display:"flex",alignItems:"center",gap:6}}>
                  <span style={{background:"#113145",borderRadius:5,padding:"2px 9px"}}>{g.name}</span>
                  <span style={{color:"#7F8692",fontWeight:400}}>({grows.filter(r=>r.cat==="CV").length} CV · {grows.filter(r=>r.cat==="LV").length} LV)</span>
                </div>
                {grows.length>0&&<CVTable rows={grows} mname={m.name} mcolor={m.color} upd={upd} del={del} projects={projects} groupOptions={groupOptions}/>}
                <AddBtn onClick={()=>add(m.name,g.name)} label={`+ Añadir en ${g.name}`}/>
              </div>
            ))}
            {noGroup.length>0&&(
              <div style={{marginBottom:8}}>
                <div style={{fontSize:10,fontWeight:700,color:"#7F8692",marginBottom:5}}>Sin grupo</div>
                <CVTable rows={noGroup} mname={m.name} mcolor={m.color} upd={upd} del={del} projects={projects} groupOptions={groupOptions}/>
              </div>
            )}
            <AddBtn onClick={()=>add(m.name,"")}/>
          </Block>
        );
      })}
    </div>
  );
}

// ── MODAL APROBACIÓN FACTURA ─────────────────────────────────────────────────
const TIPOS_FAC = [
  {id:"FC",  label:"FC — Factura completa"},
  {id:"FS",  label:"FS — Simplificada"},
  {id:"FRC", label:"FRC — Rectificativa"},
  {id:"FRP", label:"FRP — Recapitulativa"},
];
function AprobarFacturaModal({factura, facturas, onConfirm, onCancel}){
  const year = new Date().getFullYear();
  function siguienteRef(tipo){
    const ex=(facturas||[]).filter(f=>(f.ref||"").startsWith(tipo+year+"/"));
    const nums=ex.map(f=>{const m=(f.ref||"").match(/(\d+)$/);return m?parseInt(m[1]):0;});
    return `${tipo}${year}/${(nums.length>0?Math.max(...nums):0)+1}`;
  }
  const [tipoSel, setTipoSel] = useState("FC");
  const [pdf, setPdf] = useState(factura.linkFactura||"");
  const [refEdit, setRefEdit] = useState(()=>siguienteRef("FC"));
  function selectTipo(t){
    setTipoSel(t);
    setRefEdit(siguienteRef(t));
  }
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#1F232B",borderRadius:14,padding:24,maxWidth:420,width:"95%",boxShadow:"0 8px 32px rgba(0,0,0,0.15)"}}>
        <div style={{fontWeight:800,fontSize:14,color:"#ECEEF2",marginBottom:4}}>✅ Aprobar factura</div>
        <div style={{fontSize:11,color:"#9AA1AC",marginBottom:16}}>{factura.descripcion||"Sin descripción"} · {factura.base||"—"}€</div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,fontWeight:700,color:"#C3C8D0",letterSpacing:"0",marginBottom:8}}>Tipo de factura</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            {TIPOS_FAC.map(t=>(
              <button key={t.id} onClick={()=>selectTipo(t.id)} style={{
                background:tipoSel===t.id?"#323844":"#262B34",
                color:tipoSel===t.id?"#FFF":"#C3C8D0",
                border:`1.5px solid ${tipoSel===t.id?"#262B34":"#2E343E"}`,
                borderRadius:8,padding:"8px 10px",fontSize:11,fontWeight:tipoSel===t.id?700:400,
                cursor:"pointer",fontFamily:"inherit",textAlign:"left",
              }}>{t.label}</button>
            ))}
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,fontWeight:700,color:"#C3C8D0",letterSpacing:"0",marginBottom:6}}>Archivo de la factura (PDF) *</div>
          <PdfCell value={pdf} onChange={setPdf}/>
        </div>
        <div style={{marginBottom:20}}>
          <div style={{fontSize:10,fontWeight:700,color:"#C3C8D0",letterSpacing:"0",marginBottom:6}}>Referencia asignada</div>
          <input value={refEdit} onChange={e=>setRefEdit(e.target.value)}
            style={{width:"100%",border:"1.5px solid #2E343E",borderRadius:8,padding:"8px 12px",fontSize:16,fontWeight:700,fontFamily:"inherit",color:"#D5D9E0",outline:"none",boxSizing:"border-box"}}/>
          <div style={{fontSize:10,color:"#7F8692",marginTop:4}}>Correlativo siguiente para {tipoSel}: <b>{siguienteRef(tipoSel)}</b></div>
        </div>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button onClick={onCancel}
            style={{background:"#262B34",color:"#C3C8D0",border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
            Cancelar
          </button>
          <button disabled={!pdf} title={pdf?"":"Sube el PDF de la factura"} onClick={()=>onConfirm({...factura,ref:refEdit,linkFactura:pdf,_pendiente:undefined,_fileNombre:undefined})}
            style={{background:pdf?"#059669":"#969CA6",color:"#FFF",border:"none",borderRadius:8,padding:"8px 20px",fontSize:12,fontWeight:700,cursor:pdf?"pointer":"not-allowed",fontFamily:"inherit"}}>
            ✅ Confirmar y añadir
          </button>
        </div>
      </div>
    </div>
  );
}

// ── FINANCE — link factura ────────────────────────────────────────────────────
// ── FACTURAS TAB — por proyecto con reparto ───────────────────────────────────
function RepartoModal({factura, onSave, onClose}){
  const ALL_REPARTO = [...INIT_MEMBERS, ...EXTERNAL_MEMBERS, EMPRESA_REPARTO];
  const [reparto, setReparto] = useState(
    factura.reparto?.length ? factura.reparto :
    ALL_REPARTO.map(m=>({member:m.name, pct:"", importe:""}))
  );
  const base = parseFloat(factura.base)||0;

  function updRep(name, field, val){
    setReparto(r=>r.map(x=>{
      if(x.member!==name) return x;
      if(field==="pct"){
        const imp = base>0?(parseFloat(val)||0)*base/100:0;
        return {...x, pct:val, importe:imp.toFixed(2)};
      } else {
        const pct = base>0?((parseFloat(val)||0)/base*100):0;
        return {...x, importe:val, pct:pct.toFixed(1)};
      }
    }));
  }

  function repartirIgual(){
    const n=INIT_MEMBERS.length;
    const pct=(100/n).toFixed(1);
    const imp=(base/n).toFixed(2);
    setReparto(ALL_REPARTO.map(m=>
      INIT_MEMBERS.find(x=>x.name===m.name)
        ? {member:m.name, pct, importe:imp}
        : {member:m.name, pct:"", importe:""}
    ));
  }

  const totalRep=reparto.reduce((s,x)=>s+(parseFloat(x.importe)||0),0);
  const diff=Math.abs(totalRep-base);

  return(
    <div style={{position:"fixed",inset:0,background:"#0008",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#1F232B",borderRadius:14,padding:"24px",maxWidth:480,width:"95%",boxShadow:"0 8px 40px #0004",maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>🔀 Reparto de factura</div>
        <div style={{fontSize:11,color:"#9AA1AC",marginBottom:14}}>
          {factura.ref||factura.concepto||"Sin ref"} · Base: <strong>{base.toFixed(2)}€</strong>
        </div>
        <button onClick={repartirIgual} style={{background:"#452311",color:"#E8501C",border:"none",borderRadius:7,padding:"6px 14px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginBottom:12}}>
          ⚖️ Repartir a partes iguales
        </button>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,marginBottom:12}}>
          <thead><tr>
            <th style={{textAlign:"left",padding:"4px 6px",color:"#9AA1AC",fontWeight:700}}>Persona</th>
            <th style={{textAlign:"left",padding:"4px 6px",color:"#9AA1AC",fontWeight:700}}>%</th>
            <th style={{textAlign:"left",padding:"4px 6px",color:"#9AA1AC",fontWeight:700}}>Importe €</th>
          </tr></thead>
          <tbody>
          {reparto.map((x)=>{
              const isEmpresa = x.member==="EMPRESA";
              const isExternal = EXTERNAL_MEMBERS.find(mm=>mm.name===x.member);
              const m = isEmpresa ? EMPRESA_REPARTO : [...INIT_MEMBERS,...EXTERNAL_MEMBERS].find(mm=>mm.name===x.member);
              return(
                <tr key={x.member} style={{borderTop:(isExternal||isEmpresa)?"2px dashed #2E343E":"none"}}>
                  <td style={{padding:"4px 6px"}}>
                    <span style={{background:m?.light,color:m?.color,fontWeight:700,fontSize:11,padding:"2px 8px",borderRadius:99}}>
                      {x.member}{isEmpresa?" 🏢":isExternal?" 🔗":""}
                    </span>
                  </td>
                  <td style={{padding:"4px 6px"}}>
                    <input value={x.pct} onChange={e=>updRep(x.member,"pct",e.target.value)}
                      style={{border:"1px solid #2E343E",borderRadius:5,padding:"3px 6px",fontSize:11,width:60,fontFamily:"inherit"}} placeholder="0"/>
                    <span style={{fontSize:10,color:"#7F8692"}}> %</span>
                  </td>
                  <td style={{padding:"4px 6px"}}>
                    <input value={x.importe} onChange={e=>updRep(x.member,"importe",e.target.value)}
                      style={{border:"1px solid #2E343E",borderRadius:5,padding:"3px 6px",fontSize:11,width:70,fontFamily:"inherit",color:"#059669",fontWeight:700}} placeholder="0.00"/>
                    <span style={{fontSize:10,color:"#7F8692"}}> €</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{background:diff<0.1?"#11452B":"#451111",borderRadius:7,padding:"6px 10px",fontSize:11,marginBottom:14,fontWeight:700,color:diff<0.1?"#059669":"#EC8383"}}>
          Total repartido: {totalRep.toFixed(2)}€ {diff<0.1?"✅":`⚠ Diferencia: ${diff.toFixed(2)}€`}
        </div>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button onClick={onClose} style={{background:"#262B34",color:"#B4BAC4",border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
          <button onClick={()=>onSave(reparto)} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Guardar reparto</button>
        </div>
      </div>
    </div>
  );
}

function FacturasTab({facturas, setFacturas, tipo, projects, pagoInfo, rect, onRect, onSaldada}){
  const ac=tipo==="ingresos"?"#059669":"#B91C1C";
  const acBg=tipo==="ingresos"?"#11452B":"#451111";
  const [repartoModal, setRepartoModal] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [unlocked, setUnlocked] = useState(false);
  const [showLock, setShowLock] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [escaneando, setEscaneando] = useState(0);
  const [facturasPendientes, setFacturasPendientes] = useState([]);
  const [aprobarModal, setAprobarModal] = useState(null);

  // Cargar pendientes desde Supabase al montar
  useEffect(()=>{
    const tipoDb = tipo==="ingresos"?"ingreso":"gasto";
    const parseR = r=>({
      ...r, _pendiente:true,
      linkFactura:r.link_factura||"", pagado:r.pagado||false, frcSign:r.frc_sign||"+",
      reparto:typeof r.reparto==="string"?JSON.parse(r.reparto||"[]"):r.reparto||[],
    });
    sb.from("facturas").select("*").eq("tipo",tipoDb).eq("estado","pendiente")
      .then(({data})=>{
        if(data&&data.length) setFacturasPendientes(data.map(parseR));
      });
    // Escuchar eventos del canal global
    function onNueva(e){
      const r=e.detail;
      if(r.tipo!==tipoDb) return;
      setFacturasPendientes(prev=>prev.find(x=>x.id===r.id)?prev:[parseR(r),...prev]);
    }
    function onAprobada(e){
      const r=e.detail;
      if(r.tipo!==tipoDb) return;
      setFacturasPendientes(prev=>prev.filter(x=>x.id!==r.id));
    }
    function onBorrada(e){
      const r=e.detail;
      setFacturasPendientes(prev=>prev.filter(x=>x.id!==r.id));
    }
    window.addEventListener("blesk:factura_pendiente",onNueva);
    window.addEventListener("blesk:factura_aprobada",onAprobada);
    window.addEventListener("blesk:factura_borrada",onBorrada);
    return ()=>{
      window.removeEventListener("blesk:factura_pendiente",onNueva);
      window.removeEventListener("blesk:factura_aprobada",onAprobada);
      window.removeEventListener("blesk:factura_borrada",onBorrada);
    };
  },[tipo]);

  function requireUnlock(action){
    if(unlocked){ action(); return; }
    setPendingAction(()=>action);
    setShowLock(true);
  }
  function onUnlock(){ setUnlocked(true); setShowLock(false); if(pendingAction){ pendingAction(); setPendingAction(null); } }

  async function escanearFactura(e){
    const files = Array.from(e.target.files||[]);
    if(!files.length) return;
    // Escanear no requiere contraseña
    (async()=>{
      setEscaneando(files.length);
      const nuevas = [];
      for(const file of files){
        // El archivo escaneado se guarda siempre como archivo de la factura, aunque falle la lectura
        let fileUrl="";
        try{ fileUrl=await uploadFacturaPdf(file); }
        catch(err){ console.error("Error subiendo archivo",file.name,err); alert(`No se pudo guardar el archivo ${file.name}: ${err.message}`); }
        let parsed={};
        try{
          const b64 = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(file); });
          const isPdf = file.type==="application/pdf";
          const mediaType = isPdf?"application/pdf":(file.type||"image/jpeg");
          const resp = await fetch("/api/scan",{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
              mediaType, b64, isPdf
            })
          });
          const data = await resp.json();
          const text = data.content?.[0]?.text||"{}";
          try{ parsed=JSON.parse(text.replace(/```json|```/g,"").trim()); }catch(err){}
        }catch(err){ console.error("Error escaneando",file.name,err); }
        if(!fileUrl&&!parsed.total&&!parsed.base) continue;
        nuevas.push({id:Date.now()+nuevas.length,fecha:parsed.fecha||"",base:String(parsed.base||""),iva:parsed.iva||"21%",total:String(parsed.total||""),ref:parsed.ref||"",descripcion:parsed.descripcion||file.name,proyecto:"",linkFactura:fileUrl,reparto:[],_pendiente:true,_fileNombre:file.name});
      }
      if(nuevas.length){
        // Guardar en Supabase con estado pendiente (sin id — lo genera Supabase)
        const toInsert = nuevas.map(r=>({
          tipo: tipo==="ingresos"?"ingreso":"gasto",
          estado: "pendiente",
          fecha: r.fecha||"",
          base: r.base||"",
          iva: r.iva||"21%",
          total: r.total||"",
          ref: r.ref||"",
          descripcion: r.descripcion||"",
          proyecto: "",
          link_factura: r.linkFactura||"",
          reparto: JSON.stringify([]),
          pagado: false,
          frc_sign: "+",
        }));
        sb.from("facturas").insert(toInsert).select().then(({data,error})=>{
          if(error){ console.error("Error guardando pendientes",error); alert("Error guardando en Supabase: "+error.message); return; }
          // Reemplazar ids locales con los ids reales de Supabase
          if(data&&data.length){
            setFacturasPendientes(prev=>{
              const sin = prev.filter(x=>!nuevas.find(n=>n.id===x.id));
              return [...data.map(r=>({
                ...r, _pendiente:true,
                linkFactura:r.link_factura||"", pagado:r.pagado||false,
                frcSign:r.frc_sign||"+",
                reparto:typeof r.reparto==="string"?JSON.parse(r.reparto||"[]"):r.reparto||[],
              })),...sin];
            });
          }
        });
        setFacturasPendientes(prev=>[...nuevas,...prev]);
      }
      setEscaneando(0);
      if(nuevas.length){
        alert(`✅ ${nuevas.length} factura${nuevas.length>1?"s":""} escaneada${nuevas.length>1?"s":""}. Aparece arriba como pendiente.`);
      }
    })();
    e.target.value="";
  }

  function importarA3(e){
    if(!e.target.files?.[0]) return;
    const file=e.target.files[0];
    const reader=new FileReader();
    reader.onload=async evt=>{
      try{
        const {read,utils}=await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
        const wb=read(new Uint8Array(evt.target.result),{type:"array",cellDates:true});
        const ws=wb.Sheets[wb.SheetNames[0]];
        const rows=utils.sheet_to_json(ws,{header:1,defval:""});
        const hIdx=rows.findIndex(r=>r.includes("Número"));
        if(hIdx<0){alert("No se encontró cabecera en el Excel");return;}
        const hdr=rows[hIdx];
        const col=k=>hdr.indexOf(k);
        const dataRows=rows.slice(hIdx+1).filter(r=>r[col("Número")]&&String(r[col("Número")]).trim());
        let imported=0,skipped=0;
        const nuevas=[];
        for(const r of dataRows){
          const num=String(r[col("Número")]||"").trim();
          const ref=String(r[col("Referencia")]||"").trim()||num;
          const nombre=String(r[col("Nombre")]||r[col("NIF/CIF/NIE")]||"").trim();
          const base=parseFloat(r[col("Base imponible")])||0;
          const total=parseFloat(r[col("Total")])||0;
          const iva=base>0?((total-base)/base*100).toFixed(0)+"%":"21%";
          let fecha="";
          const rawF=r[col("Fecha")];
          if(rawF){
            let d;
            if(rawF instanceof Date){d=rawF;}
            else if(typeof rawF==="number"){d=new Date(Math.round((rawF-25569)*86400*1000));}
            else{d=new Date(rawF);}
            if(!isNaN(d)&&d.getFullYear()>1970) fecha=`${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
          }
          const existe=(facturas||[]).find(f=>f.ref===ref||f.ref===num);
          if(existe){skipped++;continue;}
          nuevas.push({id:Date.now()+imported,fecha,base:String(base),iva,total:String(total),proyecto:"",ref,descripcion:nombre,linkFactura:"",reparto:[]});
          imported++;
        }
        if(nuevas.length>0) setFacturas(f=>[...nuevas,...f]);
        alert(`✅ Importadas ${imported} facturas${skipped>0?` (${skipped} ya existían)`:""}`);
      }catch(err){console.error(err);alert("Error: "+err.message);}
    };
    reader.readAsArrayBuffer(file);
    e.target.value="";
  }

  function addFactura(){
    requireUnlock(()=>{
      const currentYear=new Date().getFullYear().toString();
      setCollapsed(col=>({...col,[currentYear]:false}));
      setFacturas(f=>[{id:Date.now(),fecha:"",base:"",iva:"21%",total:"",proyecto:"",ref:"",descripcion:"",linkFactura:"",reparto:[]},...f]);
    });
  }
  function doUpd(id,field,val){
    setFacturas(f=>f.map(r=>{
      if(r.id!==id) return r;
      const updated={...r,[field]:val};
      if(field==="base"||field==="iva"){
        const base=parseFloat(field==="base"?val:r.base)||0;
        const ivaPct=parseFloat((field==="iva"?val:r.iva)||"0")||0;
        updated.total=(base*(1+ivaPct/100)).toFixed(2);
      }
      return updated;
    }));
  }
  function upd(id,field,val){
    if(unlocked){ doUpd(id,field,val); return; }
    requireUnlock(()=>doUpd(id,field,val));
  }
  function del(id){
    if(unlocked){ setFacturas(f=>f.filter(r=>r.id!==id)); return; }
    requireUnlock(()=>setFacturas(f=>f.filter(r=>r.id!==id)));
  }
  function saveReparto(id, reparto){ setFacturas(f=>f.map(r=>r.id===id?{...r,reparto}:r)); setRepartoModal(null); }

  const rows = facturas || [];
  const totBase=rows.reduce((s,r)=>{
    const b=parseFloat(r.base)||0;
    const signed=(r.ref||"").startsWith("FRC")&&r.frcSign==="-" ? -b : b;
    return s+signed;
  },0);
  const totTotal=rows.reduce((s,r)=>s+(parseFloat(r.total)||0),0);
  // Cobrada / pagada sale de la conciliación del banco. Importes con IVA, que es lo que se mueve en el banco
  const est=r=>estadoPago(pagoInfo,`${tipo==="ingresos"?"ing":"gas"}:${r.id}`,r.fecha,r.pagado);
  const totalConSigno=r=>{ const t=parseFloat(r.total)||0; return isFRCNeg(r)?-t:t; };
  const eurCob=v=>v.toLocaleString("es-ES",{maximumFractionDigits:0});
  const nPagadas=rows.filter(r=>est(r)==="si"||est(r)==="manual").length;
  const nPendientes=rows.filter(r=>est(r)==="no").length;
  const totCobrado=rows.filter(r=>est(r)==="si"||est(r)==="manual").reduce((s,r)=>s+totalConSigno(r),0);
  const totPorCobrar=rows.filter(r=>est(r)==="no").reduce((s,r)=>s+totalConSigno(r),0);

  // Group by year, then by type (FC/FS), sorted by ref number
  const getYear = f => { if(!f) return "Sin fecha"; const p=f.split('/'); return p.length===3?p[2]:(f.length>=4?f.slice(-4):"Sin fecha"); };
  const getRefNum = ref => { if(!ref) return 9999; const m=ref.match(/(\d+)$/); return m?parseInt(m[1]):9999; };
  const getRefType = ref => { if(!ref) return "Otro"; if(ref.startsWith("FRC")) return "FRC"; if(ref.startsWith("FC")) return "FC"; if(ref.startsWith("FS")) return "FS"; if(ref.startsWith("FRP")) return "FRP"; if(ref.startsWith("OI")) return "OI"; return "Otro"; };
  const sortByRef = arr => [...arr].sort((a,b)=>getRefNum(a.ref)-getRefNum(b.ref));
  const years = [...new Set(rows.map(r=>getYear(r.fecha)))].sort((a,b)=>b-a);

  const byProject = projects.map(p=>({p, rows: rows.filter(r=>r.proyecto===p.name)})).filter(x=>x.rows.length>0);

  return(
    <div>
      {showLock&&<EditLockModal onUnlock={onUnlock} onClose={()=>setShowLock(false)}/>}
      {!unlocked&&(
        <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#15181D",border:"1px solid #2E343E",borderRadius:8,padding:"5px 12px",marginBottom:12,fontSize:10,color:"#9AA1AC",cursor:"pointer"}} onClick={()=>setShowLock(true)}>
          🔒 Modo lectura — <span style={{color:"#ECEEF2",fontWeight:600}}>Haz clic para editar</span>
        </div>
      )}
      {unlocked&&(
        <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#11452D",border:"1px solid #1F7A3F",borderRadius:8,padding:"5px 12px",marginBottom:12,fontSize:10,color:"#059669"}}>
          🔓 Modo edición activo
        </div>
      )}
      {repartoModal&&(
        <RepartoModal
          factura={repartoModal}
          onSave={(rep)=>saveReparto(repartoModal.id, rep)}
          onClose={()=>setRepartoModal(null)}
        />
      )}

      {/* Header KPIs */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8,marginBottom:14}}>
        {[
          {label:tipo==="ingresos"?"💰 Total ingresos":"💸 Total gastos", val:`${totBase.toFixed(0)}€`, sub:"Base s/IVA", color:ac, bg:acBg},
          {label:"🧾 Con IVA", val:`${totTotal.toFixed(0)}€`, color:ac, bg:acBg},
          {label:"📄 Facturas", val:rows.length, color:"#E8501C", bg:"#452311"},
          {label:tipo==="ingresos"?"✅ Cobradas":"✅ Pagadas", val:`${eurCob(totCobrado)}€`, sub:`${nPagadas} conciliadas en el banco`, color:"#059669", bg:"#11452D"},
          {label:tipo==="ingresos"?"⏳ Por cobrar":"⏳ Por pagar", val:`${eurCob(totPorCobrar)}€`, sub:`${nPendientes} sin conciliar · con IVA`, color:"#B45309", bg:"#453311"},
        ].map(k=>(
          <div key={k.label} style={{background:k.bg,borderRadius:10,padding:"10px 12px",border:`1.5px solid ${k.color}22`}}>
            <div style={{fontSize:9,color:"#9AA1AC",marginBottom:2}}>{k.label}</div>
            <div style={{fontSize:18,fontWeight:900,color:k.color}}>{k.val}</div>
            {k.sub&&<div style={{fontSize:9,color:"#7F8692"}}>{k.sub}</div>}
          </div>
        ))}
      </div>

      <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        {tipo==="ingresos"&&(
          <label style={{background:"#262B34",color:"#C3C8D0",border:"1px solid #2E343E",borderRadius:7,padding:"6px 14px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}>
            ⬆ Importar A3
            <input type="file" accept=".xlsx,.xls" onChange={importarA3} style={{display:"none"}}/>
          </label>
        )}
        <label style={{background:"#7C3AED",color:"#FFF",border:"none",borderRadius:7,padding:"6px 14px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}
          title="Sube una foto o PDF de una factura y Claude extrae los datos automáticamente">
          🤖 Escanear factura
          <input type="file" accept="image/*,.pdf" multiple onChange={escanearFactura} style={{display:"none"}}/>
        </label>
        <LibroBoton lista={facturas} label={tipo==="ingresos"?"Libro de emitidas":"Libro de recibidas"} onDescargar={y=>descargarLibroFacturas(tipo,facturas,y)}/>
        <button onClick={addFactura} style={{background:ac,color:"#FFF",border:"none",borderRadius:7,padding:"6px 16px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Nueva factura</button>
      </div>
      {escaneando>0&&(
        <div style={{background:"#1A1145",border:"1px solid #2F1F7A",borderRadius:10,padding:"12px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:18,height:18,border:"2px solid #7C3AED",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite",flexShrink:0}}/>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#AD86E9"}}>🤖 Claude está analizando {escaneando} factura{escaneando>1?"s":""}...</div>
            <div style={{fontSize:10,color:"#7C3AED",marginTop:2}}>Extrayendo fecha, referencia, importe y cliente</div>
          </div>
        </div>
      )}

      {/* Facturas pendientes de aprobar */}
      {facturasPendientes.length>0&&(
        <div style={{marginBottom:16,border:"2px solid #F59E0B",borderRadius:12,overflow:"hidden"}}>
          <div style={{background:"#F59E0B",padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{color:"#FFF",fontWeight:700,fontSize:13}}>⏳ Pendientes de aprobar ({facturasPendientes.length})</span>
            <span style={{color:"#FFF",fontSize:10,opacity:.8}}>Escaneadas — requieren revisión</span>
          </div>
          <div style={{background:"#453B11",padding:"8px"}}>
            {facturasPendientes.map((r,i)=>(
              <div key={r.id} style={{background:"#1F232B",borderRadius:9,padding:"10px 14px",marginBottom:6,border:"1px solid #7A681F",display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{flex:1,minWidth:200}}>
                  <div style={{fontWeight:700,fontSize:12,color:"#ECEEF2",marginBottom:4}}>{r.ref||"Sin referencia"} — {r.descripcion||"Sin descripción"}</div>
                  <div style={{display:"flex",gap:10,fontSize:11,color:"#9AA1AC",flexWrap:"wrap"}}>
                    <span>📅 {r.fecha||"—"}</span>
                    <span>💰 Base: <b style={{color:"#059669"}}>{r.base||"—"}€</b></span>
                    <span>IVA: {r.iva||"—"}</span>
                    <span>Total: <b>{r.total||"—"}€</b></span>
                    {r.linkFactura
                      ?<a href={r.linkFactura} target="_blank" rel="noreferrer" style={{color:"#4F46E5",fontWeight:700,textDecoration:"none"}}>📄 Archivo guardado ↗</a>
                      :<span style={{color:"#EC8383",fontWeight:700}}>⚠️ Sin archivo</span>}
                  </div>
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {!unlocked&&(
                    <span style={{fontSize:10,color:"#D97706",fontWeight:600}}>🔒 Solo administrador</span>
                  )}
                  {unlocked&&(
                    <>
                      <button onClick={()=>setAprobarModal(r)}
                        style={{background:"#11452B",border:"1px solid #1F7A56",borderRadius:7,padding:"6px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",color:"#059669"}}>
                        ✅ Aprobar
                      </button>
                      <button onClick={()=>{
                        sb.from("facturas").delete().eq("id",r.id).then(({error})=>{
                          if(error) console.error("Error borrando pendiente",error);
                        });
                        setFacturasPendientes(prev=>prev.filter(x=>x.id!==r.id));
                      }} style={{background:"#451111",border:"1px solid #FCA5A5",borderRadius:7,padding:"6px 10px",fontSize:11,cursor:"pointer",fontFamily:"inherit",color:"#EB8484",fontWeight:700}}>
                        ✕
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Sections by year */}
      {years.map(year=>{
        const yrows = rows.filter(r=>getYear(r.fecha)===year);
        const yBase = yrows.reduce((s,r)=>{ const b=parseFloat(r.base)||0; return s+((r.ref||"").startsWith("FRC")&&r.frcSign==="-"?-b:b); },0);
        const yTotal = yrows.reduce((s,r)=>s+(parseFloat(r.total)||0),0);
        const currentYear=new Date().getFullYear().toString();
        const isOpen=collapsed[year]===undefined?year===currentYear:!collapsed[year];
        // Split by type and sort by ref number
        const types = [...new Set(yrows.map(r=>getRefType(r.ref)))].sort();
        return(
          <div key={year} style={{marginBottom:12,borderRadius:12,overflow:"hidden",border:`1px solid ${ac}33`}}>
            <div onClick={()=>setCollapsed(c=>({...c,[year]:!c[year]}))}
              style={{background:ac,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
              <span style={{color:"#FFF",fontWeight:700,fontSize:13}}>{year} · {yrows.length} facturas{yrows.some(r=>est(r)==="no")&&<span style={{marginLeft:8,background:"#453B11",color:"#F3A97D",borderRadius:99,padding:"1px 8px",fontSize:10}}>⏳ {yrows.filter(r=>est(r)==="no").length} sin {tipo==="ingresos"?"cobrar":"pagar"} · {eurCob(yrows.filter(r=>est(r)==="no").reduce((s,r)=>s+totalConSigno(r),0))}€</span>}{yrows.some(r=>!r.linkFactura)&&<span style={{marginLeft:8,background:"#1F232B",color:"#EC8383",borderRadius:99,padding:"1px 8px",fontSize:10}}>⚠️ {yrows.filter(r=>!r.linkFactura).length} sin PDF</span>}</span>
              <div style={{display:"flex",gap:16,alignItems:"center"}}>
                <span style={{color:"#FFFFFF99",fontSize:11,fontWeight:700}}>Base: {yBase.toFixed(0)}€ · Total: {yTotal.toFixed(0)}€</span>
                <span style={{color:"#FFF",fontSize:14}}>{isOpen?"▲":"▼"}</span>
              </div>
            </div>
            {isOpen&&(
              <div style={{background:"#1F232B"}}>
                {types.map(type=>{
                  const trows = sortByRef(yrows.filter(r=>getRefType(r.ref)===type));
                  const tBase = trows.reduce((s,r)=>{ const b=parseFloat(r.base)||0; return s+((r.ref||"").startsWith("FRC")&&r.frcSign==="-"?-b:b); },0);
                  return(
                    <div key={type}>
                      <div style={{padding:"7px 16px",background:"#15181D",borderBottom:"1px solid #2E343E",fontSize:10,fontWeight:700,color:"#9AA1AC",letterSpacing:"0.3px"}}>
                        {type} — {trows.length} facturas · {tBase.toFixed(0)}€
                      </div>
                      <div style={{overflowX:"auto"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                          <THead cols={["Proyecto","Fecha","Base €","IVA","Total €",tipo==="ingresos"?"Nº Factura":"Concepto","Descripción / Cliente","PDF",tipo==="gastos"?"Pagado":"Cobrada","Reparto",""]} color={ac}/>
                          <tbody>
                            {trows.map((r,i)=>{
                              const proj=projects.find(p=>p.name===r.proyecto);
                              const hasReparto=r.reparto?.some(x=>parseFloat(x.importe)>0);
                              const sumaReparto=(r.reparto||[]).reduce((s,x)=>s+(parseFloat(x.importe)||0),0);
                              const baseNum=parseFloat(r.base)||0;
                              const repartoCompleto=hasReparto&&baseNum>0&&sumaReparto>=(baseNum-0.05);
                              const faltaReparto=hasReparto&&!repartoCompleto&&baseNum>0;
                              const falta=baseNum-sumaReparto;
                              return(
                                <tr key={r.id} style={{background:fondoEstado(est(r),i)}}>
                                  <td style={{padding:"3px 5px"}}>
                                    <Sel value={r.proyecto} onChange={v=>upd(r.id,"proyecto",v)} options={projects.map(p=>p.name)} placeholder="— Proyecto —"/>
                                    {proj&&<div style={{marginTop:2}}><Badge label={r.proyecto} colors={{bg:proj.light,text:proj.color}}/></div>}
                                  </td>
                                  <td style={{padding:"3px 5px"}}><DateInp value={r.fecha||""} onChange={v=>upd(r.id,"fecha",v)} w="110px" locked={!unlocked} onLock={()=>setShowLock(true)}/></td>
                                  <td style={{padding:"3px 5px"}}>
                                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                                      {(r.ref||"").startsWith("FRC")&&(
                                        <button onClick={()=>upd(r.id,"frcSign",r.frcSign==="-"?"+":"-")} style={{
                                          background:r.frcSign==="-"?"#451111":"#11452B",
                                          color:r.frcSign==="-"?"#EC8383":"#059669",
                                          border:"none",borderRadius:4,padding:"1px 6px",fontSize:11,fontWeight:700,
                                          cursor:"pointer",fontFamily:"inherit",flexShrink:0,
                                        }}>{r.frcSign==="-"?"−":"+"}</button>
                                      )}
                                      <Inp value={r.base} onChange={v=>upd(r.id,"base",v)} placeholder="0.00" w="75px" color={(r.ref||"").startsWith("FRC")&&r.frcSign==="-"?"#B91C1C":"#1D4ED8"} bold/>
                                    </div>
                                  </td>
                                  <td style={{padding:"3px 5px"}}><Sel value={r.iva} onChange={v=>upd(r.id,"iva",v)} options={["0%","4%","10%","21%"]}/></td>
                                  <td style={{padding:"3px 5px"}}><Inp value={r.total} onChange={v=>upd(r.id,"total",v)} placeholder="0.00" w="75px" color={ac} bold/></td>
                                  <td style={{padding:"3px 5px"}}>
                                    <Inp value={r.ref} onChange={v=>upd(r.id,"ref",v)} placeholder={tipo==="ingresos"?"FAC-001":"Concepto"}/>
                                    {(r.ref||"").startsWith("FRC")&&onRect&&(()=>{
                                      const sel=rect?.[String(r.id)]||"";
                                      const opciones=(facturas||[]).filter(f=>!(f.ref||"").startsWith("FRC")).sort((a,b)=>bancoTs(b.fecha)-bancoTs(a.fecha));
                                      return(
                                        <select value={sel} onChange={e=>{ const v=e.target.value; requireUnlock(()=>onRect(r.id,v)); }}
                                          title="Factura que anula o corrige esta rectificativa (no pasa por el banco)"
                                          style={{display:"block",marginTop:3,maxWidth:170,fontSize:9.5,fontFamily:"inherit",borderRadius:5,padding:"2px 4px",
                                            border:`1px solid ${sel?"#2F1F7A":"#FCA5A5"}`,background:sel?"#1A1145":"#451111",color:sel?"#AD86EA":"#EC8383",fontWeight:600}}>
                                          <option value="">⚠️ ¿A qué factura rectifica?</option>
                                          {opciones.map(f=><option key={f.id} value={String(f.id)}>↩️ {f.ref||"s/ref"} · {f.descripcion||""} · {f.total||f.base||0}€ · {f.fecha||"s/f"}</option>)}
                                        </select>
                                      );
                                    })()}
                                    {pagoInfo?.rectPor?.[`${tipo==="ingresos"?"ing":"gas"}:${r.id}`]&&(
                                      <div style={{fontSize:9,color:"#AD86EA",fontWeight:600,marginTop:2}}>↩️ rectificada por {pagoInfo.rectPor[`${tipo==="ingresos"?"ing":"gas"}:${r.id}`].join(", ")}</div>
                                    )}
                                  </td>
                                  <td style={{padding:"3px 5px"}}><InpBlur value={r.descripcion||""} onChange={v=>upd(r.id,"descripcion",v)} placeholder="Ej: Proyecto · concepto" w="160px" locked={!unlocked} onLock={()=>setShowLock(true)}/></td>
                                  <td style={{padding:"3px 5px"}}><PdfCell value={r.linkFactura} onChange={v=>upd(r.id,"linkFactura",v)} locked={!unlocked} onLock={()=>setShowLock(true)}/></td>
                                  <td style={{padding:"3px 5px",textAlign:"center"}}><EstadoPagoBadge estado={est(r)} ingreso={tipo==="ingresos"}
                                    nota={pagoInfo?.saldadas?.[`${tipo==="ingresos"?"ing":"gas"}:${r.id}`]?.nota}
                                    onClick={onSaldada?()=>requireUnlock(()=>onSaldada(`${tipo==="ingresos"?"ing":"gas"}:${r.id}`,r.ref||"esta factura")):undefined}/></td>
                                  <td style={{padding:"3px 5px"}}>
                                    <button onClick={()=>requireUnlock(()=>setRepartoModal(r))}
                                      style={{background:repartoCompleto?"#11452B":faltaReparto?"#453B11":"#452311",color:repartoCompleto?"#059669":faltaReparto?"#D97706":"#E8501C",border:faltaReparto?"1px solid #7A651F":"none",borderRadius:6,padding:"3px 9px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
                                      {repartoCompleto?"✅ Repartido":faltaReparto?`⚠️ Falta ${falta.toFixed(0)}€`:"🔀 Repartir"}
                                    </button>
                                  </td>
                                  <td style={{padding:"3px 5px"}}><DelBtn onClick={()=>del(r.id)}/></td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr style={{background:acBg}}>
                              <td colSpan={2} style={{padding:"5px 8px",fontWeight:700,fontSize:11,color:ac}}>TOTAL {type} {year}</td>
                              <td style={{padding:"5px 8px",fontWeight:700,color:"#819EEE"}}>{tBase.toFixed(2)}€</td>
                              <td/><td colSpan={5}/>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Modal aprobación */}
      {aprobarModal&&<AprobarFacturaModal
        factura={aprobarModal}
        facturas={facturas}
        onConfirm={(aprobada)=>{
          const currentYear=new Date().getFullYear().toString();
          setCollapsed(col=>({...col,[currentYear]:false}));
          setFacturas(f=>[aprobada,...f]);
          setFacturasPendientes(prev=>prev.filter(x=>x.id!==aprobarModal.id));
          // Actualizar en Supabase
          sb.from("facturas").update({
            estado:"aprobada",
            ref: aprobada.ref||"",
            link_factura: aprobada.linkFactura||"",
          }).eq("id",aprobarModal.id).then(({error})=>{
            if(error) console.error("Error aprobando factura",error);
          });
          setAprobarModal(null);
        }}
        onCancel={()=>setAprobarModal(null)}
      />}
      {rows.length===0&&(
        <div style={{textAlign:"center",padding:"32px",color:"#7F8692"}}>
          <div style={{fontSize:28,marginBottom:6}}>{tipo==="ingresos"?"💰":"💸"}</div>
          <div style={{fontSize:12,fontWeight:600}}>Sin {tipo} todavía</div>
        </div>
      )}

      {/* Resumen por proyecto */}
      {byProject.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:8,marginTop:12}}>
          {byProject.map(({p,rows:pr})=>{
            const totB=pr.reduce((s,r)=>s+signedBase(r),0);
            return(
              <div key={p.name} style={{background:"#1F232B",borderRadius:10,overflow:"hidden",border:`1px solid ${p.color}33`}}>
                <div style={{background:p.color,padding:"7px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{color:"#FFF",fontWeight:700,fontSize:12}}>{p.name}</span>
                  <span style={{color:"#FFFFFF99",fontSize:11,fontWeight:700}}>{totB.toFixed(0)}€</span>
                </div>
                <div style={{padding:"8px 12px"}}>
                  {pr.map(r=>(
                    <div key={r.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11,padding:"3px 0",borderBottom:"1px solid #2E343E"}}>
                      <span style={{color:"#9AA1AC"}}>{r.ref||r.fecha||"—"}</span>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        {r.reparto?.filter(x=>parseFloat(x.importe)>0).map(x=>{
                          const m=INIT_MEMBERS.find(mm=>mm.name===x.member);
                          return <span key={x.member} style={{background:m?.light,color:m?.color,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:99}}>{x.member[0]} {parseFloat(x.importe).toFixed(0)}€</span>;
                        })}
                        <span style={{fontWeight:700,color:ac}}>{parseFloat(r.base||0).toFixed(0)}€</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ── HOJAS DE GASTO TAB ────────────────────────────────────────────────────────
function FormularioHojaGasto({form,updForm,updDia,addDia,delDia,updGasto,addTickets,delTicket,totalCat,totalDia,totalGeneral,enviando,onCancel,onSubmit,projects}){
    return(
      <div style={{background:"#1F232B",border:"2px solid #ECEEF2",borderRadius:16,padding:"24px",marginBottom:20}}>
        <div style={{fontWeight:800,fontSize:15,color:"#ECEEF2",marginBottom:16}}>📋 Nueva hoja de gastos</div>

        {/* Datos generales */}
        <div style={{fontWeight:700,fontSize:10,color:"#C3C8D0",letterSpacing:"0",marginBottom:10}}>Datos generales</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
          <div>
            <div style={{fontSize:10,fontWeight:600,color:"#9AA1AC",marginBottom:4}}>Persona *</div>
            <select value={form.nombre} onChange={e=>updForm("nombre",e.target.value)}
              style={{width:"100%",border:"1.5px solid #2E343E",borderRadius:8,padding:"7px 10px",fontSize:12,fontFamily:"inherit",outline:"none",boxSizing:"border-box",background:"#1F232B"}}>
              <option value="">— Selecciona tu nombre —</option>
              {INIT_MEMBERS.map(m=><option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:600,color:"#9AA1AC",marginBottom:4}}>Proyecto</div>
            <select value={form.proyecto||""} onChange={e=>updForm("proyecto",e.target.value)}
              style={{width:"100%",border:"1.5px solid #2E343E",borderRadius:8,padding:"7px 10px",fontSize:12,fontFamily:"inherit",outline:"none",boxSizing:"border-box",background:"#1F232B"}}>
              <option value="">— Sin proyecto / general —</option>
              {(projects||[]).map(p=><option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div style={{gridColumn:"span 2"}}>
            <div style={{fontSize:10,fontWeight:600,color:"#9AA1AC",marginBottom:4}}>Actividad</div>
            <input value={form.actividad} onChange={e=>updForm("actividad",e.target.value)}
              placeholder="Ej: Reunión con cliente"
              style={{width:"100%",border:"1.5px solid #2E343E",borderRadius:8,padding:"7px 10px",fontSize:12,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:600,color:"#9AA1AC",marginBottom:4}}>Fecha de inicio</div>
            <input type="date" value={form.fecha_ini} onChange={e=>updForm("fecha_ini",e.target.value)}
              style={{width:"100%",border:"1.5px solid #2E343E",borderRadius:8,padding:"7px 10px",fontSize:12,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:600,color:"#9AA1AC",marginBottom:4}}>Fecha de finalización</div>
            <input type="date" value={form.fecha_fin} onChange={e=>updForm("fecha_fin",e.target.value)}
              style={{width:"100%",border:"1.5px solid #2E343E",borderRadius:8,padding:"7px 10px",fontSize:12,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
          </div>
        </div>

        {/* Tabla de gastos por día */}
        <div style={{fontWeight:700,fontSize:10,color:"#C3C8D0",letterSpacing:"0",marginBottom:10}}>Gastos por día</div>
        <div style={{overflowX:"auto",marginBottom:16}}>
          <table style={{borderCollapse:"collapse",fontSize:11,minWidth:500}}>
            <thead>
              <tr>
                <th style={{background:"#3A414D",color:"white",padding:"7px 10px",textAlign:"left",minWidth:160,borderRadius:"8px 0 0 0"}}>Categoría</th>
                {form.dias.map((d,i)=>(
                  <th key={i} style={{background:"#3A414D",color:"white",padding:"5px 8px",textAlign:"center",minWidth:90,borderLeft:"1px solid #39404A"}}>
                    <div style={{fontSize:9,marginBottom:3}}>Día {i+1}</div>
                    <input type="date" value={d.fecha} onChange={e=>updDia(i,"fecha",e.target.value)}
                      style={{background:"rgba(255,255,255,0.15)",border:"none",borderRadius:4,padding:"2px 4px",fontSize:9,color:"white",fontFamily:"inherit",width:"100%",outline:"none"}}/>
                    {form.dias.length>1&&<button onClick={()=>delDia(i)} style={{background:"none",border:"none",color:"rgba(255,255,255,0.5)",cursor:"pointer",fontSize:10,padding:0,marginTop:2}}>✕</button>}
                  </th>
                ))}
                <th style={{background:"#323844",color:"white",padding:"7px 10px",textAlign:"center",minWidth:80,borderLeft:"2px solid #39404A"}}>Total</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORIAS_GASTO.map((cat,ci)=>{
                const isTransSub = cat.id==="billetes";
                const isAlojSub  = cat.id==="cena";
                const isOtrosSub = cat.id==="otros";
                return(
                  <Fragment key={cat.id}>
                    <tr style={{background:ci%2===0?"#232831":"#1F232B"}}>
                      <td style={{padding:"6px 10px",fontWeight:500,color:"#C3C8D0",borderRight:"2px solid #2E343E"}}>{cat.label}</td>
                      {form.dias.map((_,di)=>(
                        <td key={di} style={{padding:"4px 6px",borderLeft:"1px solid #2E343E"}}>
                          <input type="number" value={form.gastos[di]?.[cat.id]||""} onChange={e=>updGasto(di,cat.id,e.target.value)}
                            placeholder="0"
                            style={{width:"100%",border:"1px solid #2E343E",borderRadius:6,padding:"4px 6px",fontSize:11,fontFamily:"inherit",textAlign:"right",outline:"none"}}/>
                        </td>
                      ))}
                      <td style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:"#ECEEF2",background:"#112845",borderLeft:"2px solid #1F477A"}}>
                        {totalCat(cat.id)>0?totalCat(cat.id).toFixed(2):"—"}
                      </td>
                    </tr>
                    {isTransSub&&(
                      <tr style={{background:"#114521"}}>
                        <td style={{padding:"5px 10px",fontWeight:700,color:"#059669",fontSize:10,borderRight:"2px solid #2E343E"}}>→ Total transportes</td>
                        {form.dias.map((_,di)=>(
                          <td key={di} style={{padding:"5px 6px",textAlign:"right",fontSize:10,fontWeight:600,color:"#059669",borderLeft:"1px solid #2E343E"}}>
                            {["km","peaje","taxi","otros_t","billetes"].reduce((s,id)=>s+(parseFloat(form.gastos[di]?.[id])||0),0)||""}
                          </td>
                        ))}
                        <td style={{padding:"5px 10px",textAlign:"right",fontWeight:700,color:"#059669",background:"#114523",borderLeft:"2px solid #1F477A"}}>
                          {["km","peaje","taxi","otros_t","billetes"].reduce((s,id)=>s+totalCat(id),0).toFixed(2)}
                        </td>
                      </tr>
                    )}
                    {isAlojSub&&(
                      <tr style={{background:"#114521"}}>
                        <td style={{padding:"5px 10px",fontWeight:700,color:"#059669",fontSize:10,borderRight:"2px solid #2E343E"}}>→ Total aloj. y manut.</td>
                        {form.dias.map((_,di)=>(
                          <td key={di} style={{padding:"5px 6px",textAlign:"right",fontSize:10,fontWeight:600,color:"#059669",borderLeft:"1px solid #2E343E"}}>
                            {["aloj","desayuno","almuerzo","cena"].reduce((s,id)=>s+(parseFloat(form.gastos[di]?.[id])||0),0)||""}
                          </td>
                        ))}
                        <td style={{padding:"5px 10px",textAlign:"right",fontWeight:700,color:"#059669",background:"#114523",borderLeft:"2px solid #1F477A"}}>
                          {["aloj","desayuno","almuerzo","cena"].reduce((s,id)=>s+totalCat(id),0).toFixed(2)}
                        </td>
                      </tr>
                    )}
                    {isOtrosSub&&(
                      <tr style={{background:"#3A414D"}}>
                        <td style={{padding:"7px 10px",fontWeight:800,color:"white",fontSize:11,borderRight:"2px solid #39404A"}}>TOTAL GASTOS</td>
                        {form.dias.map((_,di)=>(
                          <td key={di} style={{padding:"7px 6px",textAlign:"right",fontSize:11,fontWeight:700,color:"white",borderLeft:"1px solid #39404A"}}>
                            {totalDia(di)>0?totalDia(di).toFixed(2):"—"}
                          </td>
                        ))}
                        <td style={{padding:"7px 10px",textAlign:"right",fontWeight:800,color:"white",fontSize:13,background:"#323844",borderLeft:"2px solid #39404A"}}>
                          {totalGeneral().toFixed(2)}€
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <button onClick={addDia}
          style={{background:"#262B34",border:"1px solid #2E343E",borderRadius:7,padding:"6px 12px",fontSize:11,cursor:"pointer",fontFamily:"inherit",color:"#C3C8D0",marginBottom:20}}>
          + Añadir día
        </button>

        {/* Itinerario / km */}
        <div style={{fontWeight:700,fontSize:10,color:"#C3C8D0",letterSpacing:"0",marginBottom:10}}>Detalle itinerario (km)</div>
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
          {form.dias.map((d,i)=>(
            <div key={i} style={{display:"grid",gridTemplateColumns:"120px 1fr 80px",gap:8,alignItems:"center"}}>
              <div style={{fontSize:10,color:"#9AA1AC",fontWeight:500}}>{d.fecha||`Día ${i+1}`}</div>
              <input value={d.recorrido} onChange={e=>updDia(i,"recorrido",e.target.value)}
                placeholder="Recorrido realizado (origen → destino)"
                style={{border:"1px solid #2E343E",borderRadius:7,padding:"6px 9px",fontSize:11,fontFamily:"inherit",outline:"none"}}/>
              <input type="number" value={d.kms} onChange={e=>updDia(i,"kms",e.target.value)}
                placeholder="KMs"
                style={{border:"1px solid #2E343E",borderRadius:7,padding:"6px 9px",fontSize:11,fontFamily:"inherit",outline:"none",textAlign:"right"}}/>
            </div>
          ))}
        </div>

        {/* Tickets / fotos */}
        <div style={{fontWeight:700,fontSize:10,color:"#C3C8D0",letterSpacing:"0",marginBottom:10}}>
          🧾 Tickets y justificantes ({form.tickets.length})
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:10}}>
          {form.tickets.map((t,i)=>(
            <div key={i} style={{position:"relative",width:72,height:72}}>
              <img src={t.preview} alt={t.nombre}
                style={{width:72,height:72,objectFit:"cover",borderRadius:8,border:"1px solid #2E343E"}}
                onError={e=>{e.target.src="";e.target.style.display="none";}}/>
              <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0)",borderRadius:8}}>
                <span style={{fontSize:9,color:"#C3C8D0",background:"#1F232B",padding:"1px 4px",borderRadius:4,position:"absolute",bottom:2,left:2,right:2,textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {t.nombre}
                </span>
              </div>
              <button onClick={()=>delTicket(i)}
                style={{position:"absolute",top:-6,right:-6,background:"#DC2626",border:"none",color:"white",borderRadius:99,width:18,height:18,cursor:"pointer",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>
                ✕
              </button>
            </div>
          ))}
          <label style={{width:72,height:72,border:"2px dashed #3A414D",borderRadius:8,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#7F8692",fontSize:10,gap:4}}>
            <span style={{fontSize:20}}>📷</span>
            <span>Añadir</span>
            <input type="file" accept="image/*,.pdf" multiple onChange={addTickets} style={{display:"none"}}/>
          </label>
        </div>

        {/* Comentarios */}
        <div style={{fontWeight:700,fontSize:10,color:"#C3C8D0",letterSpacing:"0",marginBottom:6}}>Comentarios y observaciones</div>
        <textarea value={form.comentarios} onChange={e=>updForm("comentarios",e.target.value)}
          placeholder="Añade cualquier observación relevante..."
          style={{width:"100%",border:"1.5px solid #2E343E",borderRadius:8,padding:"8px 12px",fontSize:11,fontFamily:"inherit",resize:"vertical",minHeight:60,color:"#C3C8D0",lineHeight:1.5,boxSizing:"border-box",outline:"none",marginBottom:16}}/>

        {/* Resumen y enviar */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
          <div style={{background:"#114521",border:"1px solid #1F7A3F",borderRadius:10,padding:"10px 16px"}}>
            <div style={{fontSize:10,color:"#059669",fontWeight:600}}>TOTAL A JUSTIFICAR</div>
            <div style={{fontSize:22,fontWeight:800,color:"#059669",letterSpacing:"-1px"}}>{totalGeneral().toFixed(2)}€</div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={onCancel}
              style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:8,padding:"8px 16px",fontSize:11,cursor:"pointer",fontFamily:"inherit",color:"#9AA1AC"}}>
              Cancelar
            </button>
            <button onClick={onSubmit} disabled={enviando}
              style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"8px 20px",fontSize:11,fontWeight:700,cursor:enviando?"not-allowed":"pointer",fontFamily:"inherit",opacity:enviando?.7:1}}>
              {enviando?"⏳ Generando...":"✅ Generar y enviar"}
            </button>
          </div>
        </div>
      </div>
    );
  }

function TarjetaSolicitudCard({s, unlocked, cambiarEstado, eliminar, renderEstadoBadge, enListado, onAñadir}){
  const [open,setOpen]=useState(false);
  const fecha=s.created_at?new Date(s.created_at).toLocaleDateString("es-ES"):"—";
  let datos={};
  try{ datos=JSON.parse(s.datos||"{}"); }catch(e){}
  return(
    <div style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:12,overflow:"hidden"}}>
      <div style={{padding:"12px 16px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",cursor:"pointer"}} onClick={()=>setOpen(p=>!p)}>
        <div style={{fontSize:22}}>📄</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:600,fontSize:12,color:"#ECEEF2",marginBottom:2}}>{s.nombre_archivo}</div>
          <div style={{fontSize:10,color:"#7F8692"}}>{fecha}{datos.total?` · Total: ${parseFloat(datos.total).toFixed(2)}€`:""}{datos.proyecto?` · ${datos.proyecto}`:""}</div>
        </div>
        {enListado==="si"&&<span style={{fontSize:10,color:"#059669",fontWeight:600}}>📋 En el listado</span>}
        {enListado==="parece"&&<span style={{fontSize:10,color:"#9AA1AC",fontWeight:600,display:"inline-flex",gap:6,alignItems:"center"}} title="Hay una hoja de la misma persona, mismo importe y mismo mes">
          📋 Parece que ya está en el listado
          {unlocked&&<button onClick={e=>{e.stopPropagation();if(window.confirm("Ya hay una hoja de esta persona con el mismo importe ese mes. ¿Añadirla igualmente?"))onAñadir();}} style={{background:"none",border:"none",color:"#E8501C",cursor:"pointer",fontSize:10,textDecoration:"underline",fontFamily:"inherit",padding:0}}>añadir igualmente</button>}
        </span>}
        {enListado==="no"&&(unlocked
          ?<button onClick={e=>{e.stopPropagation();onAñadir();}} style={{background:"#453B11",border:"1px solid #7A651F",color:"#F3A97D",borderRadius:7,padding:"4px 10px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>➕ Añadir a hojas de gasto</button>
          :<span style={{fontSize:10,color:"#B45309",fontWeight:600}}>⚠️ Falta añadirla al listado</span>)}
        {renderEstadoBadge(s.estado)}
        <span style={{fontSize:12,color:"#7F8692"}}>{open?"▲":"▼"}</span>
      </div>
      {open&&(
        <div style={{borderTop:"1px solid #2E343E",padding:"12px 16px"}}>
          {datos.tickets&&datos.tickets.length>0&&(
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:700,color:"#C3C8D0",letterSpacing:"0",marginBottom:8}}>🧾 Tickets adjuntos ({datos.tickets.length})</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                {datos.tickets.map((t,i)=>(
                  <a key={i} href={t.url} target="_blank" rel="noreferrer"
                    style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,textDecoration:"none"}}>
                    <img src={t.url} alt={t.nombre} style={{width:80,height:80,objectFit:"cover",borderRadius:8,border:"1px solid #2E343E"}}
                      onError={e=>{ e.target.style.display="none"; }}/>
                    <span style={{fontSize:9,color:"#9AA1AC",maxWidth:80,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.nombre}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            <button onClick={async()=>{
              try{
                const htmlContent = datos.html;
                let html = htmlContent || "";
                if(!html && s.url){
                  const res = await fetch(s.url);
                  html = await res.text();
                }
                if(html){
                  const blob = new Blob([html],{type:"text/html;charset=utf-8"});
                  const url = URL.createObjectURL(blob);
                  window.open(url,"_blank");
                }
              }catch(e){ alert("Error: "+e.message); }
            }} style={{background:"#262B34",border:"1px solid #2E343E",borderRadius:7,padding:"5px 10px",fontSize:11,cursor:"pointer",color:"#C3C8D0",fontFamily:"inherit"}}>
              👁 Ver hoja
            </button>
            <button onClick={async()=>{
              try{
                const htmlContent = datos.html;
                let html = htmlContent || "";
                if(!html && s.url){
                  const res = await fetch(s.url);
                  html = await res.text();
                }
                if(html){
                  const blob = new Blob([html],{type:"text/html;charset=utf-8"});
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = (s.nombre_archivo||"hoja_gasto").replace(/\.html$/,"").replace(/\.xlsx$/,"")+".html";
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
                }
              }catch(e){ alert("Error descargando: "+e.message); }
            }} style={{background:"#262B34",border:"1px solid #2E343E",borderRadius:7,padding:"5px 10px",fontSize:11,cursor:"pointer",color:"#C3C8D0",fontFamily:"inherit"}}>
              ⬇ Descargar
            </button>
            {unlocked&&s.estado==="pendiente"&&(
              <>
                <button onClick={()=>cambiarEstado(s.id,"aprobada")}
                  style={{background:"#11452B",border:"1px solid #1F7A56",borderRadius:7,padding:"5px 10px",fontSize:11,cursor:"pointer",fontFamily:"inherit",color:"#059669",fontWeight:700}}>
                  ✅ Aprobar
                </button>
                <button onClick={()=>cambiarEstado(s.id,"rechazada")}
                  style={{background:"#451111",border:"1px solid #FCA5A5",borderRadius:7,padding:"5px 10px",fontSize:11,cursor:"pointer",fontFamily:"inherit",color:"#EB8484",fontWeight:700}}>
                  ❌ Rechazar
                </button>
              </>
            )}
            {unlocked&&(
              <button onClick={()=>eliminar(s.id,s.path,s.datos)}
                style={{background:"none",border:"1px solid #2E343E",borderRadius:7,padding:"5px 8px",fontSize:11,cursor:"pointer",color:"#7F8692",fontFamily:"inherit"}}>
                🗑 Eliminar
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── SOLICITUD HOJA DE GASTO ──────────────────────────────────────────────────
const CATEGORIAS_GASTO = [
  {id:"km",      label:"Importe Kilómetros"},
  {id:"peaje",   label:"Peajes"},
  {id:"taxi",    label:"Taxi"},
  {id:"otros_t", label:"Otros (tren o autobús)"},
  {id:"billetes",label:"Billetes nacionales"},
  {id:"aloj",    label:"Alojamiento"},
  {id:"desayuno",label:"Desayuno"},
  {id:"almuerzo",label:"Almuerzo"},
  {id:"cena",    label:"Cena"},
  {id:"otros",   label:"Otros gastos"},
];

const FORM_VACIO = {
  nombre:"", proyecto:"", actividad:"", fecha_ini:"", fecha_fin:"",
  comentarios:"",
  dias:[{fecha:"",recorrido:"",kms:""}],
  gastos:{}, // {dia_idx: {categoria_id: valor}}
  tickets:[], // [{file, preview, nombre}]
};

// Convierte una solicitud aprobada en una fila de Hojas de gasto
function fechaDDMMYYYY(f){
  if(!f) return "";
  const m=String(f).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m?`${m[3].padStart(2,"0")}/${m[2].padStart(2,"0")}/${m[1]}`:String(f);
}
function datosSolicitud(s){ try{ return JSON.parse(s.datos||"{}"); }catch(e){ return {}; } }
function hojaDesdeSolicitud(s){
  const d=datosSolicitud(s);
  const fechasDias=(d.dias||[]).map(x=>x.fecha).filter(Boolean).sort();
  const creada=s.created_at?new Date(s.created_at):new Date();
  const fecha=fechaDDMMYYYY(d.fecha_fin||fechasDias[fechasDias.length-1]||d.fecha_ini)
    ||`${String(creada.getDate()).padStart(2,"0")}/${String(creada.getMonth()+1).padStart(2,"0")}/${creada.getFullYear()}`;
  const total=Math.round((parseFloat(d.total)||0)*100)/100;
  return {
    id:Date.now(), fecha, concepto:d.actividad||s.nombre_archivo||"", importe:total?total.toFixed(2):"", importe_proyecto:"",
    responsable:d.nombre||"", proyecto:d.proyecto||"",
    proyectos:d.proyecto?[{proyecto:d.proyecto,importe:total.toFixed(2)}]:[],
    reparto:[], link:d.tickets?.[0]?.url||"", pagado:false,
  };
}

function SolicitudHojaGasto({projects, unlocked, hojas, setHojas}){
  const [solicitudes, setSolicitudes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(FORM_VACIO);
  const [enviando, setEnviando] = useState(false);

  useEffect(()=>{
    sb.from("solicitudes_hoja_gasto").select("*").order("created_at",{ascending:false})
      .then(({data})=>{ setSolicitudes(data||[]); setLoading(false); })
      .catch(()=>setLoading(false));
    const ch=sb.channel("rt:sol_hoja")
      .on("postgres_changes",{event:"*",schema:"public",table:"solicitudes_hoja_gasto"},()=>{
        sb.from("solicitudes_hoja_gasto").select("*").order("created_at",{ascending:false})
          .then(({data})=>setSolicitudes(data||[]));
      }).subscribe();
    return ()=>sb.removeChannel(ch);
  },[]);

  function updForm(field, val){ setForm(prev=>({...prev,[field]:val})); }

  function updDia(idx, field, val){
    setForm(prev=>{
      const dias=[...prev.dias];
      dias[idx]={...dias[idx],[field]:val};
      return {...prev,dias};
    });
  }

  function addDia(){ setForm(prev=>({...prev,dias:[...prev.dias,{fecha:"",recorrido:"",kms:""}]})); }
  function delDia(idx){ setForm(prev=>({...prev,dias:prev.dias.filter((_,i)=>i!==idx)})); }

  function updGasto(diaIdx, catId, val){
    setForm(prev=>{
      const gastos={...prev.gastos};
      if(!gastos[diaIdx]) gastos[diaIdx]={};
      gastos[diaIdx]={...gastos[diaIdx],[catId]:val};
      return {...prev,gastos};
    });
  }

  function addTickets(e){
    const files=Array.from(e.target.files||[]);
    const nuevos=files.map(f=>({file:f,nombre:f.name,preview:URL.createObjectURL(f)}));
    setForm(prev=>({...prev,tickets:[...prev.tickets,...nuevos]}));
    e.target.value="";
  }

  function delTicket(idx){ setForm(prev=>({...prev,tickets:prev.tickets.filter((_,i)=>i!==idx)})); }

  function totalCat(catId){
    return form.dias.reduce((s,_,di)=>s+(parseFloat(form.gastos[di]?.[catId])||0),0);
  }

  function totalDia(diaIdx){
    return CATEGORIAS_GASTO.reduce((s,cat)=>s+(parseFloat(form.gastos[diaIdx]?.[cat.id])||0),0);
  }

  function totalGeneral(){
    return CATEGORIAS_GASTO.reduce((s,cat)=>s+totalCat(cat.id),0);
  }

  async function generarYEnviar(){
    if(!form.nombre.trim()){ alert("Selecciona tu nombre"); return; }
    setEnviando(true);
    try{
      // Generar HTML que replica la plantilla
      const dias = form.dias.slice(0,7);
      const nDias = dias.length;
      const fmtEur = v => (parseFloat(v)||0).toLocaleString("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2})+" €";
      const totalCatFn = id => dias.reduce((s,_,di)=>s+(parseFloat(form.gastos[di]?.[id])||0),0);
      const totalDiaFn = di => [
        "km","peaje","taxi","otros_t","billetes","aloj","desayuno","almuerzo","cena","otros"
      ].reduce((s,id)=>s+(parseFloat(form.gastos[di]?.[id])||0),0);
      const grandTotal = dias.reduce((_,__,di)=>_+totalDiaFn(di),0);

      const dayHeaders = dias.map(d=>`<th>${d.fecha||"—"}</th>`).join("")+
        Array(7-nDias).fill("<th></th>").join("");

      function catRow(id,label,alt){
        const bg = alt?"#232831":"#1F232B";
        const cells = dias.map((_,di)=>`<td class="num" style="background:${bg}">${fmtEur(form.gastos[di]?.[id]||0)}</td>`).join("")+
          Array(7-nDias).fill(`<td class="num" style="background:${bg}">—</td>`).join("");
        const tot = totalCatFn(id);
        return `<tr style="background:${bg}"><td colspan="2" class="lbl">${label}</td>${cells}<td class="num tot-cell">${fmtEur(tot)}</td></tr>`;
      }
      function subRow(label,ids){
        const cells = dias.map((_,di)=>{
          const v=ids.reduce((s,id)=>s+(parseFloat(form.gastos[di]?.[id])||0),0);
          return `<td class="num sub-num">${fmtEur(v)}</td>`;
        }).join("")+Array(7-nDias).fill('<td class="num sub-num">—</td>').join("");
        const tot=ids.reduce((s,id)=>s+totalCatFn(id),0);
        return `<tr class="sub-row"><td colspan="2" class="lbl sub-lbl">${label}</td>${cells}<td class="num sub-num">${fmtEur(tot)}</td></tr>`;
      }

      const itRows = dias.map(d=>`
        <tr>
          <td class="it-val">${d.fecha||""}</td>
          <td class="it-val" colspan="8">${d.recorrido||""}</td>
          <td class="it-num">${d.kms||0}</td>
        </tr>`).join("")+
        Array(Math.max(0,5-nDias)).fill(`<tr>${'<td class="it-val"></td>'.repeat(9)}<td class="it-num"></td></tr>`).join("");

      const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Hoja de Gastos — ${form.nombre}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;color:#ECEEF2;background:#1F232B;padding:12px}
h1{font-size:15px;font-weight:800;letter-spacing:-.5px;color:#fff;background:#323844;padding:10px 14px;text-align:center;border-radius:6px 6px 0 0;margin-bottom:0}
.datos-gen{border:1.5px solid #262B34;border-top:none;padding:8px 12px;background:#112845;border-radius:0 0 6px 6px;margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:4px 20px}
.dato-row{display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #1F467A}
.dato-lbl{font-weight:700;font-size:9px;color:#D5D9E0;min-width:90px;text-transform:uppercase;letter-spacing:.3px}
.dato-val{font-size:10px;color:#ECEEF2;font-weight:500}
table{width:100%;border-collapse:collapse;margin-bottom:10px}
.sect-hdr{background:#323844;color:#fff;font-weight:800;font-size:10px;padding:7px 10px;text-align:left}
.day-hdr{background:#3A414D;color:#fff;font-weight:700;font-size:8.5px;text-align:center;padding:5px 3px}
.lbl{padding:5px 8px;font-weight:500;color:#C3C8D0;border-right:1.5px solid #2E343E;text-align:left;font-size:8.5px}
.num{text-align:right;padding:5px 6px;color:#C3C8D0;font-size:8.5px;border-left:1px solid #2E343E}
.tot-cell{background:#112845!important;color:#D5D9E0;font-weight:700;border-left:2px solid #1F477A}
.sub-row{background:#11452B!important}
.sub-lbl{color:#7BF4D2;font-weight:700;background:#11452B}
.sub-num{color:#7BF4D2;font-weight:700;background:#11452B!important}
.total-row td{background:#323844!important;color:#fff;font-weight:800;font-size:10px;padding:7px 8px}
.total-row .num{color:#fff;border-color:#C3C8D0}
tr:nth-child(even) td{background:#232831}
tr:nth-child(even) .num{background:#232831}
.it-val{padding:5px 8px;border-bottom:1px solid #2E343E;font-size:8.5px;color:#C3C8D0}
.it-num{padding:5px 8px;text-align:right;border-bottom:1px solid #2E343E;font-weight:700;font-size:8.5px;color:#D5D9E0}
.coment-box{border:1.5px solid #2E343E;border-radius:6px;padding:8px 12px;min-height:50px;font-size:9px;color:#C3C8D0;margin-bottom:10px;background:#232831}
.firma-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px}
.firma-box{background:#323844;color:#fff;font-weight:700;font-size:9px;text-align:center;padding:10px;border-radius:6px}
.firma-line{border-top:1.5px solid #2E343E;margin-top:28px;padding-top:4px;font-size:8px;color:#7F8692;text-align:center}
.tickets-section{margin-bottom:10px}
.tickets-grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.ticket-img{width:90px;height:90px;object-fit:cover;border-radius:6px;border:1.5px solid #2E343E}
.section-title{background:#3A414D;color:#fff;font-weight:700;font-size:9.5px;padding:6px 10px;border-radius:4px 4px 0 0;margin-bottom:0}
.meta{font-size:8px;color:#7F8692;text-align:right;margin-bottom:6px}
@media print{
  body{padding:6px}
  @page{size:A4;margin:8mm}
}
</style></head><body>
<div class="meta">Generado el ${new Date().toLocaleDateString("es-ES",{day:"2-digit",month:"long",year:"numeric"})} · ${EMPRESA} · ${EMPRESA_SUB}</div>
<h1>HOJA DE GASTOS</h1>
<div class="datos-gen">
  <div class="dato-row"><span class="dato-lbl">Nombre</span><span class="dato-val">${form.nombre}</span></div>
  <div class="dato-row"><span class="dato-lbl">Asociación</span><span class="dato-val">${EMPRESA}</span></div>
  <div class="dato-row"><span class="dato-lbl">Actividad</span><span class="dato-val">${form.actividad||"—"}</span></div>
  <div class="dato-row"><span class="dato-lbl">Proyecto</span><span class="dato-val">${form.proyecto||"—"}</span></div>
  <div class="dato-row"><span class="dato-lbl">Fecha inicio</span><span class="dato-val">${form.fecha_ini||"—"}</span></div>
  <div class="dato-row"><span class="dato-lbl">Fecha fin</span><span class="dato-val">${form.fecha_fin||"—"}</span></div>
</div>

<table>
  <thead>
    <tr><td colspan="${2+7+1}" class="sect-hdr">GASTOS</td></tr>
    <tr>
      <th class="day-hdr" colspan="2" style="text-align:left;padding-left:8px">Categoría</th>
      ${dayHeaders}
      <th class="day-hdr">Totales</th>
    </tr>
  </thead>
  <tbody>
    ${catRow("km","Importe Kilómetros",false)}
    ${catRow("peaje","Peajes",true)}
    ${catRow("taxi","Taxi",false)}
    ${catRow("otros_t","Otros (tren o autobús)",true)}
    ${catRow("billetes","Billetes nacionales",false)}
    ${subRow("→ Total transportes",["km","peaje","taxi","otros_t","billetes"])}
    ${catRow("aloj","Alojamiento",false)}
    ${catRow("desayuno","Desayuno",true)}
    ${catRow("almuerzo","Almuerzo",false)}
    ${catRow("cena","Cena",true)}
    ${subRow("→ Total aloj. y manutención",["aloj","desayuno","almuerzo","cena"])}
    ${catRow("otros","Otros gastos",false)}
    ${subRow("→ Total otros gastos",["otros"])}
    <tr class="total-row">
      <td colspan="2">TOTAL GASTOS A JUSTIFICAR</td>
      ${dias.map((_,di)=>`<td class="num">${fmtEur(totalDiaFn(di))}</td>`).join("")}
      ${Array(7-nDias).fill('<td class="num">—</td>').join("")}
      <td class="num" style="font-size:12px">${fmtEur(grandTotal)}</td>
    </tr>
  </tbody>
</table>

<table>
  <thead>
    <tr><td colspan="10" class="sect-hdr">DETALLE DEL ITINERARIO DEL VIAJE Y RECORRIDO EN KMS.</td></tr>
    <tr>
      <th class="day-hdr" style="width:80px">Fecha</th>
      <th class="day-hdr" colspan="8" style="text-align:left;padding-left:8px">Recorrido realizado</th>
      <th class="day-hdr" style="width:60px">KMS.</th>
    </tr>
  </thead>
  <tbody>${itRows}</tbody>
</table>

<div class="section-title">COMENTARIOS Y OBSERVACIONES</div>
<div class="coment-box">${form.comentarios||""}</div>

${form.tickets&&form.tickets.length>0?`
<div class="section-title" style="margin-bottom:6px">🧾 TICKETS Y JUSTIFICANTES (${form.tickets.length})</div>
<div class="tickets-grid">
  ${form.tickets.map(t=>`<div style="text-align:center"><img src="${t.preview}" class="ticket-img" onerror="this.style.display='none'"/><div style="font-size:7px;color:#9AA1AC;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.nombre}</div></div>`).join("")}
</div>`:""}

<div class="firma-row">
  <div class="firma-box">
    NOMBRE Y FIRMA ASOCIADO
    <div class="firma-line">${form.nombre}</div>
  </div>
  <div class="firma-box">
    APROBADO POR
    <div class="firma-line"> </div>
  </div>
</div>
</body></html>`;

      // Abrir en nueva pestaña para imprimir/guardar PDF
      const win = window.open("","_blank");
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(()=>win.print(),800);

      // Guardar metadatos en BD (sin subir HTML a Storage — se abre directo)
      const ts = Date.now();
      const nombreArchivo = `Hoja_gastos_${form.nombre.replace(/\s+/g,"_")}_${new Date().toLocaleDateString("es-ES").replace(/\//g,"-")}`;
      const xlsxPath = `hojas/${ts}_${nombreArchivo}`;
      let xlsxUrl = "";

      // Subir tickets/fotos
      const ticketsUrls = [];
      for(let i=0;i<form.tickets.length;i++){
        const t=form.tickets[i];
        const tPath=`hojas/tickets/${ts}_${i}_${t.nombre}`;
        const {error:tErr}=await sb.storage.from("hoja_gasto").upload(tPath,t.file);
        if(!tErr){
          const {data:{publicUrl:tUrl}}=sb.storage.from("hoja_gasto").getPublicUrl(tPath);
          ticketsUrls.push({nombre:t.nombre,url:tUrl,path:tPath});
        }
      }

      // Guardar BD — incluir el HTML en datos para poder abrirlo sin pasar por Storage
      const {error:dbErr}=await sb.from("solicitudes_hoja_gasto").insert({
        nombre_archivo: nombreArchivo, url: xlsxUrl, path: xlsxPath,
        estado: "pendiente",
        datos: JSON.stringify({...form,tickets:ticketsUrls,total:grandTotal,html}),
      });
      if(dbErr) console.warn("Error guardando BD:",dbErr.message);

      alert("✅ Hoja de gasto enviada. Se ha abierto una nueva pestaña para imprimir o guardar como PDF.");
      setForm(FORM_VACIO);
      setShowForm(false);
    }catch(err){ console.error(err); alert("Error: "+err.message); }
    setEnviando(false);
  }


  async function cambiarEstado(id, estado){
    await sb.from("solicitudes_hoja_gasto").update({estado}).eq("id",id);
    setSolicitudes(prev=>prev.map(s=>s.id===id?{...s,estado}:s));
    // Al aprobarla, se añade sola al listado de hojas de gasto del dashboard
    if(estado==="aprobada"){ const s=solicitudes.find(x=>x.id===id); if(s&&!datosSolicitud(s).hoja_id){ procesadas.current.add(s.id); const igual=hojaParecida(s); if(igual) guardarEnlace(s,igual.id); else añadirAHojas(s); } }
  }

  // ¿Está ya la solicitud en el listado de hojas? "si" (enlazada), "parece" (misma persona, importe y mes), "no"
  function hojaParecida(s){
    const d=datosSolicitud(s);
    const total=parseFloat(d.total)||0, fecha=hojaDesdeSolicitud(s).fecha;
    const yaEnlazadas=new Set(solicitudes.map(x=>String(datosSolicitud(x).hoja_id||"")).filter(Boolean));
    return (hojas||[]).find(h=>!yaEnlazadas.has(String(h.id))&&(h.responsable||"")===(d.nombre||"")&&Math.abs((parseFloat(h.importe)||0)-total)<0.01&&fechaYM(h.fecha)?.m===fechaYM(fecha)?.m&&fechaYM(h.fecha)?.y===fechaYM(fecha)?.y);
  }
  function estadoListado(s){
    const d=datosSolicitud(s);
    if(d.hoja_id) return "si";   // enlazada (aunque la hoja aún no se haya recargado en esta pestaña)
    return hojaParecida(s)?"parece":"no";
  }
  async function guardarEnlace(s,hojaId){
    const datos=JSON.stringify({...datosSolicitud(s),hoja_id:hojaId});
    setSolicitudes(prev=>prev.map(x=>x.id===s.id?{...x,datos}:x));
    const {error}=await sb.from("solicitudes_hoja_gasto").update({datos}).eq("id",s.id);
    if(error) console.error("❌ enlazar solicitud con hoja",error);
  }
  // Las aprobadas entran solas en el listado: si ya hay una hoja igual se enlaza con ella, si no se crea
  const procesadas=useRef(new Set());
  useEffect(()=>{
    if(loading||!setHojas||!hojas||!hojas.length) return;
    solicitudes.filter(s=>s.estado==="aprobada"&&!datosSolicitud(s).hoja_id&&!procesadas.current.has(s.id)).forEach(s=>{
      procesadas.current.add(s.id);
      const igual=hojaParecida(s);
      if(igual) guardarEnlace(s,igual.id); else añadirAHojas(s);
    });
  },[solicitudes,hojas,loading]);
  async function añadirAHojas(s){
    if(!setHojas) return;
    const nueva=hojaDesdeSolicitud(s);
    setHojas(h=>[...h,nueva]);
    await guardarEnlace(s,nueva.id);
  }

  async function eliminar(id, path, datos){
    if(!window.confirm("¿Eliminar esta solicitud?")) return;
    // Eliminar Excel y tickets
    const paths=[path];
    try{ const d=JSON.parse(datos||"{}"); (d.tickets||[]).forEach(t=>paths.push(t.path)); }catch(e){}
    await sb.storage.from("hoja_gasto").remove(paths);
    await sb.from("solicitudes_hoja_gasto").delete().eq("id",id);
    setSolicitudes(prev=>prev.filter(s=>s.id!==id));
  }

  const pendientes=solicitudes.filter(s=>s.estado==="pendiente");
  const aprobadas =solicitudes.filter(s=>s.estado==="aprobada");
  const rechazadas=solicitudes.filter(s=>s.estado==="rechazada");

  function renderEstadoBadge(estado){
    const cfg={
      pendiente:{bg:"#453B11",color:"#D97706",label:"⏳ Pendiente"},
      aprobada: {bg:"#11452B",color:"#059669",label:"✅ Aprobada"},
      rechazada:{bg:"#451111",color:"#EB8484",label:"❌ Rechazada"},
    }[estado]||{bg:"#262B34",color:"#9AA1AC",label:estado};
    return <span style={{background:cfg.bg,color:cfg.color,fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:99}}>{cfg.label}</span>;
  }

  function renderTarjetaSolicitud(s){
    return <TarjetaSolicitudCard key={s.id} s={s} unlocked={unlocked} cambiarEstado={cambiarEstado} eliminar={eliminar} renderEstadoBadge={renderEstadoBadge}
      enListado={s.estado==="aprobada"?estadoListado(s):null} onAñadir={()=>añadirAHojas(s)}/>;
  }

  // ── FORMULARIO ──────────────────────────────────────────────────────────────

  return(
    <div style={{marginBottom:24}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontWeight:700,fontSize:14,color:"#ECEEF2"}}>📋 Solicitudes de hoja de gasto</div>
          <div style={{fontSize:11,color:"#9AA1AC",marginTop:2}}>Rellena el formulario, adjunta tickets y envía para aprobación</div>
        </div>
        {!showForm&&(
          <button onClick={()=>setShowForm(true)}
            style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"8px 16px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            + Nueva hoja de gastos
          </button>
        )}
      </div>

      {showForm&&<FormularioHojaGasto projects={projects} form={form} updForm={updForm} updDia={updDia} addDia={addDia} delDia={delDia} updGasto={updGasto} addTickets={addTickets} delTicket={delTicket} totalCat={totalCat} totalDia={totalDia} totalGeneral={totalGeneral} enviando={enviando} onCancel={()=>setShowForm(false)} onSubmit={generarYEnviar}/>}

      {loading&&<div style={{padding:20,textAlign:"center",color:"#7F8692",fontSize:11}}>Cargando...</div>}

      {!loading&&solicitudes.length===0&&!showForm&&(
        <div style={{background:"#232831",border:"1px dashed #2E343E",borderRadius:12,padding:"32px",textAlign:"center",color:"#7F8692"}}>
          <div style={{fontSize:32,marginBottom:8}}>📂</div>
          <div style={{fontSize:12}}>No hay solicitudes todavía</div>
          <div style={{fontSize:11,marginTop:4}}>Pulsa "+ Nueva hoja de gastos" para crear la primera</div>
        </div>
      )}

      {pendientes.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontWeight:700,fontSize:10,color:"#D97706",letterSpacing:"0",marginBottom:8}}>⏳ Pendientes ({pendientes.length})</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>{pendientes.map(s=><Fragment key={s.id}>{renderTarjetaSolicitud(s)}</Fragment>)}</div>
        </div>
      )}
      {aprobadas.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontWeight:700,fontSize:10,color:"#059669",letterSpacing:"0",marginBottom:8}}>✅ Aprobadas ({aprobadas.length})</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>{aprobadas.map(s=><Fragment key={s.id}>{renderTarjetaSolicitud(s)}</Fragment>)}</div>
        </div>
      )}
      {rechazadas.length>0&&(
        <div>
          <div style={{fontWeight:700,fontSize:10,color:"#EB8484",letterSpacing:"0",marginBottom:8}}>❌ Rechazadas ({rechazadas.length})</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>{rechazadas.map(s=><Fragment key={s.id}>{renderTarjetaSolicitud(s)}</Fragment>)}</div>
        </div>
      )}
    </div>
  );
}


function HojasGastoTab({hojas, setHojas, gastos, projects, pagoInfo, onSaldada}){
  const [repartoModal, setRepartoModal] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [unlocked, setUnlocked] = useState(false);
  const [showLock, setShowLock] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);

  function requireUnlock(action){
    if(unlocked){ action(); return; }
    setPendingAction(()=>action);
    setShowLock(true);
  }
  function onUnlock(){ setUnlocked(true); setShowLock(false); if(pendingAction){ pendingAction(); setPendingAction(null); } }

  function add(){ requireUnlock(()=>setHojas(h=>[...h,{id:Date.now(),fecha:"",concepto:"",importe:"",importe_proyecto:"",responsable:"",proyecto:"",proyectos:[],reparto:[]}])); }
  function upd(id,field,val){
    if(unlocked){ setHojas(h=>h.map(r=>r.id===id?{...r,[field]:val}:r)); return; }
    requireUnlock(()=>setHojas(h=>h.map(r=>r.id===id?{...r,[field]:val}:r)));
  }
  function del(id){ requireUnlock(()=>setHojas(h=>h.filter(r=>r.id!==id))); }
  function saveReparto(id,rep){ setHojas(h=>h.map(r=>r.id===id?{...r,reparto:rep}:r)); setRepartoModal(null); }

  const rows = hojas||[];
  const totHojas = rows.reduce((s,r)=>s+(parseFloat(r.importe)||0),0);
  const totFact  = gastos.reduce((s,r)=>s+signedBase(r),0);
  const totTotal = totHojas + totFact;
  const ALL_MEMBERS_SEL = [...INIT_MEMBERS,...EXTERNAL_MEMBERS].map(m=>m.name);

  const getYear = f => { if(!f) return "Sin fecha"; const p=f.split('/'); return p.length===3?p[2]:(f.length>=4?f.slice(-4):"Sin fecha"); };
  const years = [...new Set(rows.map(r=>getYear(r.fecha)))].sort((a,b)=>b-a);

  return(
    <div>
      {showLock&&<EditLockModal onUnlock={onUnlock} onClose={()=>setShowLock(false)}/>}
      <SolicitudHojaGasto projects={projects} unlocked={unlocked} hojas={hojas} setHojas={setHojas}/>
      <div style={{borderTop:"1px solid #2E343E",marginBottom:16,marginTop:8}}/>
      {!unlocked&&(
        <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#15181D",border:"1px solid #2E343E",borderRadius:8,padding:"5px 12px",marginBottom:12,fontSize:10,color:"#9AA1AC",cursor:"pointer"}} onClick={()=>setShowLock(true)}>
          🔒 Modo lectura — <span style={{color:"#ECEEF2",fontWeight:600}}>Haz clic para editar</span>
        </div>
      )}
      {unlocked&&(
        <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#11452D",border:"1px solid #1F7A3F",borderRadius:8,padding:"5px 12px",marginBottom:12,fontSize:10,color:"#059669"}}>
          🔓 Modo edición activo
        </div>
      )}
      {repartoModal&&(
        <RepartoModal
          factura={{...repartoModal, base:repartoModal.importe, ref:repartoModal.concepto}}
          onSave={(rep)=>saveReparto(repartoModal.id,rep)}
          onClose={()=>setRepartoModal(null)}
        />
      )}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8,marginBottom:14}}>
        {[
          {label:"🧾 Hojas de gasto", val:`${totHojas.toFixed(0)}€`, color:"#EC8383", bg:"#451111"},
          {label:"💸 Facturas gasto",  val:`${totFact.toFixed(0)}€`,  color:"#EC8383", bg:"#451111"},
          {label:"📊 Total gastos",    val:`${totTotal.toFixed(0)}€`,  color:"#7C3AED", bg:"#2A1145"},
          {label:"📋 Nº registros",    val:rows.length,                color:"#0369A1", bg:"#113145"},
        ].map(k=>(
          <div key={k.label} style={{background:k.bg,borderRadius:10,padding:"10px 12px",border:`1.5px solid ${k.color}22`}}>
            <div style={{fontSize:9,color:"#9AA1AC",marginBottom:2}}>{k.label}</div>
            <div style={{fontSize:18,fontWeight:900,color:k.color}}>{k.val}</div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginBottom:10}}>
        <LibroBoton lista={hojas} label="Libro de hojas de gasto" onDescargar={y=>descargarLibroHojas(hojas,y)}/>
        <button onClick={add} style={{background:"#B91C1C",color:"#FFF",border:"none",borderRadius:7,padding:"6px 16px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Nuevo gasto</button>
      </div>

      {years.map(year=>{
        const yrows = rows.filter(r=>getYear(r.fecha)===year);
        const yTot = yrows.reduce((s,r)=>s+(parseFloat(r.importe)||0),0);
        const currentYear=new Date().getFullYear().toString();
        const isOpen=collapsed[year]===undefined?year===currentYear:!collapsed[year];
        return(
          <div key={year} style={{marginBottom:12,borderRadius:12,overflow:"hidden",border:"1px solid #991B1B33"}}>
            <div onClick={()=>setCollapsed(c=>({...c,[year]:!c[year]}))}
              style={{background:"#B91C1C",padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
              <span style={{color:"#FFF",fontWeight:700,fontSize:13}}>📅 {year} · {yrows.length} registros</span>
              <div style={{display:"flex",gap:16,alignItems:"center"}}>
                <span style={{color:"#FFFFFF99",fontSize:11,fontWeight:700}}>Total: {yTot.toFixed(0)}€</span>
                <span style={{color:"#FFF",fontSize:14}}>{isOpen?"▲":"▼"}</span>
              </div>
            </div>
            {isOpen&&(
              <div style={{overflowX:"auto",background:"#1F232B"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <THead cols={["Fecha","Link","Importe total €","Proyectos (proyecto + importe)","Responsable","Pagado","Reparto",""]} color="#B91C1C"/>
                  <tbody>
                    {yrows.map((r,i)=>{
                      const proj=projects.find(p=>p.name===r.proyecto);
                      const hasReparto=r.reparto?.some(x=>parseFloat(x.importe)>0);
                      const sumaReparto=(r.reparto||[]).reduce((s,x)=>s+(parseFloat(x.importe)||0),0);
                      const baseNum=parseFloat(r.importe)||0;
                      const repartoCompleto=hasReparto&&baseNum>0&&sumaReparto>=(baseNum-0.05);
                      const faltaReparto=hasReparto&&!repartoCompleto&&baseNum>0;
                      const falta=baseNum-sumaReparto;
                      return(
                        <tr key={r.id} style={{background:fondoEstado(estadoPago(pagoInfo,`hoja:${r.id}`,r.fecha,r.pagado),i)}}>
                          <td style={{padding:"3px 5px"}}><DateInp value={r.fecha||""} onChange={v=>upd(r.id,"fecha",v)} w="110px" locked={!unlocked} onLock={()=>setShowLock(true)}/></td>
                          <td style={{padding:"3px 5px"}}><LinkInp value={r.link||""} onChange={v=>upd(r.id,"link",v)} placeholder="Link ticket/factura"/></td>
                          <td style={{padding:"3px 5px"}}><Inp value={r.importe} onChange={v=>upd(r.id,"importe",v)} placeholder="0.00" w="80px" color="#B91C1C" bold/></td>
                          <td style={{padding:"3px 5px"}}>
                            {/* Multi-project selector */}
                            <div style={{display:"flex",flexDirection:"column",gap:3}}>
                              {(r.proyectos&&r.proyectos.length>0?r.proyectos:[{proyecto:r.proyecto||"",importe:""}]).map((prow,pi)=>(
                                <div key={pi} style={{display:"flex",gap:3,alignItems:"center"}}>
                                  <Sel value={prow.proyecto||""} onChange={v=>{
                                    const newProws=[...(r.proyectos&&r.proyectos.length>0?r.proyectos:[{proyecto:r.proyecto||"",importe:""}])];
                                    newProws[pi]={...newProws[pi],proyecto:v};
                                    upd(r.id,"proyectos",newProws);
                                    if(pi===0) upd(r.id,"proyecto",v);
                                  }} options={projects.map(p=>p.name)} placeholder="— Proyecto —"/>
                                  <Inp value={prow.importe||""} onChange={v=>{
                                    const newProws=[...(r.proyectos&&r.proyectos.length>0?r.proyectos:[{proyecto:r.proyecto||"",importe:""}])];
                                    newProws[pi]={...newProws[pi],importe:v};
                                    upd(r.id,"proyectos",newProws);
                                  }} placeholder="€" w="55px"/>
                                  {pi>0&&<button onClick={()=>{
                                    const newProws=(r.proyectos||[]).filter((_,i)=>i!==pi);
                                    upd(r.id,"proyectos",newProws);
                                  }} style={{background:"none",border:"none",color:"#EB8484",cursor:"pointer",fontSize:12,padding:"0 2px"}}>✕</button>}
                                </div>
                              ))}
                              <button onClick={()=>{
                                const cur=r.proyectos&&r.proyectos.length>0?r.proyectos:[{proyecto:r.proyecto||"",importe:""}];
                                upd(r.id,"proyectos",[...cur,{proyecto:"",importe:""}]);
                              }} style={{background:"none",border:"1px dashed #AEADA8",borderRadius:4,color:"#9AA1AC",cursor:"pointer",fontSize:9,padding:"1px 6px",fontFamily:"inherit",textAlign:"left"}}>+ proyecto</button>
                            </div>
                          </td>
                          <td style={{padding:"3px 5px"}}>
                            <Sel value={r.responsable} onChange={v=>upd(r.id,"responsable",v)} options={ALL_MEMBERS_SEL} placeholder="— Persona —"/>
                          </td>
                          <td style={{padding:"3px 5px",textAlign:"center"}}><EstadoPagoBadge estado={estadoPago(pagoInfo,`hoja:${r.id}`,r.fecha,r.pagado)}
                            nota={pagoInfo?.saldadas?.[`hoja:${r.id}`]?.nota}
                            onClick={onSaldada?()=>requireUnlock(()=>onSaldada(`hoja:${r.id}`,`la hoja de ${r.responsable||"—"} (${r.fecha||"s/f"})`)):undefined}/></td>
                          <td style={{padding:"3px 5px"}}>
                            <button onClick={()=>requireUnlock(()=>setRepartoModal(r))}
                              style={{background:repartoCompleto?"#11452B":faltaReparto?"#453B11":"#452311",color:repartoCompleto?"#059669":faltaReparto?"#D97706":"#E8501C",border:faltaReparto?"1px solid #7A651F":"none",borderRadius:6,padding:"3px 9px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
                              {repartoCompleto?"✅ Repartido":faltaReparto?`⚠️ Falta ${falta.toFixed(0)}€`:"🔀 Repartir"}
                            </button>
                          </td>
                          <td style={{padding:"3px 5px"}}><DelBtn onClick={()=>del(r.id)}/></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{background:"#451111"}}>
                      <td colSpan={3} style={{padding:"5px 8px",fontWeight:700,fontSize:11,color:"#EC8383"}}>TOTAL {year}</td>
                      <td style={{padding:"5px 8px",fontWeight:900,fontSize:13,color:"#EC8383"}}>{yTot.toFixed(2)}€</td>
                      <td colSpan={3}/>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {rows.length===0&&(
        <div style={{padding:40,textAlign:"center",color:"#7F8692"}}>
          <div style={{fontSize:28,marginBottom:6}}>🧾</div>
          <div style={{fontWeight:700}}>Sin hojas de gasto</div>
          <div style={{fontSize:11}}>Añade tickets y gastos sin factura</div>
        </div>
      )}
    </div>
  );
}

// ── LIBROS (se descargan desde Ingresos, Gastos y Hojas de gasto) ─────────────
function descargarInformeHTML(title, body){
  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${title}</title>
<style>
  body{font-family:'Helvetica Neue',Arial,sans-serif;margin:0;padding:40px;color:#ECEEF2;background:#1F232B;font-size:12px}
  h1{font-size:22px;font-weight:800;margin:0 0 4px;letter-spacing:-0.5px}
  h2{font-size:14px;font-weight:700;margin:24px 0 8px;padding-bottom:4px;border-bottom:2px solid #1C1C1E}
  .meta{color:#AEADA8;font-size:10px;margin-bottom:32px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:11px}
  th{background:#2C323C;color:#FFF;padding:6px 10px;text-align:left;font-weight:600;font-size:10px;letter-spacing:0.3px;text-transform:uppercase}
  td{padding:6px 10px;border-bottom:1px solid #635A36}
  tr:nth-child(even) td{background:#38321E}
  .total td{font-weight:800;background:#262B34!important;border-top:2px solid #1C1C1E}
  .kpi{display:inline-block;margin:0 16px 16px 0;background:#232831;border:1px solid #2E343E;border-radius:8px;padding:10px 16px;min-width:120px}
  .kpi-label{font-size:9px;color:#AEADA8;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:4px}
  .kpi-val{font-size:20px;font-weight:800}
  @media print{body{padding:20px}}
</style>
</head>
<body>
<h1>${EMPRESA} — ${title}</h1>
<div class="meta">Generado el ${new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'long',year:'numeric'})} · ${EMPRESA} · ${EMPRESA_SUB}</div>
${body}
</body></html>`;
  const blob = new Blob([html],{type:'text/html'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${EMPRESA.replace(/\s+/g,'_')}_${title.replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.html`;
  a.click();
}
const _f2=n=>(parseFloat(n)||0).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2});
const _esc=x=>String(x??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// Libro de facturas emitidas (tipo "ingresos") o recibidas (tipo "gastos"). year = número o "todos"
function descargarLibroFacturas(tipo, lista, year){
  const emit=tipo==="ingresos";
  const sel=(lista||[]).filter(r=>year==="todos"||fechaYM(r.fecha)?.y===+year);
  const ts=r=>{ const ym=fechaYM(r.fecha); return ym?ym.y*10000+ym.m*100+(parseInt(String(r.fecha).split(/[\/\-.]/)[String(r.fecha).includes('-')?2:0])||0):0; };
  const num=r=>{ const m=(r.ref||'').match(/(\d+)$/); return m?parseInt(m[1]):9999; };
  const sorted=[...sel].sort((a,b)=>emit?((fechaYM(a.fecha)?.y||0)-(fechaYM(b.fecha)?.y||0)||num(a)-num(b)):(ts(a)-ts(b)||num(a)-num(b)));
  const base=r=>signedBase(r), tot=r=>totalFirmado(r), cuota=r=>tot(r)-base(r);
  const sum=fn=>sorted.reduce((s,r)=>s+fn(r),0);
  const titulo=`Libro de Facturas ${emit?'Emitidas':'Recibidas'} ${year==="todos"?'(todos los años)':year}`;
  const rows=sorted.map(r=>`<tr>
    <td>${_esc(r.ref||'—')}</td><td>${_esc(r.fecha||'—')}</td><td>${_esc(r.descripcion||'—')}</td>
    <td>${_esc(r.proyecto||'—')}</td><td style="text-align:right">${_f2(base(r))}€</td>
    <td style="text-align:right">${_esc(r.iva||'—')}</td><td style="text-align:right">${_f2(cuota(r))}€</td><td style="text-align:right">${_f2(tot(r))}€</td>
    <td style="text-align:center">${r.pagado?'✓':'—'}</td>
  </tr>`).join('');
  descargarInformeHTML(titulo,`
    <div class="kpi"><div class="kpi-label">Facturas</div><div class="kpi-val">${sorted.length}</div></div>
    <div class="kpi"><div class="kpi-label">Base imponible</div><div class="kpi-val">${_f2(sum(base))}€</div></div>
    <div class="kpi"><div class="kpi-label">IVA ${emit?'repercutido':'soportado'}</div><div class="kpi-val">${_f2(sum(cuota))}€</div></div>
    <div class="kpi"><div class="kpi-label">${emit?'Cobradas':'Pagadas'}</div><div class="kpi-val">${sorted.filter(r=>r.pagado).length}</div></div>
    <div class="kpi"><div class="kpi-label">Pendientes</div><div class="kpi-val">${sorted.filter(r=>!r.pagado).length}</div></div>
    <h2>Detalle de facturas ${emit?'emitidas':'recibidas'}</h2>
    <table><thead><tr><th>Referencia</th><th>Fecha</th><th>${emit?'Cliente':'Proveedor'} / Descripción</th><th>Proyecto</th><th>Base €</th><th>IVA</th><th>Cuota IVA €</th><th>Total €</th><th>${emit?'Cobrada':'Pagada'}</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="total"><td colspan="4">TOTAL</td><td style="text-align:right">${_f2(sum(base))}€</td><td></td><td style="text-align:right">${_f2(sum(cuota))}€</td><td style="text-align:right">${_f2(sum(tot))}€</td><td></td></tr></tfoot>
    </table>`);
}
function descargarLibroHojas(hojas, year){
  const sel=(hojas||[]).filter(r=>year==="todos"||fechaYM(r.fecha)?.y===+year);
  const sorted=[...sel].sort((a,b)=>bancoTs(a.fecha)-bancoTs(b.fecha));
  const total=sorted.reduce((s,r)=>s+(parseFloat(r.importe)||0),0);
  const rows=sorted.map(r=>`<tr>
    <td>${_esc(r.fecha||'—')}</td><td>${_esc(r.responsable||'—')}</td><td>${_esc(hojaPorProyecto(r).map(x=>x.proyecto).filter(Boolean).join(', ')||'—')}</td>
    <td style="text-align:right">${_f2(r.importe)}€</td><td style="text-align:center">${r.pagado?'✓':'—'}</td>
  </tr>`).join('');
  descargarInformeHTML(`Libro de Hojas de Gasto ${year==="todos"?'(todos los años)':year}`,`
    <div class="kpi"><div class="kpi-label">Registros</div><div class="kpi-val">${sorted.length}</div></div>
    <div class="kpi"><div class="kpi-label">Importe total</div><div class="kpi-val">${_f2(total)}€</div></div>
    <div class="kpi"><div class="kpi-label">Pendientes de pago</div><div class="kpi-val">${sorted.filter(r=>!r.pagado).length}</div></div>
    <h2>Detalle de hojas de gasto</h2>
    <table><thead><tr><th>Fecha</th><th>Responsable</th><th>Proyecto</th><th>Importe €</th><th>Pagada</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="total"><td colspan="3">TOTAL</td><td style="text-align:right">${_f2(total)}€</td><td></td></tr></tfoot>
    </table>`);
}
// Botón "⬇ Libro" con selector de año
function LibroBoton({lista, label, onDescargar}){
  const años=[...new Set((lista||[]).map(r=>fechaYM(r.fecha)?.y).filter(y=>y&&y>2000&&y<2100))].sort((a,b)=>b-a);
  const actual=new Date().getFullYear();
  const [year,setYear]=useState(()=>años.includes(actual)?String(actual):String(años[0]||actual));
  return(
    <div style={{display:"flex",alignItems:"stretch",border:"1px solid #2E343E",borderRadius:7,overflow:"hidden",background:"#262B34"}} title="Descarga el libro en HTML (ábrelo y Cmd+P para guardarlo en PDF)">
      <button onClick={()=>onDescargar(year)} style={{background:"transparent",color:"#C3C8D0",border:"none",padding:"6px 10px 6px 12px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>⬇ {label}</button>
      <select value={year} onChange={e=>setYear(e.target.value)} style={{border:"none",borderLeft:"1px solid #2E343E",background:"#1F232B",fontSize:11,fontFamily:"inherit",padding:"0 4px",color:"#C3C8D0",cursor:"pointer"}}>
        {años.map(y=><option key={y} value={y}>{y}</option>)}
        <option value="todos">Todos</option>
      </select>
    </div>
  );
}

// ── CLOCKIFY HORAS TAB ────────────────────────────────────────────────────────
const PROJ_COLORS = [
  "#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6",
  "#06B6D4","#EC4899","#84CC16","#F97316","#E8501C",
  "#14B8A6","#E11D48","#FBBF24","#22C55E","#A855F7",
];

// ── HORAS: registro interno del dashboard (sustituye a Clockify) ──────────────
// Cada registro es una fila de audit_progress: key "horas|<id>", val = {id, persona, proyecto, descripcion,
// inicio (ISO), fin (ISO), segundos, enCurso, origen}. Una fila por registro → nadie pisa lo de otro.
const HORAS_PREF="horas|";
async function horasLoad(){
  const out=[]; const paso=1000;
  for(let from=0;;from+=paso){
    const {data,error}=await sb.from("audit_progress").select("key,val").like("key",HORAS_PREF+"%").range(from,from+paso-1);
    if(error) throw error;
    (data||[]).forEach(r=>{ if(r.val&&r.val.inicio&&!r.val.borrado) out.push(r.val); });
    if(!data||data.length<paso) break;
  }
  return out;
}
async function horasGuardar(lista){
  const arr=Array.isArray(lista)?lista:[lista];
  for(let i=0;i<arr.length;i+=200){
    const {error}=await sb.from("audit_progress").upsert(arr.slice(i,i+200).map(e=>({key:HORAS_PREF+e.id,val:e})),{onConflict:"key"});
    if(error) throw error;
  }
}
async function horasBorrar(id){
  const {error}=await sb.from("audit_progress").delete().eq("key",HORAS_PREF+id);
  if(error){
    const r=await sb.from("audit_progress").upsert({key:HORAS_PREF+id,val:{id,borrado:true}},{onConflict:"key"});
    if(r.error) throw r.error;
  }
}
const horasSegs=e=>e.enCurso?Math.max(0,(Date.now()-new Date(e.inicio).getTime())/1000):(parseFloat(e.segundos)||0);
// {persona:{proyecto:segundos}} de los registros que empiezan entre dos instantes (ms)
function horasMatriz(entries,desde,hasta){
  const m={};
  (entries||[]).forEach(e=>{
    const t=new Date(e.inicio).getTime();
    if(!(t>=desde&&t<=hasta)) return;
    const p=e.persona||"Sin persona", pr=e.proyecto||"Sin proyecto";
    if(!m[p]) m[p]={};
    m[p][pr]=(m[p][pr]||0)+horasSegs(e);
  });
  return m;
}
// Semana (lunes-domingo), mes, año o personalizado → [desde, hasta] en ms (hora local)
function rangoPeriodo(r,dateFrom,dateTo){
  const now=new Date();
  if(r==="week"){ const dow=now.getDay()===0?7:now.getDay(); const mon=new Date(now.getFullYear(),now.getMonth(),now.getDate()-(dow-1)); return [mon.getTime(),new Date(mon.getFullYear(),mon.getMonth(),mon.getDate()+7).getTime()-1]; }
  if(r==="month") return [new Date(now.getFullYear(),now.getMonth(),1).getTime(),new Date(now.getFullYear(),now.getMonth()+1,1).getTime()-1];
  if(r==="year") return [new Date(now.getFullYear(),0,1).getTime(),new Date(now.getFullYear()+1,0,1).getTime()-1];
  const p=s=>{ const [y,m,d]=String(s||"").split("-").map(Number); return y?new Date(y,m-1,d):null; };
  const a=p(dateFrom), b=p(dateTo);
  return [a?a.getTime():0, b?new Date(b.getFullYear(),b.getMonth(),b.getDate()+1).getTime()-1:Date.now()];
}
function useHoras(){
  const [entries,setEntries]=useState(null);
  const recargar=useCallback(()=>horasLoad().then(setEntries).catch(e=>{ console.error("❌ horas load",e); setEntries(x=>x||[]); }),[]);
  useEffect(()=>{ recargar(); },[recargar]);
  return [entries,setEntries,recargar];
}
const fmtHoras=s=>{ const h=Math.floor(s/3600), m=Math.floor((s%3600)/60); return h+"h"+(m>0?" "+m+"m":""); };
const fmtReloj=s=>{ s=Math.floor(s); const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), x=s%60; return `${h}:${String(m).padStart(2,"0")}:${String(x).padStart(2,"0")}`; };
const hhmm=iso=>{ const d=new Date(iso); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };
const ymdLocal=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
// "1:30" → 5400 · "1,5" / "1.5" → 5400 · "45m" → 2700
function parseDuracion(s){
  const t=String(s||"").trim().toLowerCase().replace(/\s+/g,"");
  if(!t) return 0;
  let m=t.match(/^(\d+):(\d{1,2})$/); if(m) return (+m[1])*3600+(+m[2])*60;
  m=t.match(/^(\d+)h(\d{1,2})?m?$/); if(m) return (+m[1])*3600+(+(m[2]||0))*60;
  m=t.match(/^(\d+)m(in)?$/); if(m) return (+m[1])*60;
  const n=parseFloat(t.replace(",",".")); return isNaN(n)?0:Math.round(n*3600);
}
// Interruptor bien visible: ¿estas horas son facturables o no?
function FactSwitch({value,onChange,compact}){
  const op=(v,label,on,off)=>(
    <button type="button" onClick={()=>{ if(value!==v) onChange(v); }}
      style={{background:value===v?on:"transparent",color:value===v?"#FFF":"#9AA1AC",border:"none",
      padding:compact?"4px 10px":"9px 16px",fontSize:compact?10.5:12.5,fontWeight:value===v?800:500,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>{label}</button>
  );
  return(
    <div title="Elige si estas horas son facturables o no" style={{display:"inline-flex",border:"1.5px solid #4A515D",borderRadius:compact?7:10,overflow:"hidden",background:"#232831"}}>
      {op(true,"€ Facturable","#059669")}
      {op(false,"No facturable","#6B7280")}
    </div>
  );
}
const TODOS="__todos"; // "persona" especial: las horas se cuentan a todo el equipo a la vez
const HORAS_ACT_DEFAULT=["Training Session","TLT","Finanzas","Reuniones de equipo","Formación"];
const nuevoIdHoras=()=>`${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

function HorasTab({projects}){
  const [entries,setEntries,recargar]=useHoras();
  // Cada uno registra sus horas con su propio perfil; solo los admin pueden cambiar de persona.
  const [persona,setPersonaRaw]=useState(()=>{
    if(perfil.nombre&&perfil.rol!=="admin") return perfil.nombre;
    try{ return localStorage.getItem("blesk_horas_persona")||perfil.nombre||MIEMBROS_VISIBLES[0].name; }catch{ return perfil.nombre||MIEMBROS_VISIBLES[0].name; }
  });
  const setPersona=p=>{ if(perfil.rol!=="admin"&&p!==perfil.nombre) return; setPersonaRaw(p); if(p!==TODOS){ try{ localStorage.setItem("blesk_horas_persona",p); }catch{} } };
  const [proyecto,setProyecto]=useState("");
  const [desc,setDesc]=useState("");
  const [facturable,setFacturableRaw]=useState(()=>{ try{ return localStorage.getItem("blesk_horas_fact")!=="0"; }catch{ return true; } });
  const setFacturable=v=>{ setFacturableRaw(v); try{ localStorage.setItem("blesk_horas_fact",v?"1":"0"); }catch{} };
  const [modo,setModo]=useState("timer");
  const hoyStr=ymdLocal(new Date());
  const [mFecha,setMFecha]=useState(hoyStr);
  const [mIni,setMIni]=useState("");
  const [mFin,setMFin]=useState("");
  const [mDur,setMDur]=useState("");
  const [verTodos,setVerTodos]=useState(false);
  const [nLista,setNLista]=useState(40);
  const [range,setRange]=useState("week");
  const [dateFrom,setDateFrom]=useState("");
  const [dateTo,setDateTo]=useState("");
  const [viewMode,setViewMode]=useState("persona");
  const [,setTick]=useState(0);
  const [imp,setImp]=useState({abierto:false,desde:`${new Date().getFullYear()}-01-01`,hasta:hoyStr,estado:"",msg:""});

  const lista=entries||[];
  const esTodos=persona===TODOS;
  const nombresEquipo=MIEMBROS_VISIBLES.map(m=>m.name);
  const enMarcha=esTodos?lista.find(e=>e.enCurso&&e.grupo&&nombresEquipo.includes(e.persona)):lista.find(e=>e.enCurso&&e.persona===persona);
  const algunoEnMarcha=lista.some(e=>e.enCurso);
  useEffect(()=>{ if(!algunoEnMarcha) return; const t=setInterval(()=>setTick(x=>x+1),1000); return ()=>clearInterval(t); },[algunoEnMarcha]);
  // Se recarga cada minuto para ver lo que meten los demás
  useEffect(()=>{ const t=setInterval(()=>recargar(),60000); return ()=>clearInterval(t); },[recargar]);

  const [ocultosH]=useProyectosOcultos();
  const proyNames=(projects||[]).map(p=>p.name).filter(n=>n&&!ocultosH.includes(n));
  // Otras actividades en las que imputar horas (Training Sessions, TLT, finanzas…): se guardan en audit_progress "horas_actividades"
  const [actividades,setActividades]=useState(HORAS_ACT_DEFAULT);
  const [gestionAct,setGestionAct]=useState(false);
  useEffect(()=>{ sb.from("audit_progress").select("val").eq("key","horas_actividades").maybeSingle().then(({data})=>{ if(Array.isArray(data?.val)) setActividades(data.val); }).catch(()=>{}); },[]);
  function guardarActividades(l){ setActividades(l); sb.from("audit_progress").upsert({key:"horas_actividades",val:l},{onConflict:"key"}).then(({error})=>{ if(error) errorGuardar(error); }); }
  function nuevaActividad(){
    const n=(window.prompt("Nombre de la nueva actividad (por ejemplo: Training Session, TLT, Finanzas…):")||"").trim();
    if(!n) return null;
    if(![...actividades,...proyNames].some(x=>x.toLowerCase()===n.toLowerCase())) guardarActividades([...actividades,n]);
    return [...actividades,...proyNames].find(x=>x.toLowerCase()===n.toLowerCase())||n;
  }
  function quitarActividad(n){
    if(!window.confirm(`¿Quitar "${n}" de la lista? Las horas ya registradas en ella se mantienen.`)) return;
    guardarActividades(actividades.filter(x=>x!==n));
  }
  const opcionesProyecto=extra=>(<>
    <optgroup label="🧩 Otras actividades">{actividades.map(p=><option key={p} value={p}>{p}</option>)}</optgroup>
    <option value="__nueva">➕ Nueva actividad…</option>
    <optgroup label="📁 Proyectos">{[...new Set([...proyNames,...(extra&&!actividades.includes(extra)&&!proyNames.includes(extra)?[extra]:[])])].map(p=><option key={p} value={p}>{p}</option>)}</optgroup>
  </>);
  const errorGuardar=err=>{ console.error("❌ horas",err); alert("No se ha podido guardar: "+(err?.message||err)); recargar(); };
  function guardar(e){ setEntries(prev=>[e,...(prev||[]).filter(x=>x.id!==e.id)]); horasGuardar(e).catch(errorGuardar); }

  // Guarda varios registros de golpe (modo "Todos")
  function guardarVarios(nuevos){
    const ids=new Set(nuevos.map(x=>x.id));
    setEntries(prev=>[...nuevos,...(prev||[]).filter(x=>!ids.has(x.id))]);
    horasGuardar(nuevos).catch(errorGuardar);
  }
  const cerrar=(e,cuando)=>({...e,fin:cuando.toISOString(),segundos:Math.max(0,Math.round((cuando.getTime()-new Date(e.inicio).getTime())/1000)),enCurso:false});
  function empezar(pr=proyecto,de=desc,fa=facturable){
    const ahora=new Date();
    if(esTodos){
      // Un temporizador para cada miembro; si alguien ya tenía uno en marcha, se cierra
      const grupo=nuevoIdHoras();
      const cerrados=lista.filter(e=>e.enCurso&&nombresEquipo.includes(e.persona)).map(e=>cerrar(e,ahora));
      const nuevos=nombresEquipo.map(n=>({id:nuevoIdHoras(),persona:n,proyecto:pr,descripcion:de.trim(),facturable:!!fa,inicio:ahora.toISOString(),fin:null,segundos:0,enCurso:true,grupo}));
      guardarVarios([...cerrados,...nuevos]);
      setProyecto(pr); setDesc(de); setFacturable(!!fa);
      return;
    }
    if(enMarcha) parar(enMarcha,ahora);
    guardar({id:nuevoIdHoras(),persona,proyecto:pr,descripcion:de.trim(),facturable:!!fa,inicio:ahora.toISOString(),fin:null,segundos:0,enCurso:true});
    setProyecto(pr); setDesc(de); setFacturable(!!fa);
  }
  function parar(e,cuando=new Date()){
    if(e.grupo&&esTodos){
      // Para el temporizador de todo el equipo a la vez
      guardarVarios(lista.filter(x=>x.enCurso&&x.grupo===e.grupo).map(x=>cerrar(x,cuando)));
      setDesc("");
      return;
    }
    guardar(cerrar(e,cuando));
    setDesc("");
  }
  function añadirManual(){
    const [y,mo,d]=mFecha.split("-").map(Number);
    if(!y){ alert("Pon la fecha"); return; }
    const hm=s=>{ const x=String(s||"").match(/^(\d{1,2}):(\d{2})$/); return x?[+x[1],+x[2]]:null; };
    const a=hm(mIni)||[9,0];
    const ini=new Date(y,mo-1,d,a[0],a[1]);
    let segs=0;
    const b=hm(mFin);
    if(b){ let fin=new Date(y,mo-1,d,b[0],b[1]); if(fin<=ini) fin=new Date(fin.getTime()+864e5); segs=(fin-ini)/1000; }
    else segs=parseDuracion(mDur);
    if(!(segs>0)){ alert("Pon la hora de fin o la duración (por ejemplo 1:30 o 1,5)"); return; }
    const base={proyecto,descripcion:desc.trim(),facturable,inicio:ini.toISOString(),fin:new Date(ini.getTime()+segs*1000).toISOString(),segundos:Math.round(segs),enCurso:false};
    if(esTodos){ const grupo=nuevoIdHoras(); guardarVarios(nombresEquipo.map(n=>({...base,id:nuevoIdHoras(),persona:n,grupo}))); }
    else guardar({id:nuevoIdHoras(),persona,...base});
    setDesc(""); setMFin(""); setMDur(""); setMIni(b?mFin:"");
  }
  function borrar(e){
    if(!esTodos&&e.persona!==persona){ alert(`Solo ${e.persona} puede borrar sus horas. Elige su perfil arriba para hacerlo.`); return; }
    if(!window.confirm(`¿Borrar ${fmtHoras(horasSegs(e))} de ${e.persona}${e.proyecto?` en ${e.proyecto}`:""}?`)) return;
    setEntries(prev=>(prev||[]).filter(x=>x.id!==e.id));
    horasBorrar(e.id).catch(errorGuardar);
  }
  function cambiarHoras(e){
    const r=window.prompt("Horas (inicio-fin, por ejemplo 09:00-11:30) o duración (por ejemplo 2:15):",e.enCurso?hhmm(e.inicio):`${hhmm(e.inicio)}-${hhmm(e.fin||e.inicio)}`);
    if(r===null) return;
    const d0=new Date(e.inicio);
    const x=r.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if(x){
      const ini=new Date(d0.getFullYear(),d0.getMonth(),d0.getDate(),+x[1],+x[2]);
      let fin=new Date(d0.getFullYear(),d0.getMonth(),d0.getDate(),+x[3],+x[4]); if(fin<=ini) fin=new Date(fin.getTime()+864e5);
      guardar({...e,inicio:ini.toISOString(),fin:fin.toISOString(),segundos:Math.round((fin-ini)/1000),enCurso:false});
      return;
    }
    const s=parseDuracion(r);
    if(s>0) guardar({...e,fin:new Date(d0.getTime()+s*1000).toISOString(),segundos:s,enCurso:false});
    else alert("No entiendo ese formato");
  }
  function cambiarFecha(e,v){
    const [y,mo,d]=v.split("-").map(Number); if(!y) return;
    const d0=new Date(e.inicio), ini=new Date(y,mo-1,d,d0.getHours(),d0.getMinutes());
    guardar({...e,inicio:ini.toISOString(),fin:e.enCurso?null:new Date(ini.getTime()+(e.segundos||0)*1000).toISOString()});
  }

  // ── Traer las horas antiguas de Clockify (mientras la API siga respondiendo) ──
  async function importarClockify(){
    setImp(s=>({...s,estado:"cargando",msg:""}));
    try{
      const todas=[];
      for(let page=1;page<=30;page++){
        const res=await fetch(`/api/clockify?path=${encodeURIComponent(`workspaces/${CLOCKIFY_WS}/reports/detailed`)}`,{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({dateRangeStart:`${imp.desde}T00:00:00.000Z`,dateRangeEnd:`${imp.hasta}T23:59:59.999Z`,detailedFilter:{page,pageSize:1000},exportType:"JSON"}),
        });
        if(!res.ok) throw new Error(`Clockify ha respondido ${res.status}`);
        const data=await res.json();
        const te=data?.timeentries||data?.timeEntries||[];
        todas.push(...te);
        if(te.length<1000) break;
      }
      const norm=n=>String(n||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").trim().split(/\s+/)[0];
      const nuevas=todas.map(t=>{
        const ti=t.timeInterval||{};
        if(!ti.start) return null;
        const blesk=INIT_MEMBERS.find(m=>norm(m.name)===norm(t.userName))||INIT_MEMBERS.find(m=>norm(t.userName).includes(norm(m.name)));
        const proyC=t.projectName||"";
        const proy=proyNames.find(p=>p.toLowerCase()===proyC.toLowerCase())||proyC;
        let segs=typeof ti.duration==="number"?ti.duration:(ti.end?(new Date(ti.end)-new Date(ti.start))/1000:0);
        return {id:`ck_${t._id||t.id}`,persona:blesk?blesk.name:(t.userName||"Sin persona"),proyecto:proy,descripcion:t.description||"",facturable:t.billable!==false,
          inicio:new Date(ti.start).toISOString(),fin:ti.end?new Date(ti.end).toISOString():null,segundos:Math.round(segs),enCurso:false,origen:"clockify"};
      }).filter(e=>e&&e.segundos>0);
      if(!nuevas.length){ setImp(s=>({...s,estado:"ok",msg:"Clockify no ha devuelto horas en esas fechas."})); return; }
      await horasGuardar(nuevas);
      setEntries(prev=>{ const ids=new Set(nuevas.map(e=>e.id)); return [...nuevas,...(prev||[]).filter(e=>!ids.has(e.id))]; });
      setImp(s=>({...s,estado:"ok",msg:`✅ ${nuevas.length} registros traídos de Clockify (${fmtHoras(nuevas.reduce((a,e)=>a+e.segundos,0))}). Si lo vuelves a traer no se duplican.`}));
    }catch(err){
      console.error("❌ importar Clockify",err);
      setImp(s=>({...s,estado:"error",msg:`No se ha podido leer Clockify: ${err.message}. Si la cuenta ya no da acceso a la API, exporta las horas desde Clockify y pásamelas.`}));
    }
  }

  // ── Lista de registros (como Clockify: por días) ──
  const visibles=lista.filter(e=>verTodos||esTodos||e.persona===persona).sort((a,b)=>new Date(b.inicio)-new Date(a.inicio));
  const mostrados=visibles.slice(0,nLista);
  const porDia=[];
  mostrados.forEach(e=>{ const k=ymdLocal(new Date(e.inicio)); let g=porDia.find(x=>x.k===k); if(!g){ g={k,items:[]}; porDia.push(g); } g.items.push(e); });
  const totalDia=k=>visibles.filter(e=>ymdLocal(new Date(e.inicio))===k).reduce((a,e)=>a+horasSegs(e),0);
  const [semIni]=rangoPeriodo("week");
  const miSemana=lista.filter(e=>(esTodos||e.persona===persona)&&new Date(e.inicio).getTime()>=semIni).reduce((a,e)=>a+horasSegs(e),0);
  const etiquetaDia=k=>{ const [y,m,d]=k.split("-").map(Number); const dt=new Date(y,m-1,d); if(k===hoyStr) return "Hoy"; const ay=new Date(); ay.setDate(ay.getDate()-1); if(k===ymdLocal(ay)) return "Ayer"; return dt.toLocaleDateString("es-ES",{weekday:"long",day:"numeric",month:"short"}); };

  // ── Informe por persona / proyecto ──
  const [desdeR,hastaR]=rangoPeriodo(range,dateFrom,dateTo);
  const matrix=horasMatriz(lista,desdeR,hastaR);
  const projTotals={}; let grandTotal=0;
  Object.values(matrix).forEach(mp=>Object.entries(mp).forEach(([p,s])=>{ projTotals[p]=(projTotals[p]||0)+s; grandTotal+=s; }));
  const memberNames=Object.keys(matrix);
  const projNames=Object.keys(projTotals).sort((a,b)=>projTotals[b]-projTotals[a]);
  const projColorMap=Object.fromEntries(projNames.map((p,i)=>[p,(projects||[]).find(x=>x.name===p)?.color||PROJ_COLORS[i%PROJ_COLORS.length]]));
  const memberTotals=Object.fromEntries(memberNames.map(m=>[m,Object.values(matrix[m]).reduce((s,v)=>s+v,0)]));
  const sortedMembers=[...memberNames].sort((a,b)=>(memberTotals[b]||0)-(memberTotals[a]||0));
  const maxMemberSecs=Math.max(...sortedMembers.map(m=>memberTotals[m]||0),1);
  const getMemberColor=n=>INIT_MEMBERS.find(x=>x.name===n)?.color||"#D5D9E0";
  const RANGE_LABELS={week:"Esta semana",month:"Este mes",year:"Este año",custom:"Personalizado"};
  const factMatrix=horasMatriz(lista.filter(e=>e.facturable),desdeR,hastaR);
  const factPersona=n=>Object.values(factMatrix[n]||{}).reduce((a,v)=>a+v,0);
  const totalFact=Object.keys(factMatrix).reduce((a,n)=>a+factPersona(n),0);

  const inp={border:"1px solid #2E343E",borderRadius:7,padding:"7px 10px",fontSize:11.5,fontFamily:"inherit",outline:"none",background:"#1F232B"};
  const lbl={fontSize:9,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:4};
  const pc=esTodos?"#E8501C":(persona&&getMemberColor(persona));

  return(
    <div>
      <div style={{marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontWeight:700,fontSize:15,color:"#ECEEF2",letterSpacing:"-0.4px"}}>⏱ Horas</div>
          <div style={{fontSize:11,color:"#7F8692",marginTop:2}}>Registro de horas del equipo, guardado en el dashboard (ya no hace falta Clockify)</div>
        </div>
        <button onClick={recargar} style={{background:"#262B34",color:"#C3C8D0",border:"1px solid #2E343E",borderRadius:8,padding:"6px 12px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>🔄 Actualizar</button>
      </div>

      {/* ── Registrar ── */}
      <div style={{background:"#1F232B",border:`1.5px solid ${enMarcha?pc+"88":"#2E343E"}`,borderRadius:14,padding:"14px 16px",marginBottom:18,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
          {MIEMBROS_VISIBLES.filter(mem=>perfil.rol==="admin"||mem.name===perfil.nombre).map(mem=>(
            <button key={mem.name} onClick={()=>setPersona(mem.name)} style={{
              background:persona===mem.name?mem.color:"#F9FAFB",color:persona===mem.name?"#FFF":"#C3C8D0",
              border:`1.5px solid ${persona===mem.name?mem.color:"#4A515D"}`,borderRadius:99,padding:"5px 12px",fontSize:11,
              fontWeight:persona===mem.name?700:500,cursor:"pointer",fontFamily:"inherit",
            }}>{mem.name}{lista.some(e=>e.enCurso&&e.persona===mem.name)?" ⏺":""}</button>
          ))}
          {perfil.rol==="admin"&&(
            <button onClick={()=>setPersona(TODOS)} title="Las horas que registres se cuentan a todo el equipo a la vez" style={{
              background:esTodos?"#E8501C":"#F9FAFB",color:esTodos?"#FFF":"#C3C8D0",
              border:`1.5px solid ${esTodos?"#E8501C":"#4A515D"}`,borderRadius:99,padding:"5px 12px",fontSize:11,
              fontWeight:esTodos?700:500,cursor:"pointer",fontFamily:"inherit",
            }}>👥 Todos{lista.some(e=>e.enCurso&&e.grupo)?" ⏺":""}</button>
          )}
          <span style={{marginLeft:"auto",fontSize:11,color:"#9AA1AC",alignSelf:"center"}}>{esTodos?"Esta semana el equipo (suma)":`Esta semana ${persona}`}: <b style={{color:pc}}>{fmtHoras(miSemana)}</b></span>
        </div>

        {esTodos&&<div style={{fontSize:11,color:"#E8501C",fontWeight:600,marginBottom:10}}>👥 Modo Todos: lo que registres aquí se cuenta a los {nombresEquipo.length} miembros del equipo a la vez.</div>}
        {enMarcha?(
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:200}}>
              <div style={{fontSize:13,fontWeight:700,color:"#ECEEF2"}}>{enMarcha.descripcion||"(sin descripción)"}</div>
              <div style={{fontSize:11,color:projColorMap[enMarcha.proyecto]||"#9AA1AC",fontWeight:600}}>{enMarcha.proyecto||"Sin proyecto"} · desde las {hhmm(enMarcha.inicio)}</div>
              <div style={{marginTop:8}}>
                <FactSwitch value={!!enMarcha.facturable} onChange={v=>{
                  if(esTodos&&enMarcha.grupo) guardarVarios(lista.filter(x=>x.enCurso&&x.grupo===enMarcha.grupo).map(x=>({...x,facturable:v})));
                  else guardar({...enMarcha,facturable:v});
                  setFacturable(v);
                }}/>
              </div>
            </div>
            <div style={{fontSize:26,fontWeight:800,color:pc,fontVariantNumeric:"tabular-nums",letterSpacing:"-0.5px"}}>{fmtReloj(horasSegs(enMarcha))}</div>
            <button onClick={()=>parar(enMarcha)} style={{background:"#DC2626",color:"#FFF",border:"none",borderRadius:10,padding:"10px 22px",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>■ Parar</button>
          </div>
        ):(
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
            <div style={{flex:"2 1 220px"}}>
              <div style={lbl}>¿En qué estás trabajando?</div>
              <input value={desc} onChange={e=>setDesc(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter") modo==="timer"?empezar():añadirManual(); }} placeholder="Descripción (opcional)" style={{...inp,width:"100%"}}/>
            </div>
            <div style={{flex:"1 1 170px"}}>
              <div style={{...lbl,display:"flex",justifyContent:"space-between"}}><span>Proyecto o actividad</span><span onClick={()=>setGestionAct(g=>!g)} style={{cursor:"pointer",color:"#3B82F6",textTransform:"none",letterSpacing:0}}>{gestionAct?"cerrar":"gestionar actividades"}</span></div>
              <select value={proyecto} onChange={e=>{ const v=e.target.value; if(v==="__nueva"){ const n=nuevaActividad(); if(n) setProyecto(n); } else setProyecto(v); }} style={{...inp,width:"100%"}}>
                <option value="">Sin proyecto</option>
                {opcionesProyecto(proyecto)}
              </select>
            </div>
            <div>
              <div style={lbl}>¿Facturable?</div>
              <FactSwitch value={facturable} onChange={setFacturable}/>
            </div>
            <div style={{display:"flex",border:"1px solid #2E343E",borderRadius:8,overflow:"hidden"}}>
              {[["timer","⏱ Temporizador"],["manual","✍️ A mano"]].map(([k,l])=>(
                <button key={k} onClick={()=>setModo(k)} style={{background:modo===k?"#323844":"#1F232B",color:modo===k?"#FFF":"#9AA1AC",border:"none",padding:"7px 11px",fontSize:11,fontWeight:modo===k?700:500,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
              ))}
            </div>
            {modo==="timer"?(
              <button onClick={()=>empezar()} style={{background:"#059669",color:"#FFF",border:"none",borderRadius:10,padding:"9px 22px",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>▶ Empezar</button>
            ):(<>
              {esTodos&&<button onClick={()=>{ setProyecto("Training Session"); setMIni("09:00"); setMFin("13:00"); setMDur(""); }} title="Rellena Training Session de 9:00 a 13:00" style={{background:"#232831",color:"#E8501C",border:"1.5px solid #E8501C",borderRadius:8,padding:"7px 11px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>🎯 TS 9–13</button>}
              <div><div style={lbl}>Fecha</div><input type="date" value={mFecha} onChange={e=>setMFecha(e.target.value)} style={inp}/></div>
              <div><div style={lbl}>Inicio</div><input type="time" value={mIni} onChange={e=>setMIni(e.target.value)} style={{...inp,width:92}}/></div>
              <div><div style={lbl}>Fin</div><input type="time" value={mFin} onChange={e=>setMFin(e.target.value)} style={{...inp,width:92}}/></div>
              <div><div style={lbl}>o duración</div><input value={mDur} onChange={e=>setMDur(e.target.value)} placeholder="1:30" style={{...inp,width:70}}/></div>
              <button onClick={añadirManual} style={{background:"#323844",color:"#FFF",border:"none",borderRadius:10,padding:"9px 18px",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>+ Añadir</button>
            </>)}
          </div>
        )}
      </div>

      {gestionAct&&(
        <div style={{background:"#232831",border:"1px solid #2E343E",borderRadius:12,padding:"10px 14px",marginTop:-10,marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:700,color:"#C3C8D0",marginBottom:8}}>🧩 Otras actividades en las que imputar horas</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            {actividades.map(a=>(
              <span key={a} style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:99,padding:"3px 6px 3px 10px",fontSize:11,color:"#C3C8D0",display:"inline-flex",alignItems:"center",gap:4}}>
                {a}<button onClick={()=>quitarActividad(a)} title="Quitar" style={{background:"none",border:"none",color:"#7F8692",cursor:"pointer",fontSize:11,padding:"0 2px"}}>✕</button>
              </span>
            ))}
            <button onClick={nuevaActividad} style={{background:"#323844",color:"#FFF",border:"none",borderRadius:99,padding:"4px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Añadir</button>
          </div>
        </div>
      )}

      {/* ── Registros ── */}
      <div style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:14,padding:"12px 16px",marginBottom:22}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,flexWrap:"wrap",gap:6}}>
          <div style={{fontWeight:700,fontSize:12.5,color:"#ECEEF2"}}>📋 {verTodos||esTodos?"Registros de todo el equipo":`Registros de ${persona}`}</div>
          <label style={{fontSize:11,color:"#9AA1AC",display:"flex",alignItems:"center",gap:5,cursor:"pointer"}}>
            <input type="checkbox" checked={verTodos} onChange={e=>setVerTodos(e.target.checked)}/> Ver los de todos
          </label>
        </div>
        {entries===null?<div style={{padding:20,textAlign:"center",color:"#7F8692",fontSize:12}}>Cargando horas…</div>
        :mostrados.length===0?<div style={{padding:20,textAlign:"center",color:"#7F8692",fontSize:12}}>Todavía no hay horas. Pulsa ▶ Empezar o añádelas a mano.</div>
        :porDia.map(g=>(
          <div key={g.k} style={{marginTop:10}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:10.5,fontWeight:700,color:"#9AA1AC",textTransform:"capitalize",borderBottom:"1px solid #2E343E",paddingBottom:4,marginBottom:2}}>
              <span>{etiquetaDia(g.k)}</span><span>Total: {fmtHoras(totalDia(g.k))}</span>
            </div>
            {g.items.map(e=>(
              <div key={e.id} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:"1px solid #2E343E",flexWrap:"wrap"}}>
                {verTodos&&<span style={{background:getMemberColor(e.persona)+"22",color:getMemberColor(e.persona),borderRadius:99,padding:"2px 8px",fontSize:10,fontWeight:700,flexShrink:0}}>{e.persona}</span>}
                <input defaultValue={e.descripcion||""} placeholder="(sin descripción)" onBlur={ev=>ev.target.value!==(e.descripcion||"")&&guardar({...e,descripcion:ev.target.value})}
                  style={{flex:"1 1 180px",border:"1px solid transparent",background:"transparent",fontSize:11.5,fontFamily:"inherit",padding:"3px 4px",borderRadius:5,color:"#ECEEF2",minWidth:120}}/>
                <select value={e.proyecto||""} onChange={ev=>{ let v=ev.target.value; if(v==="__nueva"){ v=nuevaActividad(); if(!v) return; } guardar({...e,proyecto:v}); }}
                  style={{border:"none",background:(projColorMap[e.proyecto]||"#969CA6")+"18",color:projColorMap[e.proyecto]||"#9AA1AC",borderRadius:99,padding:"3px 8px",fontSize:10.5,fontWeight:700,fontFamily:"inherit",maxWidth:170,cursor:"pointer"}}>
                  <option value="">Sin proyecto</option>
                  {opcionesProyecto(e.proyecto)}
                </select>
                <FactSwitch compact value={!!e.facturable} onChange={v=>guardar({...e,facturable:v})}/>
                <input type="date" value={ymdLocal(new Date(e.inicio))} onChange={ev=>cambiarFecha(e,ev.target.value)} style={{border:"none",background:"transparent",fontSize:10.5,color:"#7F8692",fontFamily:"inherit",width:108}}/>
                <span onClick={()=>cambiarHoras(e)} title="Cambiar horas" style={{fontSize:11,color:"#9AA1AC",cursor:"pointer",whiteSpace:"nowrap"}}>{hhmm(e.inicio)} – {e.enCurso?"ahora":hhmm(e.fin||e.inicio)}</span>
                <span onClick={()=>cambiarHoras(e)} style={{fontSize:12.5,fontWeight:800,color:e.enCurso?"#059669":"#ECEEF2",minWidth:62,textAlign:"right",fontVariantNumeric:"tabular-nums",cursor:"pointer"}}>{e.enCurso?fmtReloj(horasSegs(e)):fmtHoras(horasSegs(e))}</span>
                {e.origen==="clockify"&&<span title="Traído de Clockify" style={{fontSize:9,color:"#7F8692"}}>CK</span>}
                {!e.enCurso&&e.persona===persona&&<button onClick={()=>empezar(e.proyecto||"",e.descripcion||"",!!e.facturable)} title="Seguir con esto" style={{background:"none",border:"none",color:"#059669",cursor:"pointer",fontSize:13}}>▶</button>}
                {(esTodos||e.persona===persona)
                  ?<button onClick={()=>borrar(e)} title="Borrar" style={{background:"none",border:"none",color:"#5C6370",cursor:"pointer",fontSize:13}}>✕</button>
                  :<span title={`Solo se puede borrar desde el perfil de ${e.persona}`} style={{width:22,textAlign:"center",fontSize:10,color:"#4A515D"}}>🔒</span>}
              </div>
            ))}
          </div>
        ))}
        {visibles.length>nLista&&<button onClick={()=>setNLista(n=>n+60)} style={{marginTop:10,background:"none",border:"none",color:"#3B82F6",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>Ver más ({visibles.length-nLista})</button>}
      </div>

      {/* ── Informe ── */}
      <div style={{fontWeight:700,fontSize:13,color:"#ECEEF2",marginBottom:10}}>📊 Informe por persona y proyecto</div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end",marginBottom:16}}>
        <div>
          <div style={lbl}>Período</div>
          <div style={{display:"flex",border:"1px solid #2E343E",borderRadius:8,overflow:"hidden"}}>
            {["week","month","year","custom"].map(r=>(
              <button key={r} onClick={()=>setRange(r)} style={{background:range===r?"#323844":"#1F232B",color:range===r?"#FFF":"#9AA1AC",border:"none",padding:"7px 12px",fontSize:11,fontWeight:range===r?700:400,cursor:"pointer",fontFamily:"inherit"}}>{RANGE_LABELS[r]}</button>
            ))}
          </div>
        </div>
        {range==="custom"&&(<>
          <div><div style={lbl}>Desde</div><input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={inp}/></div>
          <div><div style={lbl}>Hasta</div><input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={inp}/></div>
        </>)}
        <div>
          <div style={lbl}>Vista</div>
          <div style={{display:"flex",border:"1px solid #2E343E",borderRadius:8,overflow:"hidden"}}>
            {[{id:"persona",label:"👤 Persona"},{id:"proyecto",label:"📁 Proyecto"}].map(v=>(
              <button key={v.id} onClick={()=>setViewMode(v.id)} style={{background:viewMode===v.id?"#323844":"#1F232B",color:viewMode===v.id?"#FFF":"#9AA1AC",border:"none",padding:"7px 14px",fontSize:11,fontWeight:viewMode===v.id?700:400,cursor:"pointer",fontFamily:"inherit"}}>{v.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8,marginBottom:16}}>
        {[
          {label:"Total horas",val:fmtHoras(grandTotal),color:"#3B82F6"},
          {label:"Facturables",val:fmtHoras(totalFact),color:"#059669"},
          {label:"No facturables",val:fmtHoras(Math.max(0,grandTotal-totalFact)),color:"#7F8692"},
          {label:"Personas",val:sortedMembers.length,color:"#8B5CF6"},
          {label:"Proyectos",val:projNames.length,color:"#10B981"},
          {label:"Media/persona",val:sortedMembers.length>0?fmtHoras(grandTotal/sortedMembers.length):"—",color:"#F59E0B"},
        ].map(k=>(
          <div key={k.label} style={{background:"#1F232B",borderRadius:10,padding:"12px 14px",border:"1px solid #2E343E"}}>
            <div style={lbl}>{k.label}</div>
            <div style={{fontSize:18,fontWeight:700,color:k.color,letterSpacing:"-0.3px"}}>{k.val}</div>
          </div>
        ))}
      </div>

      {grandTotal===0&&<div style={{textAlign:"center",padding:30,color:"#7F8692",fontSize:12}}>No hay horas en este período</div>}

      {viewMode==="persona"&&grandTotal>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:12}}>
          {sortedMembers.map(mname=>{
            const mSecs=memberTotals[mname]||0, mColor=getMemberColor(mname);
            const mProjs=Object.entries(matrix[mname]||{}).sort((a,b)=>b[1]-a[1]);
            return(
              <div key={mname} style={{background:"#232831",borderRadius:14,border:"1px solid #2E343E",overflow:"hidden"}}>
                <div style={{height:4,background:mColor}}/>
                <div style={{padding:"14px 16px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:36,height:36,borderRadius:99,background:mColor,color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700}}>{mname[0]}</div>
                      <div>
                        <div style={{fontWeight:700,fontSize:13,color:"#D5D9E0"}}>{mname}</div>
                        <div style={{fontSize:9,color:"#9AA1AC"}}>{mProjs.length} proyecto{mProjs.length!==1?"s":""} · <span style={{color:"#047857",fontWeight:700}}>{fmtHoras(factPersona(mname))} facturables</span></div>
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:20,fontWeight:700,color:mColor,letterSpacing:"-0.5px"}}>{fmtHoras(mSecs)}</div>
                      <div style={{fontSize:9,color:"#9AA1AC"}}>{grandTotal>0?Math.round(mSecs/grandTotal*100):0}% del total</div>
                    </div>
                  </div>
                  <div style={{height:6,background:"#1E2B38",borderRadius:99,overflow:"hidden",marginBottom:14}}>
                    <div style={{height:6,background:mColor,width:`${Math.round(mSecs/maxMemberSecs*100)}%`,borderRadius:99}}/>
                  </div>
                  {mProjs.map(([pname,psecs])=>{
                    const c=projColorMap[pname]||"#636366", ppct=Math.round(psecs/mSecs*100);
                    return(
                      <div key={pname} style={{marginBottom:8}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:8,height:8,borderRadius:99,background:c}}/><span style={{fontSize:11,color:"#C3C8D0",fontWeight:500}}>{pname}</span></div>
                          <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:9,color:"#9AA1AC"}}>{ppct}%</span><span style={{fontSize:11,fontWeight:700,color:"#ECEEF2"}}>{fmtHoras(psecs)}</span></div>
                        </div>
                        <div style={{height:4,background:"#1E2B38",borderRadius:99,overflow:"hidden"}}><div style={{height:4,background:c,borderRadius:99,width:`${ppct}%`,opacity:0.8}}/></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewMode==="proyecto"&&grandTotal>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:12}}>
          {projNames.map(pname=>{
            const pSecs=projTotals[pname]||0, pColor=projColorMap[pname]||"#636366";
            const pMembers=Object.entries(matrix).filter(([,m])=>m[pname]).map(([mn,m])=>[mn,m[pname]]).sort((a,b)=>b[1]-a[1]);
            const maxMSecs=Math.max(...pMembers.map(([,s])=>s),1);
            const maxAllProj=Math.max(...projNames.map(p=>projTotals[p]||0),1);
            return(
              <div key={pname} style={{background:"#232831",borderRadius:14,border:"1px solid #2E343E",overflow:"hidden"}}>
                <div style={{height:4,background:pColor}}/>
                <div style={{padding:"14px 16px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div>
                      <div style={{fontWeight:700,fontSize:13,color:"#D5D9E0"}}>📁 {pname}</div>
                      <div style={{fontSize:9,color:"#9AA1AC"}}>{pMembers.length} persona{pMembers.length!==1?"s":""}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:20,fontWeight:700,color:pColor,letterSpacing:"-0.5px"}}>{fmtHoras(pSecs)}</div>
                      <div style={{fontSize:9,color:"#9AA1AC"}}>{grandTotal>0?Math.round(pSecs/grandTotal*100):0}% del total</div>
                    </div>
                  </div>
                  <div style={{height:6,background:"#1E2B38",borderRadius:99,overflow:"hidden",marginBottom:14}}>
                    <div style={{height:6,background:pColor,width:`${Math.round(pSecs/maxAllProj*100)}%`,borderRadius:99}}/>
                  </div>
                  {pMembers.map(([mname,msecs])=>{
                    const mc=getMemberColor(mname), mpct=Math.round(msecs/pSecs*100);
                    return(
                      <div key={mname} style={{marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                        <div style={{width:26,height:26,borderRadius:99,background:mc,color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0}}>{mname[0]}</div>
                        <div style={{flex:1}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                            <span style={{fontSize:11,color:"#C3C8D0",fontWeight:500}}>{mname}</span>
                            <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:9,color:"#9AA1AC"}}>{mpct}%</span><span style={{fontSize:11,fontWeight:700,color:"#ECEEF2"}}>{fmtHoras(msecs)}</span></div>
                          </div>
                          <div style={{height:4,background:"#1E2B38",borderRadius:99,overflow:"hidden"}}><div style={{height:4,background:mc,borderRadius:99,width:`${Math.round(msecs/maxMSecs*100)}%`,opacity:0.85}}/></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Traer horas antiguas de Clockify ── */}
      <div style={{marginTop:24,borderTop:"1px solid #2E343E",paddingTop:12}}>
        <button onClick={()=>setImp(s=>({...s,abierto:!s.abierto}))} style={{background:"none",border:"none",color:"#9AA1AC",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",padding:0}}>
          {imp.abierto?"▼":"▸"} 📥 Traer las horas antiguas de Clockify
        </button>
        {imp.abierto&&(
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end",marginTop:10}}>
            <div><div style={lbl}>Desde</div><input type="date" value={imp.desde} onChange={e=>setImp(s=>({...s,desde:e.target.value}))} style={inp}/></div>
            <div><div style={lbl}>Hasta</div><input type="date" value={imp.hasta} onChange={e=>setImp(s=>({...s,hasta:e.target.value}))} style={inp}/></div>
            <button onClick={importarClockify} disabled={imp.estado==="cargando"} style={{background:"#262B34",color:"#D5D9E0",border:"1px solid #3A414D",borderRadius:8,padding:"8px 16px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",opacity:imp.estado==="cargando"?0.6:1}}>
              {imp.estado==="cargando"?"⏳ Trayendo…":"📥 Traer de Clockify"}
            </button>
            {imp.msg&&<div style={{width:"100%",fontSize:11,color:imp.estado==="error"?"#EC8383":"#047857"}}>{imp.msg}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// Selector para añadir un proyecto a Previsiones (con buscador y lista que se desliza)
function AñadirProyectoModal({disponibles, onElegir, onCerrar}){
  const [busca,setBusca]=useState("");
  const norm=x=>String(x||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");
  const lista=disponibles.filter(p=>norm(p.name).includes(norm(busca)));
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
      onClick={e=>{if(e.target===e.currentTarget)onCerrar();}}>
      <div style={{background:"#1F232B",borderRadius:14,padding:"22px 24px",width:380,maxWidth:"100%",maxHeight:"85vh",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}}>
        <div style={{fontWeight:800,fontSize:15,color:"#ECEEF2",marginBottom:4}}>+ Añadir proyecto a Previsiones</div>
        <div style={{fontSize:11,color:"#9AA1AC",marginBottom:10}}>Elige un proyecto del dashboard para añadirlo.</div>
        {disponibles.length>0&&(
          <input autoFocus value={busca} onChange={e=>setBusca(e.target.value)} placeholder="🔍 Buscar proyecto…"
            style={{border:"1px solid #2E343E",borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:"inherit",outline:"none",marginBottom:10}}/>
        )}
        {disponibles.length===0
          ? <div style={{fontSize:11,color:"#7F8692",textAlign:"center",padding:"20px 0"}}>Todos los proyectos ya están en previsiones</div>
          : <div style={{display:"flex",flexDirection:"column",gap:6,overflowY:"auto",flex:1,minHeight:0,paddingRight:4,WebkitOverflowScrolling:"touch",overscrollBehavior:"contain"}}>
              {lista.map(p=>(
                <button key={p.name} onClick={()=>onElegir(p.name)}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:9,border:"1px solid #2E343E",background:"#232831",cursor:"pointer",textAlign:"left",fontFamily:"inherit",width:"100%",flexShrink:0}}>
                  <div style={{width:12,height:12,borderRadius:99,background:p.color,flexShrink:0}}/>
                  <span style={{fontWeight:600,fontSize:12,color:"#ECEEF2"}}>{p.name}</span>
                </button>
              ))}
              {lista.length===0&&<div style={{fontSize:11,color:"#7F8692",textAlign:"center",padding:"12px 0"}}>Ningún proyecto con ese nombre</div>}
            </div>
        }
        <button onClick={onCerrar}
          style={{marginTop:12,width:"100%",padding:"8px",borderRadius:8,border:"1px solid #2E343E",background:"#1F232B",fontSize:11,cursor:"pointer",fontFamily:"inherit",color:"#9AA1AC",flexShrink:0}}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

// ── PRESUPUESTOS 2026 ─────────────────────────────────────────────────────────
const MESES_PREV = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

// Datos iniciales del Excel — claves = nombre exacto en el dashboard
const EXCEL_INICIAL = {};   // previsiones iniciales por proyecto: { "Proyecto": { ing:[12 meses], gas:[12 meses] } }
// Proyectos del dashboard con datos del Excel — se cargan por defecto
const EXCEL_DEFAULTS = [];

// Periodos de previsión. idx = meses desde Ene 2026 (clave "mes" en presupuestos_2026),
// así los meses que coinciden (Ago–Dic 2026) son el mismo dato en los dos periodos.
const PERIODOS_PREV = {
  "2026":  {id:"2026",  titulo:"2026",  rango:"Enero a Diciembre 2026", prefijo:"",
            meses:MESES_PREV.map((m,i)=>({idx:i,label:m,mes:i+1,year:2026}))},
  "corea": {id:"corea", titulo:"Corea", rango:"Agosto 2026 a Febrero 2027", prefijo:"COREA|",
            meses:[7,8,9,10,11,12,13].map(i=>({idx:i,label:`${MESES_PREV[i%12]} ${String(2026+Math.floor(i/12)).slice(2)}`,mes:i%12+1,year:2026+Math.floor(i/12)}))},
};

// Dinero real en la cuenta: saldo del último movimiento importado en 🏦 Banco
function saldoBanco(banco){
  if(!banco||!banco.length) return null;
  const conSaldo=[...banco].filter(m=>m.saldo!==null&&m.saldo!==undefined&&!isNaN(m.saldo)).sort((a,b)=>bancoTs(a.fecha)-bancoTs(b.fecha));
  const ult=conSaldo[conSaldo.length-1];
  if(!ult) return null;
  // Movimientos posteriores sin saldo (si los hay) se suman
  const despues=banco.filter(m=>bancoTs(m.fecha)>bancoTs(ult.fecha)&&(m.saldo===null||m.saldo===undefined)).reduce((s,m)=>s+m.importe,0);
  const fecha=[...banco].sort((a,b)=>bancoTs(b.fecha)-bancoTs(a.fecha))[0].fecha;
  return {saldo:ult.saldo+despues, fecha, dias:Math.floor((Date.now()-bancoTs(fecha))/864e5)};
}
const eurObj=v=>`${Math.round(v||0).toLocaleString("es-ES")}€`;

function BancoSoloCard({banco}){
  const sb_=saldoBanco(banco);
  if(banco===null||banco===undefined) return <div style={{background:"#232831",border:"1px solid #2E343E",borderRadius:12,padding:"12px 16px",marginBottom:14,fontSize:11,color:"#7F8692"}}>🏦 Cargando saldo del banco…</div>;
  if(!sb_) return <div style={{background:"#232831",border:"1px dashed #3A414D",borderRadius:12,padding:"12px 16px",marginBottom:14,fontSize:11,color:"#9AA1AC"}}>🏦 <b>Dinero en el banco:</b> todavía no hay saldo. Sube un extracto en <b>🏦 Banco</b> (con la columna de saldo).</div>;
  return(
    <div style={{display:"inline-block",background:"#112845",borderRadius:12,padding:"12px 18px",marginBottom:14,border:"1.5px solid #1E3A5F55",minWidth:240}}>
      <div style={{fontSize:9,color:"#D5D9E0",fontWeight:700,letterSpacing:"0",marginBottom:3}}>🏦 Dinero en el banco</div>
      <div style={{fontSize:24,fontWeight:800,color:sb_.saldo>=0?"#D5D9E0":"#EC8383",letterSpacing:"-1px"}}>{sb_.saldo.toLocaleString("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2})}€</div>
      <div style={{fontSize:9.5,color:"#9AA1AC",marginTop:2}}>A {sb_.fecha}{sb_.dias>7?` · ⚠️ extracto de hace ${sb_.dias} días`:" · último extracto"}</div>
    </div>
  );
}

// ── OBJETIVOS NY + COREA ──────────────────────────────────────────────────────
// Lo que falta por pagar de NY y el presupuesto de Corea (objetivos de ahorro: se cambian con doble clic).
// Se guardan en presupuestos_2026 como filas "OBJETIVO|NY" / "OBJETIVO|COREA" (mes 0, ing_est = importe).
const OBJ_DEFAULT = { NY:0, COREA:0 }; // objetivos de ahorro (se cambian con doble clic en Previsiones)
const COREA_OLD_10P = -1;
const COREA_EXCEL = { minimo:0, detalle:"" };
const COREA_FIN_IDX = 13; // feb 2027 (meses desde ene 2026)
const COREA_INI_IDX = 7;  // ago 2026

function ObjetivosCard({presup:presupP, activeProy:activeP, banco:bancoP, ing, gas, hojas}){
  const [bancoL,setBancoL]=useState(null);
  const [presupL,setPresupL]=useState(null);
  const [activeL,setActiveL]=useState(null);
  const [obj,setObj]=useState(OBJ_DEFAULT);
  const [checkIdx,setCheckIdx]=useState(null); // mes del checkpoint (meses desde ene 2026); se guarda como "OBJETIVO|CHECK"
  const [edit,setEdit]=useState(null);
  const [val,setVal]=useState("");
  const [verMeses,setVerMeses]=useState(false);

  useEffect(()=>{
    sb.from("presupuestos_2026").select("*").like("proyecto","OBJETIVO|%").then(({data})=>{
      if(data&&data.length){
        const o={...OBJ_DEFAULT};
        data.forEach(r=>{
          const k=String(r.proyecto).slice(9);
          if(k==="CHECK") setCheckIdx(parseInt(r.ing_est));
          else if(k==="COREA"&&Math.abs((parseFloat(r.ing_est)||0)-COREA_OLD_10P)<0.01) o[k]=OBJ_DEFAULT.COREA;
          else if(k in o) o[k]=parseFloat(r.ing_est)||0;
        });
        setObj(o);
      }
    });
    if(bancoP===undefined) bancoLoad().then(setBancoL).catch(()=>setBancoL([]));
    if(presupP===undefined){
      (async()=>{
        try{
          const {data:dp}=await sb.from("presupuestos_2026").select("*");
          const mapa={};
          (dp||[]).forEach(r=>{ if(!mapa[r.proyecto]) mapa[r.proyecto]={}; mapa[r.proyecto][String(r.mes)]={ing_est:r.ing_est,gas_est:r.gas_est}; });
          Object.entries(EXCEL_INICIAL).forEach(([pn,v])=>{ if(!mapa[pn]) mapa[pn]={}; MESES_PREV.forEach((_,mi)=>{ if(!mapa[pn][String(mi)]) mapa[pn][String(mi)]={ing_est:v.ing[mi]||0,gas_est:v.gas[mi]||0}; }); });
          setPresupL(mapa);
          const {data:da}=await sb.from("presupuestos_activos").select("proyecto");
          const todos=(da||[]).map(r=>r.proyecto);
          const corea=todos.filter(p=>p.startsWith("COREA|")).map(p=>p.slice(6));
          setActiveL(corea.length?corea:(todos.filter(p=>!p.includes("|")).length?todos.filter(p=>!p.includes("|")):EXCEL_DEFAULTS));
        }catch(e){ setPresupL({}); setActiveL([]); }
      })();
    }
  },[]);

  async function guardarFila(k,num){
    const {error}=await sb.from("presupuestos_2026").upsert({proyecto:"OBJETIVO|"+k,mes:0,ing_est:num,gas_est:0},{onConflict:"proyecto,mes"});
    if(error){ console.error("objetivo",error); alert("Error guardando: "+error.message); }
  }
  function guardar(k){
    const num=parseFloat(String(val).replace(/\./g,"").replace(",","."))||0;
    setObj(o=>({...o,[k]:num})); setEdit(null);
    guardarFila(k,num);
  }
  function elegirCheck(i){ setCheckIdx(i); guardarFila("CHECK",i); }

  const banco=bancoP===undefined?bancoL:bancoP;
  const presup=presupP===undefined?presupL:presupP;
  const activeProy=activeP===undefined?activeL:activeP;
  const sbI=saldoBanco(banco);
  const saldo=sbI?sbI.saldo:0;

  const hoy=new Date();
  const idxHoy=(hoy.getFullYear()-2026)*12+hoy.getMonth();
  const restantes=[];
  for(let i=Math.max(idxHoy,COREA_INI_IDX);i<=COREA_FIN_IDX;i++) restantes.push(i);
  const etiqueta=i=>`${MESES_PREV[i%12]} ${String(2026+Math.floor(i/12)).slice(2)}`;
  const etiquetaLarga=i=>`${["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"][i%12]} ${2026+Math.floor(i/12)}`;
  const margenEst=i=>(activeProy||[]).reduce((s,pn)=>s+((presup?.[pn]?.[String(i)]?.ing_est||0)-(presup?.[pn]?.[String(i)]?.gas_est||0)),0);

  const presupuesto=obj.NY+obj.COREA;
  const falta=Math.max(0,presupuesto-saldo);
  const n=restantes.length;
  // Lo que debería haber en el banco a fin de cada mes para llegar al objetivo en feb 27 (ritmo constante desde hoy)
  const deberia=k=>saldo+falta*(k+1)/n;
  // Lo que habría con lo previsto: banco + margen estimado acumulado hasta ese mes
  const previsto=k=>saldo+restantes.slice(0,k+1).reduce((s,i)=>s+margenEst(i),0);
  const margenPrev=restantes.reduce((s,i)=>s+margenEst(i),0);
  const prevision=saldo+margenPrev;
  const diferencia=prevision-presupuesto;
  const pct=presupuesto?Math.min(100,Math.max(0,saldo/presupuesto*100)):0;
  const pctNY=presupuesto?obj.NY/presupuesto*100:0;
  const cargando=banco===null||presup===null||activeProy===null;

  // Checkpoint: el mes elegido (por defecto, el que viene)
  const cIdx=restantes.includes(checkIdx)?checkIdx:(restantes[1]??restantes[0]);
  const cK=restantes.indexOf(cIdx);
  const debCheck=cK>=0?deberia(cK):presupuesto;
  const prevCheck=cK>=0?previsto(cK):prevision;
  const faltaCheck=Math.max(0,debCheck-saldo);
  const difCheck=prevCheck-debCheck;

  // Individual: TODO lo que falta para pagar NY + Corea repartido a partes iguales (N × lo de cada uno = lo que falta).
  // Cada uno debería llegar a la MISMA cifra de beneficio neto (como en Equipo): media actual + lo que falta / N
  const otrosB=otrosDeBanco(banco||[]);
  const personas=MIEMBROS_VISIBLES.map(m=>({...m,neto:statsMiembro(m.name,{ing,gas,hojas,otros:otrosB}).neto}));
  const N=personas.length||1;
  const mediaNeto=personas.reduce((s,p)=>s+p.neto,0)/N;
  const masCadaUno=falta/N;
  const objetivoIndiv=mediaNeto+masCadaUno;

  const valEditable=(k,color)=>edit===k?(
    <input autoFocus value={val} onChange={e=>setVal(e.target.value)} onBlur={()=>guardar(k)}
      onKeyDown={e=>{ if(e.key==="Enter") guardar(k); if(e.key==="Escape") setEdit(null); }}
      style={{width:110,fontSize:18,fontWeight:800,border:"1px solid #F59E0B",borderRadius:6,padding:"1px 6px",fontFamily:"inherit",background:"#453B11",color}}/>
  ):(
    <span onDoubleClick={()=>{ setEdit(k); setVal(String(obj[k])); }} title="Doble clic para cambiar" style={{cursor:"pointer"}}>{eurObj(obj[k])}</span>
  );
  const card=(label,valor,color,bg,sub,big)=>(
    <div style={{background:bg,borderRadius:10,padding:big?"12px 16px":"11px 14px",border:`1.5px solid ${color}${big?"55":"22"}`}}>
      <div style={{fontSize:9,color,fontWeight:700,letterSpacing:"0",marginBottom:3}}>{label}</div>
      <div style={{fontSize:big?24:20,fontWeight:800,color,letterSpacing:"-1px"}}>{valor}</div>
      {sub&&<div style={{fontSize:9.5,color:"#9AA1AC",marginTop:2,lineHeight:1.35}}>{sub}</div>}
    </div>
  );

  return(
    <div style={{background:"#1F232B",border:"1px solid #2E343E",borderRadius:14,padding:"14px 16px",marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",flexWrap:"wrap",gap:6,marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:13,color:"#ECEEF2"}}>🎯 Objetivo: pagar NY y Corea</div>
        <div style={{fontSize:10,color:"#7F8692"}}>Doble clic en NY o Corea para cambiar el importe · plazo: {etiqueta(COREA_FIN_IDX)}</div>
      </div>

      {/* Lo que falta para el objetivo: entre todos y por persona */}
      <div style={{background:"linear-gradient(135deg,#3A414D,#323844)",borderRadius:12,padding:"14px 18px",marginBottom:10,color:"#FFF",display:"flex",flexWrap:"wrap",gap:"12px 28px",alignItems:"center"}}>
        <div style={{flex:"1 1 240px"}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0",color:"#93C5FD"}}>🏁 Para pagar NY + Corea nos faltan entre todos</div>
          <div style={{fontSize:32,fontWeight:900,letterSpacing:"-1.5px",marginTop:2}}>{cargando&&!sbI?"…":falta<=0?"✅ 0€":eurObj(falta)}</div>
          <div style={{fontSize:10.5,color:"#5C6370"}}>{eurObj(presupuesto)} de presupuesto − {sbI?eurObj(saldo):"—"} que hay en el banco · plazo {etiquetaLarga(COREA_FIN_IDX)}</div>
        </div>
        {ing&&(
          <div style={{borderLeft:"1px solid rgba(255,255,255,0.18)",paddingLeft:22,flex:"1 1 240px"}}>
            <div style={{fontSize:9,color:"#93C5FD",fontWeight:700,letterSpacing:"0"}}>👤 En el checkpoint cada uno debería tener</div>
            <div style={{fontSize:28,fontWeight:900,letterSpacing:"-1px"}}>{eurObj(objetivoIndiv)}</div>
            <div style={{fontSize:9.5,color:"#5C6370",lineHeight:1.45}}>
              de beneficio neto (como en Equipo) · media ahora {eurObj(mediaNeto)}<br/>
              <b style={{color:"#FDE68A"}}>+{eurObj(masCadaUno)} cada uno</b> · {N} × {eurObj(masCadaUno)} = {eurObj(masCadaUno*N)}
            </div>
          </div>
        )}
        <div>
          <div style={{fontSize:9,color:"#93C5FD",fontWeight:700,letterSpacing:"0"}}>Con lo previsto</div>
          <div style={{fontSize:18,fontWeight:800}}>{cargando?"…":eurObj(prevision)}</div>
          <div style={{fontSize:9.5,color:diferencia>=0?"#86EFAC":"#FCA5A5",fontWeight:700}}>{cargando?"":diferencia>=0?`✅ sobran ${eurObj(diferencia)}`:`⚠️ faltarían ${eurObj(-diferencia)}`}</div>
        </div>
      </div>

      {ing&&(
        <div style={{marginBottom:10}}>
          <div style={{fontSize:10.5,fontWeight:700,color:"#C3C8D0",marginBottom:6}}>
            👤 Para llegar al objetivo cada uno debería tener {eurObj(objetivoIndiv)} de beneficio neto <span style={{fontWeight:400,color:"#7F8692"}}>(el mismo que sale en Equipo)</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:6}}>
            {[...personas].sort((a,b)=>b.neto-a.neto).map(p=>{
              const le=objetivoIndiv-p.neto, ok=le<=0.5;
              const pc=objetivoIndiv>0?Math.min(100,Math.max(0,p.neto/objetivoIndiv*100)):100;
              return(
                <div key={p.name} style={{border:`1px solid ${ok?"#1F7A3F":"#2E343E"}`,background:ok?"#114521":"#1F232B",borderRadius:9,padding:"7px 10px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:4}}>
                    <span style={{fontWeight:700,fontSize:11,color:p.color}}>{p.name}</span>
                    <span style={{fontSize:11,fontWeight:800,color:"#ECEEF2"}}>{eurObj(p.neto)}</span>
                  </div>
                  <div style={{height:5,background:"#262B34",borderRadius:99,overflow:"hidden",margin:"4px 0 3px"}}>
                    <div style={{height:"100%",width:`${pc}%`,background:ok?"#059669":p.color,borderRadius:99}}/>
                  </div>
                  <div style={{fontSize:9.5,fontWeight:700,color:ok?"#059669":"#B45309"}}>{ok?"✅ ya llega":`le faltan ${eurObj(le)}`}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:8,marginBottom:10}}>
        {card("🏦 Dinero en el banco",cargando&&!sbI?"…":sbI?eurObj(saldo):"—",saldo>=0?"#D5D9E0":"#B91C1C","#112845",
          sbI?`A ${sbI.fecha}${sbI.dias>7?` · ⚠️ extracto de hace ${sbI.dias} días`:" · último extracto"}`:"Sube un extracto en 🏦 Banco",true)}
        {card("🗽 NY · falta por pagar",valEditable("NY","#7C3AED"),"#7C3AED","#1A1145","Se paga primero")}
        {card("🇰🇷 Corea · presupuesto",valEditable("COREA","#B91C1C"),"#B91C1C","#451111",`9 personas · 63 días · mínimo imprescindible ${eurObj(COREA_EXCEL.minimo)} (casa + seguro)`)}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:8,marginBottom:10}}>
        {card("💼 Presupuesto (NY + Corea)",eurObj(presupuesto),"#ECEEF2","#232831",`${eurObj(obj.NY)} NY + ${eurObj(obj.COREA)} Corea`)}
        {card("🔮 Previsión",cargando?"…":eurObj(prevision),"#D5D9E0","#112845",`Banco + margen estimado de ${restantes.length?`${etiqueta(restantes[0])} a ${etiqueta(restantes[restantes.length-1])}`:"—"} (${margenPrev>=0?"+":""}${eurObj(margenPrev)})`)}
        {card("⚖️ Diferencia previsión − presupuesto",cargando?"…":`${diferencia>=0?"+":""}${eurObj(diferencia)}`,diferencia>=0?"#059669":"#B91C1C",diferencia>=0?"#11452D":"#451111",
          cargando?"":diferencia>=0?"Con lo previsto llega para pagar todo":`Con lo previsto faltan ${eurObj(-diferencia)}`,true)}
      </div>

      {/* Barra de progreso: banco sobre presupuesto, con la marca de NY */}
      <div style={{position:"relative",height:12,background:"#262B34",borderRadius:99,overflow:"hidden",marginBottom:4}}>
        <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct}%`,background:"linear-gradient(90deg,#323844,#3B82F6)",borderRadius:99}}/>
        <div title="NY cubierto" style={{position:"absolute",left:`${pctNY}%`,top:0,bottom:0,width:2,background:"#7C3AED"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9.5,color:"#9AA1AC",marginBottom:6}}>
        <span>{pct.toFixed(0)}% del presupuesto en el banco</span>
        <span style={{color:"#7C3AED"}}>▲ NY ({eurObj(obj.NY)}) {saldo>=obj.NY?"✅ cubierto":`faltan ${eurObj(obj.NY-saldo)}`}</span>
        <span>{eurObj(presupuesto)}</span>
      </div>

      {restantes.length>0&&falta>0&&(
        <div>
          <button onClick={()=>setVerMeses(v=>!v)} style={{background:"none",border:"none",color:"#4F46E5",fontSize:10.5,fontWeight:600,cursor:"pointer",padding:0,fontFamily:"inherit"}}>
            {verMeses?"▼":"▸"} Lo que deberíamos tener en el banco a fin de cada mes
          </button>
          {verMeses&&(
            <div style={{overflowX:"auto",marginTop:6}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:10.5}}>
                <thead><tr style={{background:"#232831",color:"#9AA1AC"}}>
                  <th style={{padding:"4px 8px",textAlign:"left",fontWeight:700}}>Mes</th>
                  <th style={{padding:"4px 8px",textAlign:"right",fontWeight:700}}>Deberíamos tener</th>
                  <th style={{padding:"4px 8px",textAlign:"right",fontWeight:700}}>Con lo previsto</th>
                  <th style={{padding:"4px 8px",textAlign:"right",fontWeight:700}}>Diferencia</th>
                  <th style={{padding:"4px 8px",textAlign:"left",fontWeight:700}}></th>
                </tr></thead>
                <tbody>
                  {restantes.map((i,k)=>{
                    const d=deberia(k), p=previsto(k), dif=p-d;
                    const nyAqui=d>=obj.NY&&(k===0?saldo<obj.NY:deberia(k-1)<obj.NY);
                    return(
                      <tr key={i} style={{borderTop:"1px solid #2E343E"}}>
                        <td style={{padding:"4px 8px",fontWeight:600,color:"#ECEEF2"}}>{etiqueta(i)}{i===idxHoy&&<span style={{color:"#7F8692",fontWeight:400}}> (este mes)</span>}</td>
                        <td style={{padding:"4px 8px",textAlign:"right",fontWeight:800,color:"#D5D9E0"}}>{eurObj(d)}</td>
                        <td style={{padding:"4px 8px",textAlign:"right",fontWeight:600,color:"#C3C8D0"}}>{eurObj(p)}</td>
                        <td style={{padding:"4px 8px",textAlign:"right",fontWeight:700,color:dif>=0?"#059669":"#EC8383"}}>{dif>=0?"+":""}{eurObj(dif)}</td>
                        <td style={{padding:"4px 8px",color:"#7C3AED",fontSize:10,fontWeight:600}}>{nyAqui?"🗽 NY cubierto":""}{k===n-1?"🇰🇷 Corea cubierta":""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PrevisionesTab(props){
  const [pid,setPid]=useState(()=>{ try{ return localStorage.getItem("blesk_prev_periodo")||"2026"; }catch{ return "2026"; } });
  function sel(id){ setPid(id); try{ localStorage.setItem("blesk_prev_periodo",id); }catch{} }
  return(
    <div>
      <div style={{display:"inline-flex",background:"#262B34",borderRadius:10,padding:3,marginBottom:14,gap:2}}>
        {Object.values(PERIODOS_PREV).map(p=>(
          <button key={p.id} onClick={()=>sel(p.id)} style={{
            background:pid===p.id?"#1F232B":"transparent",color:pid===p.id?"#ECEEF2":"#9AA1AC",
            border:"none",borderRadius:8,padding:"6px 14px",fontSize:11,fontWeight:pid===p.id?700:500,
            cursor:"pointer",fontFamily:"inherit",boxShadow:pid===p.id?"0 1px 3px rgba(0,0,0,0.1)":"none"}}>
            {p.id==="corea"?"🇰🇷 Previsión Corea":"📅 Previsión 2026"}
            <span style={{fontSize:9,color:"#7F8692",marginLeft:6}}>{p.meses[0].label}–{p.meses[p.meses.length-1].label}</span>
          </button>
        ))}
      </div>
      <PresupuestosTab key={pid} {...props} periodo={PERIODOS_PREV[pid]}/>
    </div>
  );
}

function PresupuestosTab({ ing, gas, hojas, projects, sb, periodo, otros, banco }) {
  const MESES = periodo.meses.map(m=>m.label);
  const K = mi => String(periodo.meses[mi].idx);
  const esMesActual = mi => { const d=new Date(), m=periodo.meses[mi]; return d.getFullYear()===m.year&&d.getMonth()+1===m.mes; };
  // Previsión del total: meses ya pasados con lo REAL, este mes y los siguientes con lo ESTIMADO
  const esMesPasado = mi => { const d=new Date(), m=periodo.meses[mi]; return m.year*12+(m.mes-1)<d.getFullYear()*12+d.getMonth(); };
  const prevSum = (est,real) => est.reduce((s,e,mi)=>s+(esMesPasado(mi)?(real[mi]||0):(e||0)),0);
  const [presup,   setPresup]   = useState(null);   // { pn: { "0": {ing_est,gas_est}, ... } }
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [editCell, setEditCell] = useState(null);
  const [editVal,  setEditVal]  = useState("");
  const [proySel,  setProySel]  = useState(null);
  const [addModal, setAddModal] = useState(false);

  // Proyectos activos en previsiones (subset de projects del dashboard)
  const [activeProy, setActiveProy] = useState(null); // null = cargando

  useEffect(()=>{
    async function load(){
      try {
        // 1. Cargar presupuestos guardados
        const {data:dp} = await sb.from("presupuestos_2026").select("*");
        const mapa = {};
        (dp||[]).forEach(r=>{
          if(!mapa[r.proyecto]) mapa[r.proyecto]={};
          mapa[r.proyecto][String(r.mes)] = {ing_est:r.ing_est, gas_est:r.gas_est};
        });
        // Rellenar con Excel donde no haya datos
        Object.entries(EXCEL_INICIAL).forEach(([pn,v])=>{
          if(!mapa[pn]) mapa[pn]={};
          MESES_PREV.forEach((_,mi)=>{
            if(!mapa[pn][String(mi)]) mapa[pn][String(mi)]={ing_est:v.ing[mi]||0, gas_est:v.gas[mi]||0};
          });
        });
        setPresup(mapa);

        // 2. Cargar proyectos activos en previsiones
        const {data:da} = await sb.from("presupuestos_activos").select("proyecto");
        const mios=(da||[]).map(r=>r.proyecto).filter(p=>periodo.prefijo?p.startsWith(periodo.prefijo):!p.includes("|")).map(p=>p.slice(periodo.prefijo.length));
        if(mios.length){
          setActiveProy(mios);
        } else {
          // Primera vez: 2026 activa los del Excel; Corea copia los de 2026
          const de2026=(da||[]).map(r=>r.proyecto).filter(p=>!p.includes("|"));
          const defaults = periodo.prefijo&&de2026.length?de2026:EXCEL_DEFAULTS;
          setActiveProy(defaults);
          for(const pn of defaults){
            try {
              await sb.from("presupuestos_activos").delete().eq("proyecto",periodo.prefijo+pn);
              await sb.from("presupuestos_activos").insert({proyecto:periodo.prefijo+pn});
            } catch(e){}
          }
        }
      } catch(e){
        // Sin BD: usar Excel directamente
        const mapa={};
        Object.entries(EXCEL_INICIAL).forEach(([pn,v])=>{
          mapa[pn]={};
          MESES_PREV.forEach((_,mi)=>{ mapa[pn][String(mi)]={ing_est:v.ing[mi]||0,gas_est:v.gas[mi]||0}; });
        });
        setPresup(mapa);
        setActiveProy(EXCEL_DEFAULTS);
      }
      setLoading(false);
    }
    load();
  },[]);

  async function addProyecto(pn){
    if(!pn||activeProy.includes(pn)) return;
    setActiveProy(prev=>[...prev,pn]);
    setPresup(prev=>{
      const next2=JSON.parse(JSON.stringify(prev||{}));
      if(!next2[pn]){ next2[pn]={}; MESES_PREV.forEach((_,mi)=>{ next2[pn][String(mi)]={ing_est:0,gas_est:0}; }); }
      return next2;
    });
    try {
      await sb.from("presupuestos_activos").delete().eq("proyecto",periodo.prefijo+pn);
      const {error} = await sb.from("presupuestos_activos").insert({proyecto:periodo.prefijo+pn});
      if(error) console.error("presupuestos_activos insert",error);
    } catch(e){ console.error(e); }
    setAddModal(false);
  }

  async function removeProyecto(pn){
    if(!window.confirm(`¿Quitar "${pn}" de las previsiones ${periodo.titulo}? Los datos estimados se conservan.`)) return;
    setActiveProy(prev=>prev.filter(p=>p!==pn));
    try {
      const {error} = await sb.from("presupuestos_activos").delete().eq("proyecto",periodo.prefijo+pn);
      if(error) console.error("presupuestos_activos delete",error);
    } catch(e){ console.error(e); }
  }

  async function saveCell(pn,mi,tipo,val){
    const num=parseFloat(val)||0;
    setPresup(prev=>{
      const next=JSON.parse(JSON.stringify(prev));
      if(!next[pn]) next[pn]={};
      if(!next[pn][K(mi)]) next[pn][K(mi)]={ing_est:0,gas_est:0};
      next[pn][K(mi)][tipo]=num;
      return next;
    });
    setSaving(true);
    try{
      const cur=presup?.[pn]?.[K(mi)]||{ing_est:0,gas_est:0};
      const {error} = await sb.from("presupuestos_2026").upsert({
        proyecto:pn, mes:parseInt(K(mi)),
        ing_est:tipo==="ing_est"?num:cur.ing_est,
        gas_est:tipo==="gas_est"?num:cur.gas_est,
      },{onConflict:"proyecto,mes"});
      if(error){ console.error("presupuestos_2026 upsert",error); alert("Error guardando la previsión: "+error.message); }
    }catch(e){console.error(e);}
    setSaving(false);
    setEditCell(null);
  }

  // Acepta D/M/AAAA, DD/MM/AA y AAAA-MM-DD (antes las fechas sin cero delante se quedaban fuera)
  function matchMes(fecha,mi){
    const pm=periodo.meses[mi], ym=fechaYM(fecha);
    return !!ym&&ym.m===pm.mes&&ym.y===pm.year;
  }
  const otrosComp=(otros||[]).filter(o=>o.computa);
  // pn===null → todos los proyectos (incluidas facturas sin proyecto)
  function realIng(pn,mi){
    const f=(ing||[]).filter(r=>(pn===null||r.proyecto===pn)&&matchMes(r.fecha,mi)).reduce((s,r)=>s+signedBase(r),0);
    const o=otrosComp.filter(r=>r.importe>0&&(pn===null||r.proyecto===pn)&&matchMes(r.fecha,mi)).reduce((s,r)=>s+r.importe,0);
    return f+o;
  }
  function realGas(pn,mi){
    const f=(gas||[]).filter(r=>(pn===null||r.proyecto===pn)&&matchMes(r.fecha,mi)).reduce((s,r)=>s+signedBase(r),0);
    const h=(hojas||[]).filter(r=>matchMes(r.fecha,mi)).reduce((s,r)=>
      s+(pn===null?(parseFloat(r.importe)||0):hojaPorProyecto(r).filter(x=>x.proyecto===pn).reduce((a,x)=>a+x.importe,0)),0);
    const o=otrosComp.filter(r=>r.importe<0&&(pn===null||r.proyecto===pn)&&matchMes(r.fecha,mi)).reduce((s,r)=>s-r.importe,0);
    return f+h+o;
  }

  function renderValEst(pn,mi,tipo){
    const est=presup?.[pn]?.[K(mi)]?.[tipo]||0;
    const isEd=editCell?.pn===pn&&editCell?.mi===mi&&editCell?.tipo===tipo;
    if(isEd) return(
      <input autoFocus value={editVal} onChange={e=>setEditVal(e.target.value)}
        onBlur={()=>saveCell(pn,mi,tipo,editVal)}
        onKeyDown={e=>{if(e.key==="Enter")saveCell(pn,mi,tipo,editVal);if(e.key==="Escape")setEditCell(null);}}
        style={{width:52,fontSize:10,padding:"2px 3px",border:"1px solid #F59E0B",borderRadius:3,fontFamily:"inherit",textAlign:"right",background:"#453B11"}}/>
    );
    return(
      <span onDoubleClick={()=>{setEditCell({pn,mi,tipo});setEditVal(String(est));}}
        title="Doble clic para editar"
        style={{cursor:"pointer",display:"block",textAlign:"right",minWidth:38}}>
        {est!==0?est.toFixed(0):<span style={{color:"#4A515D"}}>—</span>}
      </span>
    );
  }

  function dc(dif,tipo){ if(dif===0) return "#7F8692"; return tipo==="ing"?(dif>0?"#059669":"#EB8484"):(dif<0?"#059669":"#DC2626"); }

  function genPDF(){
    const meses = MESES;
    const fecha = new Date().toLocaleDateString("es-ES",{day:"2-digit",month:"long",year:"numeric"});
    function fmt(v){ if(!v||Math.round(v)===0) return "—"; return Math.round(v).toLocaleString("es-ES",{maximumFractionDigits:0}); }
    function difStr(r,e){
      if(r===0&&e===0) return "";
      const d=r-e; if(d===0) return "0";
      return (d>0?"▲":"▼")+Math.abs(d).toLocaleString("es-ES",{maximumFractionDigits:0});
    }
    function difCol(r,e,tipo){
      const d=r-e;
      return tipo==="ing"?(d>=0?"#059669":"#DC2626"):(d<=0?"#059669":"#DC2626");
    }

    const proyRows = activeProy.map(pn=>{
      const ie=meses.map((_,mi)=>presup?.[pn]?.[K(mi)]?.ing_est||0);
      const ge=meses.map((_,mi)=>presup?.[pn]?.[K(mi)]?.gas_est||0);
      const ir=meses.map((_,mi)=>realIng(pn,mi));
      const gr=meses.map((_,mi)=>realGas(pn,mi));
      return{pn,ie,ge,ir,gr,
        tie:prevSum(ie,ir),tge:prevSum(ge,gr),
        tir:ir.reduce((a,b)=>a+b,0),tgr:gr.reduce((a,b)=>a+b,0)};
    });

    const totIE=meses.map((_,mi)=>proyRows.reduce((s,r)=>s+r.ie[mi],0));
    const totGE=meses.map((_,mi)=>proyRows.reduce((s,r)=>s+r.ge[mi],0));
    // Real total = todas las facturas, hojas y otros gastos (también los que no están en un proyecto de la previsión)
    const totIR=meses.map((_,mi)=>realIng(null,mi));
    const totGR=meses.map((_,mi)=>realGas(null,mi));
    const sumIE=prevSum(totIE,totIR),sumGE=prevSum(totGE,totGR);
    const sumIR=totIR.reduce((a,b)=>a+b,0),sumGR=totGR.reduce((a,b)=>a+b,0);
    const pct_i=sumIE>0?((sumIR/sumIE)*100).toFixed(0):0;
    const pct_g=sumGE>0?((sumGR/sumGE)*100).toFixed(0):0;

    function sectionRows(lbl,est,real,te,tr,tipo,bgEst,bgReal){
      return `
        <tr>
          <td class="col-lbl">${lbl}</td>
          ${est.map(v=>`<td class="${bgEst}">${fmt(v)}</td>`).join("")}
          <td class="col-tot col-${tipo}-est">${fmt(te)}</td>
        </tr>
        <tr>
          <td class="col-lbl col-real">Real</td>
          ${real.map(v=>{
            if(v===0) return `<td class="${bgReal}"></td>`;
            const col=tipo==="ing"?"#059669":"#DC2626";
            return `<td class="${bgReal}"><b style="color:${col}">${fmt(v)}</b></td>`;
          }).join("")}
          <td class="col-tot col-${tipo}-real">${tr!==0?`<b>${fmt(tr)}</b>`:""}</td>
        </tr>
        <tr>
          <td class="col-lbl col-dif">∆</td>
          ${meses.map((_,i)=>{
            const ds=difStr(real[i],est[i]);
            if(!ds) return `<td class="bg-dif"></td>`;
            const col=difCol(real[i],est[i],tipo);
            return `<td class="bg-dif"><span style="color:${col};font-weight:700">${ds}</span></td>`;
          }).join("")}
          <td class="col-tot bg-dif">${difStr(tr,te)?`<span style="color:${difCol(tr,te,tipo)};font-weight:700">${difStr(tr,te)}</span>`:""}</td>
        </tr>`;
    }

    const proyHtml = proyRows.map(({pn,ie,ge,ir,gr,tie,tge,tir,tgr})=>{
      const me=ie.map((v,i)=>v-ge[i]), mr=ir.map((v,i)=>v-gr[i]);
      return `
        <tr class="proj-hdr"><td colspan="${MESES.length+2}">${pn}</td></tr>
        ${sectionRows("Ingresos",ie,ir,tie,tir,"ing","bg-ing-est","bg-ing-real")}
        ${sectionRows("Gastos",  ge,gr,tge,tgr,"gas","bg-gas-est","bg-gas-real")}
        ${sectionRows("Margen",  me,mr,tie-tge,tir-tgr,"ing","bg-mar-est","bg-mar-real")}`;
    }).join("");

    const totales = [
      ["Ingresos · Prev.", totIE, sumIE, "#065F46"],
      ["Ingresos · Real", totIR, sumIR, "#059669"],
      ["Gastos · Prev.",   totGE, sumGE, "#991B1B"],
      ["Gastos · Real",   totGR, sumGR, "#DC2626"],
      ["Margen · Prev.",   totIE.map((v,i)=>v-totGE[i]), sumIE-sumGE, "#D5D9E0"],
      ["Margen · Real",   totIR.map((v,i)=>v-totGR[i]), sumIR-sumGR, "#ECEEF2"],
    ].map(([lbl,vals,tot,bg])=>`
      <tr style="background:${bg}">
        <td class="col-lbl" style="color:white;font-weight:700">${lbl}</td>
        ${vals.map(v=>`<td style="color:white;font-weight:600;text-align:center;padding:5px 3px">${fmt(v)}</td>`).join("")}
        <td class="col-tot" style="color:white;font-weight:800;font-size:9px">${fmt(tot)}</td>
      </tr>`).join("");

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${EMPRESA} — Previsiones Financieras ${periodo.titulo}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:8px;color:#ECEEF2;padding:16px 20px}
.hdr{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px;padding-bottom:12px;border-bottom:2.5px solid #ECEEF2}
.brand{font-size:26px;font-weight:900;letter-spacing:-1.5px;line-height:1}
.brand-sub{font-size:8.5px;color:#9AA1AC;margin-top:3px}
.doc-right{text-align:right}
.doc-right h1{font-size:15px;font-weight:800;letter-spacing:-.3px}
.doc-right p{font-size:8.5px;color:#9AA1AC;margin-top:4px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.kpi{border-radius:7px;padding:10px 14px;border:1.5px solid}
.kpi.g{background:#114521;border-color:#BBF7D0}
.kpi.r{background:#451111;border-color:#FECACA}
.kpi.b{background:#112845;border-color:#BFDBFE}
.kpi-lbl{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.kpi.g .kpi-lbl{color:#059669}.kpi.r .kpi-lbl{color:#EB8484}.kpi.b .kpi-lbl{color:#D5D9E0}
.kpi-val{font-size:20px;font-weight:800;letter-spacing:-1px;line-height:1.1}
.kpi.g .kpi-val{color:#059669}.kpi.r .kpi-val{color:#EB8484}.kpi.b .kpi-val{color:#D5D9E0}
.kpi-sub{font-size:8px;color:#7F8692;margin-top:3px}
.legend{background:#232831;border:1px solid #2E343E;border-radius:5px;padding:7px 12px;font-size:8px;margin-bottom:10px;color:#C3C8D0}
.sec-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:7px;color:#ECEEF2}
table{width:100%;border-collapse:collapse}
th{background:#3A414D;color:white;padding:5px 3px;text-align:center;font-size:7.5px;font-weight:700;border-right:1px solid #39404A}
th:first-child{text-align:left;padding-left:8px;width:74px}
th:last-child{background:#323844;border-left:2px solid #39404A;width:50px}
.proj-hdr td{background:#323844;color:white;font-weight:800;font-size:9px;padding:6px 8px;border-top:3px solid white}
td{padding:3px 3px;vertical-align:middle;border-right:1px solid #2E343E;text-align:center}
.col-lbl{text-align:left!important;padding-left:8px;border-right:2px solid #2E343E;white-space:nowrap;font-weight:600;color:#C3C8D0}
.col-real{font-style:italic;color:#7F8692;font-size:7px;font-weight:400}
.col-dif{color:#7F8692;font-size:7px;font-weight:400}
.col-tot{border-left:2px solid #1F477A;font-weight:700;padding:3px 6px}
.col-ing-est{color:#C3C8D0;background:#114521}
.col-ing-real{color:#059669;background:#114523}
.col-gas-est{color:#C3C8D0;background:#451111}
.col-gas-real{color:#EB8484;background:#451111}
.bg-ing-est{background:#114521}
.bg-ing-real{background:#114523}
.bg-gas-est{background:#451111}
.bg-gas-real{background:#451111}
.bg-mar-est{background:#112845}
.bg-mar-real{background:#112845}
.bg-dif{background:#232831;border-bottom:1px solid #2E343E;font-size:7px}
.footer{margin-top:14px;padding-top:8px;border-top:1px solid #2E343E;display:flex;justify-content:space-between;font-size:7.5px;color:#7F8692}
@media print{body{padding:8px 10px}@page{size:A4 landscape;margin:7mm}}
</style></head><body>
<div class="hdr">
  <div><div class="brand">${EMPRESA}</div><div class="brand-sub">${EMPRESA_SUB}</div></div>
  <div class="doc-right"><h1>Previsiones Financieras ${periodo.titulo}</h1><p>Generado el ${fecha} · ${activeProy.length} proyectos activos</p></div>
</div>
<div class="kpis">
  <div class="kpi g"><div class="kpi-lbl">Ingresos previstos</div><div class="kpi-val">${fmt(sumIE)} €</div><div class="kpi-sub">Real: ${fmt(sumIR)} € · ${pct_i}% del objetivo</div></div>
  <div class="kpi r"><div class="kpi-lbl">Gastos previstos</div><div class="kpi-val">${fmt(sumGE)} €</div><div class="kpi-sub">Real: ${fmt(sumGR)} € · ${pct_g}% del presupuesto</div></div>
  <div class="kpi b"><div class="kpi-lbl">Margen previsto</div><div class="kpi-val">${fmt(sumIE-sumGE)} €</div><div class="kpi-sub">Real: ${fmt(sumIR-sumGR)} €</div></div>
</div>
<div class="legend"><b>Cómo leer este informe:</b>&nbsp;&nbsp;
  Fila <b>superior</b> = Estimado &nbsp;·&nbsp; Fila <b>central</b> = Real (facturas) &nbsp;·&nbsp;
  <b>∆</b> = Real − Estimado &nbsp;·&nbsp; <b>TOTAL</b> previsto = real de los meses pasados + estimado de este mes y los siguientes &nbsp;·&nbsp;
  <span style="color:#059669"><b>▲</b> Verde = favorable</span> &nbsp;·&nbsp;
  <span style="color:#EB8484"><b>▼</b> Rojo = desfavorable</span>
</div>
<div class="sec-title">Detalle por proyecto — ${periodo.rango}</div>
<table>
  <thead><tr>
    <th> </th>
    ${meses.map(m=>`<th>${m}</th>`).join("")}
    <th>TOTAL</th>
  </tr></thead>
  <tbody>
    ${proyHtml}
    <tr style="height:6px"><td colspan="${MESES.length+2}"></td></tr>
    ${totales}
  </tbody>
</table>
<div class="footer">
  <span>${EMPRESA} · ${EMPRESA_SUB} · Documento confidencial</span>
  <span>Previsiones ${periodo.titulo} · ${fecha}</span>
</div>
</body></html>`;

    const win=window.open("","_blank");
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(()=>win.print(),500);
  }

    if(loading||!activeProy) return <div style={{padding:40,textAlign:"center",color:"#7F8692"}}>Cargando previsiones...</div>;

  const totIngEst  = MESES.map((_,mi)=>activeProy.reduce((s,pn)=>s+(presup?.[pn]?.[K(mi)]?.ing_est||0),0));
  const totGasEst  = MESES.map((_,mi)=>activeProy.reduce((s,pn)=>s+(presup?.[pn]?.[K(mi)]?.gas_est||0),0));
  // Real total: TODO lo facturado/gastado en el mes, esté o no el proyecto en la previsión
  const totIngReal = MESES.map((_,mi)=>realIng(null,mi));
  const totGasReal = MESES.map((_,mi)=>realGas(null,mi));
  // Parte del real que no cae en ningún proyecto de la previsión (sin proyecto u otros proyectos)
  const fueraIng = MESES.map((_,mi)=>totIngReal[mi]-activeProy.reduce((s,pn)=>s+realIng(pn,mi),0));
  const fueraGas = MESES.map((_,mi)=>totGasReal[mi]-activeProy.reduce((s,pn)=>s+realGas(pn,mi),0));
  const hayFuera = fueraIng.some(v=>Math.abs(v)>=0.5)||fueraGas.some(v=>Math.abs(v)>=0.5);
  const sumIE=totIngEst.reduce((a,b)=>a+b,0), sumGE=totGasEst.reduce((a,b)=>a+b,0);
  const sumIR=totIngReal.reduce((a,b)=>a+b,0), sumGR=totGasReal.reduce((a,b)=>a+b,0);

  // Proyectos del dashboard no añadidos aún
  const disponibles=(projects||[]).filter(p=>!activeProy.includes(p.name));

  function renderTablaProyecto(pn){
    const proj=(projects||[]).find(p=>p.name===pn);
    const color=proj?.color||"#C3C8D0";
    const fIng=(ing||[]).filter(r=>r.proyecto===pn);
    const fGas=(gas||[]).filter(r=>r.proyecto===pn);
    const fHoj=(hojas||[]).map(r=>({...r,_imp:hojaPorProyecto(r).filter(x=>x.proyecto===pn).reduce((a,x)=>a+x.importe,0)})).filter(r=>r._imp!==0);
    const fOtr=(otros||[]).filter(o=>o.computa&&o.importe<0&&o.proyecto===pn);
    const iE=prevSum(MESES.map((_,mi)=>presup?.[pn]?.[K(mi)]?.ing_est||0),MESES.map((_,mi)=>realIng(pn,mi)));
    const gE=prevSum(MESES.map((_,mi)=>presup?.[pn]?.[K(mi)]?.gas_est||0),MESES.map((_,mi)=>realGas(pn,mi)));
    const iR=MESES.reduce((s,_,mi)=>s+realIng(pn,mi),0);
    const gR=MESES.reduce((s,_,mi)=>s+realGas(pn,mi),0);

    return(
      <div style={{marginBottom:14,border:"1px solid #2E343E",borderRadius:12,overflow:"hidden"}}>
        {/* Cabecera */}
        <div style={{background:color,padding:"8px 14px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={()=>setProySel(proySel===pn?null:pn)}>
            <span style={{color:"#FFF",fontWeight:800,fontSize:13}}>{pn}</span>
            <span style={{background:"rgba(255,255,255,0.18)",color:"#FFF",fontSize:9,padding:"2px 8px",borderRadius:99}}>
              {fIng.length} fact.ing · {fGas.length+fHoj.length+fOtr.length} gastos
            </span>
          </div>
          <div style={{display:"flex",gap:14,alignItems:"center"}}>
            <span style={{color:"rgba(255,255,255,0.85)",fontSize:10}}>
              Ing: <b>{iE.toFixed(0)}€</b> prev · <b style={{color:iR>=iE?"#86EFAC":"#FCA5A5"}}>{iR.toFixed(0)}€</b> real
            </span>
            <span style={{color:"rgba(255,255,255,0.85)",fontSize:10}}>
              Gas: <b>{gE.toFixed(0)}€</b> prev · <b style={{color:gR<=gE?"#86EFAC":"#FCA5A5"}}>{gR.toFixed(0)}€</b> real
            </span>
            <span style={{color:"#FFF",fontSize:10}}>
              Margen: <b style={{color:(iR-gR)>=0?"#86EFAC":"#FCA5A5"}}>{(iR-gR).toFixed(0)}€</b>
            </span>
            <button onClick={()=>setProySel(proySel===pn?null:pn)}
              style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#FFF",borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:11}}>
              {proySel===pn?"▲":"▼"}
            </button>
            <button onClick={()=>removeProyecto(pn)} title="Quitar de previsiones"
              style={{background:"rgba(255,255,255,0.15)",border:"none",color:"rgba(255,255,255,0.7)",borderRadius:5,padding:"2px 7px",cursor:"pointer",fontSize:11}}>
              ✕
            </button>
          </div>
        </div>

        {/* Tabla mensual */}
        <div style={{overflowX:"auto",background:"#1F232B"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead>
              <tr style={{background:"#262B34"}}>
                <th style={{padding:"5px 10px",textAlign:"left",fontSize:9,color:"#9AA1AC",fontWeight:700,width:75,borderRight:"2px solid #2E343E"}}>Concepto</th>
                {MESES.map((m,mi)=>(
                  <th key={m} colSpan={3} style={{padding:"4px 0",textAlign:"center",fontSize:9,fontWeight:700,
                    color:esMesActual(mi)?"#D5D9E0":"#9AA1AC",
                    borderRight:"1px solid #2E343E",
                    background:esMesActual(mi)?"#112845":"transparent",
                    minWidth:114}}>
                    {m}
                  </th>
                ))}
                <th colSpan={3} style={{padding:"4px 0",textAlign:"center",fontSize:9,fontWeight:700,color:"#D5D9E0",background:"#112845",minWidth:114}}>TOTAL</th>
              </tr>
              <tr style={{background:"#232831",borderBottom:"2px solid #2E343E"}}>
                <th style={{borderRight:"2px solid #2E343E",padding:"3px 0"}}></th>
                {[...MESES,"T"].map((_,i)=>(
                  <Fragment key={i}>
                    <th title={i===MESES.length?"Previsión: real de los meses pasados + estimado de este mes y los siguientes":undefined} style={{padding:"2px 3px",textAlign:"right",fontSize:8,color:i===MESES.length?"#D5D9E0":"#7F8692",fontWeight:i===MESES.length?800:600,width:38}}>{i===MESES.length?"Prev.":"Est."}</th>
                    <th style={{padding:"2px 3px",textAlign:"right",fontSize:8,color:"#059669",fontWeight:600,width:38}}>Real</th>
                    <th style={{padding:"2px 3px",textAlign:"right",fontSize:8,color:"#E8501C",fontWeight:600,width:38,borderRight:"1px solid #2E343E"}}>Dif.</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                {label:"💰 Ingresos",tipo:"ing",bg:"#114521",cr:"#059669",et:"ing_est",getEst:mi=>presup?.[pn]?.[K(mi)]?.ing_est||0,getReal:mi=>realIng(pn,mi)},
                {label:"💸 Gastos",  tipo:"gas",bg:"#451111",cr:"#DC2626",et:"gas_est",getEst:mi=>presup?.[pn]?.[K(mi)]?.gas_est||0,getReal:mi=>realGas(pn,mi)},
              ].map(row=>{
                const tE=prevSum(MESES.map((_,mi)=>row.getEst(mi)),MESES.map((_,mi)=>row.getReal(mi)));
                const tR=MESES.reduce((s,_,mi)=>s+row.getReal(mi),0);
                const tD=tR-tE;
                return(
                  <tr key={row.label} style={{background:row.bg,borderBottom:"1px solid #2E343E"}}>
                    <td style={{padding:"5px 10px",fontWeight:700,fontSize:10,color:row.cr,borderRight:"2px solid #2E343E",whiteSpace:"nowrap"}}>{row.label}</td>
                    {MESES.map((_,mi)=>{
                      const e=row.getEst(mi), r=row.getReal(mi), d=r-e;
                      return(
                        <Fragment key={mi}>
                          <td style={{padding:"4px 3px",textAlign:"right",color:"#C3C8D0",fontWeight:500,fontSize:10}}>
                            {renderValEst(pn,mi,row.et)}
                          </td>
                          <td style={{padding:"4px 3px",textAlign:"right",color:row.cr,fontWeight:r!==0?700:400,fontSize:10}}>
                            {r!==0?r.toFixed(0):<span style={{color:"#4A515D"}}>—</span>}
                          </td>
                          <td style={{padding:"4px 4px",textAlign:"right",fontWeight:600,fontSize:10,borderRight:"1px solid #2E343E",color:e===0&&r===0?"#4A515D":dc(d,row.tipo)}}>
                            {e===0&&r===0?"—":d===0?"0":(d>0?"+":"")+d.toFixed(0)}
                          </td>
                        </Fragment>
                      );
                    })}
                    <Fragment>
                      <td style={{padding:"4px 3px",textAlign:"right",fontWeight:700,color:"#C3C8D0",background:"#112845",fontSize:10}}>{tE.toFixed(0)}</td>
                      <td style={{padding:"4px 3px",textAlign:"right",fontWeight:700,color:row.cr,background:"#112845",fontSize:10}}>{tR!==0?tR.toFixed(0):"—"}</td>
                      <td style={{padding:"4px 6px",textAlign:"right",fontWeight:700,background:"#112845",fontSize:10,color:dc(tD,row.tipo)}}>{(tD>=0?"+":"")+tD.toFixed(0)}</td>
                    </Fragment>
                  </tr>
                );
              })}
              {/* Margen */}
              {(()=>{
                const tIE=iE, tGE=gE;
                const tIR=MESES.reduce((s,_,mi)=>s+realIng(pn,mi),0);
                const tGR=MESES.reduce((s,_,mi)=>s+realGas(pn,mi),0);
                const mE=tIE-tGE, mR=tIR-tGR, tD=mR-mE;
                return(
                  <tr style={{background:"#232831",borderTop:"2px solid #3A414D"}}>
                    <td style={{padding:"5px 10px",fontWeight:800,fontSize:10,color:"#D5D9E0",borderRight:"2px solid #2E343E"}}>📈 Margen</td>
                    {MESES.map((_,mi)=>{
                      const ie=presup?.[pn]?.[K(mi)]?.ing_est||0, ge=presup?.[pn]?.[K(mi)]?.gas_est||0;
                      const ir=realIng(pn,mi), gr=realGas(pn,mi);
                      const ne=ie-ge, nr=ir-gr, d=nr-ne;
                      return(
                        <Fragment key={mi}>
                          <td style={{padding:"4px 3px",textAlign:"right",fontWeight:700,fontSize:10,color:ne>=0?"#059669":"#EB8484"}}>{ne!==0?ne.toFixed(0):"—"}</td>
                          <td style={{padding:"4px 3px",textAlign:"right",fontWeight:700,fontSize:10,color:nr>=0?"#059669":"#EB8484"}}>{(ir!==0||gr!==0)?nr.toFixed(0):"—"}</td>
                          <td style={{padding:"4px 4px",textAlign:"right",fontWeight:700,fontSize:10,borderRight:"1px solid #2E343E",color:(ie===0&&ge===0&&ir===0&&gr===0)?"#4A515D":dc(d,"ing")}}>
                            {(ie===0&&ge===0&&ir===0&&gr===0)?"—":(d>=0?"+":"")+d.toFixed(0)}
                          </td>
                        </Fragment>
                      );
                    })}
                    <Fragment>
                      <td style={{padding:"4px 3px",textAlign:"right",fontWeight:800,fontSize:10,color:mE>=0?"#059669":"#EB8484",background:"#112845"}}>{mE.toFixed(0)}</td>
                      <td style={{padding:"4px 3px",textAlign:"right",fontWeight:800,fontSize:10,color:mR>=0?"#059669":"#EB8484",background:"#112845"}}>{(tIR!==0||tGR!==0)?mR.toFixed(0):"—"}</td>
                      <td style={{padding:"4px 6px",textAlign:"right",fontWeight:800,fontSize:10,background:"#112845",color:dc(tD,"ing")}}>{(tD>=0?"+":"")+tD.toFixed(0)}</td>
                    </Fragment>
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </div>

        {/* Detalle facturas */}
        {proySel===pn&&(
          <div style={{background:"#232831",borderTop:"2px solid #2E343E",padding:"14px 16px"}}>
            <div style={{fontWeight:700,fontSize:12,color:"#C3C8D0",marginBottom:10}}>📄 Facturas vinculadas — {pn}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <div>
                <div style={{fontWeight:600,fontSize:11,color:"#059669",marginBottom:6}}>Ingresos ({fIng.length})</div>
                {fIng.length===0?<div style={{fontSize:10,color:"#7F8692"}}>Sin facturas de ingreso</div>:(
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                    <thead><tr style={{background:"#11452D"}}>
                      {["Ref","Fecha","Base €","Descripción"].map(h=><th key={h} style={{padding:"3px 8px",textAlign:h==="Base €"?"right":"left",color:"#059669",fontWeight:600}}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {fIng.map((f,i)=>(
                        <tr key={i} style={{borderTop:"1px solid #1F7A4B"}}>
                          <td style={{padding:"3px 8px",fontWeight:600}}>{f.ref||"—"}</td>
                          <td style={{padding:"3px 8px",color:"#9AA1AC"}}>{f.fecha||"—"}</td>
                          <td style={{padding:"3px 8px",textAlign:"right",color:"#059669",fontWeight:700}}>{signedBase(f).toFixed(2)}</td>
                          <td style={{padding:"3px 8px",color:"#9AA1AC",maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.descripcion||"—"}</td>
                        </tr>
                      ))}
                      <tr style={{borderTop:"2px solid #1F7A3F",background:"#11452D"}}>
                        <td colSpan={2} style={{padding:"4px 8px",fontWeight:700,color:"#059669"}}>TOTAL</td>
                        <td style={{padding:"4px 8px",textAlign:"right",fontWeight:800,color:"#059669"}}>{fIng.reduce((s,f)=>s+signedBase(f),0).toFixed(2)}€</td>
                        <td></td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <div style={{fontWeight:600,fontSize:11,color:"#EB8484",marginBottom:6}}>Gastos ({fGas.length+fHoj.length+fOtr.length})</div>
                {(fGas.length+fHoj.length+fOtr.length)===0?<div style={{fontSize:10,color:"#7F8692"}}>Sin gastos registrados</div>:(
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                    <thead><tr style={{background:"#451111"}}>
                      {["Concepto","Fecha","Importe €","Tipo"].map(h=><th key={h} style={{padding:"3px 8px",textAlign:h==="Importe €"?"right":"left",color:"#EB8484",fontWeight:600}}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {fGas.map((f,i)=>(
                        <tr key={"g"+i} style={{borderTop:"1px solid #7A1F1F"}}>
                          <td style={{padding:"3px 8px",fontWeight:600}}>{f.ref||f.descripcion||"—"}</td>
                          <td style={{padding:"3px 8px",color:"#9AA1AC"}}>{f.fecha||"—"}</td>
                          <td style={{padding:"3px 8px",textAlign:"right",color:"#EB8484",fontWeight:700}}>{signedBase(f).toFixed(2)}</td>
                          <td style={{padding:"3px 8px",color:"#7F8692"}}>Factura</td>
                        </tr>
                      ))}
                      {fHoj.map((f,i)=>(
                        <tr key={"h"+i} style={{borderTop:"1px solid #7A1F1F"}}>
                          <td style={{padding:"3px 8px",fontWeight:600}}>{f.concepto||"—"}</td>
                          <td style={{padding:"3px 8px",color:"#9AA1AC"}}>{f.fecha||"—"}</td>
                          <td style={{padding:"3px 8px",textAlign:"right",color:"#EB8484",fontWeight:700}}>{f._imp.toFixed(2)}</td>
                          <td style={{padding:"3px 8px",color:"#7F8692"}}>H. Gasto</td>
                        </tr>
                      ))}
                      {fOtr.map((f,i)=>(
                        <tr key={"o"+i} style={{borderTop:"1px solid #7A1F1F"}}>
                          <td style={{padding:"3px 8px",fontWeight:600}}>{f.nota||f.concepto||"—"}</td>
                          <td style={{padding:"3px 8px",color:"#9AA1AC"}}>{f.fecha||"—"}</td>
                          <td style={{padding:"3px 8px",textAlign:"right",color:"#EB8484",fontWeight:700}}>{(-f.importe).toFixed(2)}</td>
                          <td style={{padding:"3px 8px",color:"#7F8692"}}>Otro gasto</td>
                        </tr>
                      ))}
                      <tr style={{borderTop:"2px solid #7A1F1F",background:"#451111"}}>
                        <td colSpan={2} style={{padding:"4px 8px",fontWeight:700,color:"#EB8484"}}>TOTAL</td>
                        <td style={{padding:"4px 8px",textAlign:"right",fontWeight:800,color:"#EB8484"}}>
                          {(fGas.reduce((s,f)=>s+signedBase(f),0)+fHoj.reduce((s,f)=>s+f._imp,0)+fOtr.reduce((s,f)=>s-f.importe,0)).toFixed(2)}€
                        </td>
                        <td></td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontWeight:800,fontSize:17,color:"#ECEEF2"}}>📊 Previsiones {periodo.titulo}</div>
          <div style={{fontSize:11,color:"#9AA1AC",marginTop:2}}>Doble clic en Est. para editar · Clic ▼ para ver facturas · ✕ para quitar proyecto</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {saving&&<span style={{fontSize:10,color:"#F59E0B",fontWeight:600}}>💾 Guardando...</span>}
          <button onClick={genPDF}
            style={{background:"#262B34",color:"#C3C8D0",border:"1px solid #2E343E",borderRadius:8,padding:"7px 14px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
            ⬇ Exportar PDF
          </button>
          <button onClick={()=>setAddModal(true)}
            style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"7px 14px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:6}}>
            + Añadir proyecto
          </button>
        </div>
      </div>

      {/* Modal añadir proyecto */}
      {addModal&&<AñadirProyectoModal disponibles={disponibles} onElegir={addProyecto} onCerrar={()=>setAddModal(false)}/>}

      {/* Arriba solo lo que hay en el banco; en Corea además los objetivos NY + Corea */}
      {periodo.id==="corea"
        ? <ObjetivosCard presup={presup} activeProy={activeProy} banco={banco} ing={ing} gas={gas} hojas={hojas}/>
        : <BancoSoloCard banco={banco}/>}

      {/* Leyenda */}
      <div style={{display:"flex",gap:14,marginBottom:12,fontSize:10,color:"#9AA1AC"}}>
        <span><b style={{color:"#7F8692"}}>Est.</b> Estimado</span>
        <span><b style={{color:"#059669"}}>Real</b> Facturas + hojas + otros gastos</span>
        <span><b style={{color:"#E8501C"}}>Dif.</b> Real − Est.</span>
        <span><b style={{color:"#D5D9E0"}}>Prev.</b> (TOTAL) real de los meses pasados + est. de este mes y los siguientes</span>
        <span style={{color:"#059669",fontWeight:600}}>Verde = favorable &nbsp; </span>
        <span style={{color:"#EB8484",fontWeight:600}}>Rojo = desfavorable</span>
      </div>

      {/* Tablas por proyecto */}
      {activeProy.length===0
        ? <div style={{textAlign:"center",padding:"40px 0",color:"#7F8692",fontSize:13}}>
            No hay proyectos en previsiones. Pulsa "+ Añadir proyecto" para empezar.
          </div>
        : activeProy.map(pn=><Fragment key={pn}>{renderTablaProyecto(pn)}</Fragment>)
      }

      {/* Total empresa */}
      {activeProy.length>0&&(
        <div style={{border:"2px solid #262B34",borderRadius:12,overflow:"hidden",marginTop:8}}>
          <div style={{background:"#323844",padding:"9px 14px",color:"#FFF",fontWeight:800,fontSize:13,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span>🏢 TOTAL {EMPRESA.toUpperCase()}</span>
            <span style={{fontSize:9.5,fontWeight:500,color:"rgba(255,255,255,0.75)"}}>Real = todas las facturas, hojas de gasto y otros gastos del mes{hayFuera?" (también lo que está fuera de los proyectos de la previsión)":""}</span>
          </div>
          <div style={{overflowX:"auto",background:"#1F232B"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead>
                <tr style={{background:"#112845"}}>
                  <th style={{padding:"5px 10px",textAlign:"left",fontSize:9,color:"#D5D9E0",fontWeight:700,width:75,borderRight:"2px solid #1F477A"}}>Concepto</th>
                  {MESES.map((m,mi)=>(
                    <th key={m} colSpan={3} style={{padding:"4px 0",textAlign:"center",fontSize:9,fontWeight:700,
                      color:esMesActual(mi)?"#D5D9E0":"#9AA1AC",
                      borderRight:"1px solid #1F477A",
                      background:esMesActual(mi)?"#112845":"transparent",minWidth:114}}>
                      {m}
                    </th>
                  ))}
                  <th colSpan={3} style={{padding:"4px 0",textAlign:"center",fontSize:9,fontWeight:700,color:"#D5D9E0",background:"#112845",minWidth:114}}>TOTAL</th>
                </tr>
                <tr style={{background:"#262B34",borderBottom:"2px solid #3A414D"}}>
                  <th style={{borderRight:"2px solid #1F477A",padding:"2px 0"}}></th>
                  {[...MESES,"T"].map((_,i)=>(
                    <Fragment key={i}>
                      <th title={i===MESES.length?"Previsión: real de los meses pasados + estimado de este mes y los siguientes":undefined} style={{padding:"2px 3px",textAlign:"right",fontSize:8,color:i===MESES.length?"#D5D9E0":"#7F8692",fontWeight:i===MESES.length?800:600,width:38}}>{i===MESES.length?"Prev.":"Est."}</th>
                      <th style={{padding:"2px 3px",textAlign:"right",fontSize:8,color:"#059669",fontWeight:600,width:38}}>Real</th>
                      <th style={{padding:"2px 3px",textAlign:"right",fontSize:8,color:"#E8501C",fontWeight:600,width:38,borderRight:"1px solid #3A414D"}}>Dif.</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  {label:"💰 Ingresos",est:totIngEst,real:totIngReal,tipo:"ing",bg:"#114521",cr:"#059669"},
                  ...(hayFuera&&fueraIng.some(v=>Math.abs(v)>=0.5)?[{label:"↳ fuera de previsión",est:MESES.map(()=>0),real:fueraIng,tipo:"ing",bg:"#232831",cr:"#9AA1AC",sub:true}]:[]),
                  {label:"💸 Gastos",  est:totGasEst,real:totGasReal,tipo:"gas",bg:"#451111",cr:"#DC2626"},
                  ...(hayFuera&&fueraGas.some(v=>Math.abs(v)>=0.5)?[{label:"↳ fuera de previsión",est:MESES.map(()=>0),real:fueraGas,tipo:"gas",bg:"#232831",cr:"#9AA1AC",sub:true}]:[]),
                  {label:"📈 Margen",  est:totIngEst.map((v,i)=>v-totGasEst[i]),real:totIngReal.map((v,i)=>v-totGasReal[i]),tipo:"ing",bg:"#232831",cr:"#D5D9E0"},
                ].map(row=>{
                  const tE=prevSum(row.est,row.real), tR=row.real.reduce((a,b)=>a+b,0), tD=tR-tE;
                  if(row.sub) return(
                    <tr key={row.label+row.tipo} style={{background:row.bg}} title="Facturas, hojas y otros gastos sin proyecto o de proyectos que no están en esta previsión. Ya están sumados en la fila de arriba.">
                      <td style={{padding:"3px 10px 3px 18px",fontWeight:600,fontSize:9,color:row.cr,borderRight:"2px solid #1F477A",fontStyle:"italic",whiteSpace:"nowrap"}}>{row.label}</td>
                      {row.real.map((r,mi)=>(
                        <Fragment key={mi}>
                          <td></td>
                          <td style={{padding:"3px 3px",textAlign:"right",fontSize:9,color:row.cr,fontStyle:"italic"}}>{Math.abs(r)>=0.5?r.toFixed(0):""}</td>
                          <td style={{borderRight:"1px solid #2E343E"}}></td>
                        </Fragment>
                      ))}
                      <td style={{background:"#112845"}}></td>
                      <td style={{padding:"3px 3px",textAlign:"right",fontSize:9,color:row.cr,fontStyle:"italic",background:"#112845"}}>{tR.toFixed(0)}</td>
                      <td style={{background:"#112845"}}></td>
                    </tr>
                  );
                  return(
                    <tr key={row.label} style={{background:row.bg,borderTop:"1px solid #2E343E"}}>
                      <td style={{padding:"5px 10px",fontWeight:800,fontSize:10,color:row.cr,borderRight:"2px solid #1F477A"}}>{row.label}</td>
                      {row.est.map((e,mi)=>{
                        const r=row.real[mi], d=r-e;
                        return(
                          <Fragment key={mi}>
                            <td style={{padding:"4px 3px",textAlign:"right",fontWeight:600,color:"#C3C8D0",fontSize:10}}>{e!==0?e.toFixed(0):"—"}</td>
                            <td style={{padding:"4px 3px",textAlign:"right",fontWeight:r!==0?700:400,color:row.cr,fontSize:10}}>{r!==0?r.toFixed(0):"—"}</td>
                            <td style={{padding:"4px 4px",textAlign:"right",fontWeight:700,fontSize:10,borderRight:"1px solid #2E343E",color:e===0&&r===0?"#4A515D":dc(d,row.tipo)}}>
                              {e===0&&r===0?"—":(d>=0?"+":"")+d.toFixed(0)}
                            </td>
                          </Fragment>
                        );
                      })}
                      <Fragment>
                        <td style={{padding:"4px 3px",textAlign:"right",fontWeight:800,color:"#C3C8D0",background:"#112845",fontSize:10}}>{tE.toFixed(0)}</td>
                        <td style={{padding:"4px 3px",textAlign:"right",fontWeight:800,color:row.cr,background:"#112845",fontSize:10}}>{tR!==0?tR.toFixed(0):"—"}</td>
                        <td style={{padding:"4px 6px",textAlign:"right",fontWeight:800,background:"#112845",fontSize:10,color:dc(tD,row.tipo)}}>{(tD>=0?"+":"")+tD.toFixed(0)}</td>
                      </Fragment>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── BANCO — EXTRACTOS Y CONCILIACIÓN ──────────────────────────────────────────
function bancoParseFecha(v){
  if(v===undefined||v===null||v==="") return "";
  let d;
  if(v instanceof Date) d=v;
  else if(typeof v==="number") d=new Date(Math.round((v-25569)*86400*1000));
  else {
    const str=String(v).trim();
    const m=str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if(m){ const y=m[3].length===2?2000+parseInt(m[3]):parseInt(m[3]); d=new Date(y,parseInt(m[2])-1,parseInt(m[1])); }
    else d=new Date(str);
  }
  if(!d||isNaN(d)||d.getFullYear()<1990) return "";
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}
function bancoParseNum(v){
  if(typeof v==="number") return v;
  let s=String(v??"").replace(/[€\s]/g,"").trim();
  if(!s) return NaN;
  if(s.includes(",")&&s.includes(".")) s=s.lastIndexOf(",")>s.lastIndexOf(".")?s.replace(/\./g,"").replace(",","."):s.replace(/,/g,"");
  else if(s.includes(",")) s=s.replace(",",".");
  return parseFloat(s);
}
function bancoTs(f){ const p=(f||"").split("/"); return p.length===3?new Date(+p[2],+p[1]-1,+p[0]).getTime():0; }
// Importe con el que la factura/hoja aparece en el banco (+ entra, − sale)
function importeBanco(item){
  if(item.kind==="hoja") return -(parseFloat(item.r.importe)||0);
  const t=parseFloat(item.r.total)||0;
  const signed=isFRCNeg(item.r)?-t:t;
  return item.kind==="ing"?signed:-signed;
}
function itemLabel(item){
  // Hoja de gasto: persona · proyecto(s) · fecha (antes salía el link de Drive)
  if(item.kind==="hoja"){
    const proys=hojaPorProyecto(item.r).map(x=>x.proyecto).filter(Boolean);
    return `HG · ${item.r.responsable||"Sin responsable"} · ${proys.length?proys.join(" + "):"Sin proyecto"} · ${item.r.fecha||"sin fecha"}`;
  }
  return `${item.r.ref||"s/ref"} · ${item.r.descripcion||""}${item.r._rectPor?` (neto tras ${item.r._rectPor.join(", ")})`:""}`;
}

// Los movimientos se guardan como JSON versionado en Storage (banco/mov_<ts>.json)
// Las escrituras van en cola y las lecturas esperan a que terminen (si no, al cambiar de apartado
// justo después de editar se podía leer la versión anterior y pisar el cambio)
let _bancoCola=Promise.resolve();
async function bancoLoad(){
  await _bancoCola;
  const {data,error}=await sb.storage.from("hoja_gasto").list("banco",{limit:100,sortBy:{column:"name",order:"desc"}});
  if(error) throw error;
  const last=(data||[]).filter(f=>/^mov_\d+\.json$/.test(f.name)).sort((a,b)=>b.name.localeCompare(a.name))[0];
  if(!last) return [];
  const {data:blob,error:e2}=await sb.storage.from("hoja_gasto").download(`banco/${last.name}`);
  if(e2) throw e2;
  return JSON.parse(await blob.text());
}
function bancoSave(movs){
  const p=_bancoCola.then(()=>_bancoSaveAhora(movs));
  _bancoCola=p.catch(()=>{});
  return p;
}
async function _bancoSaveAhora(movs){
  const name=`mov_${Date.now()}.json`;
  const {error}=await sb.storage.from("hoja_gasto").upload(`banco/${name}`,new Blob([JSON.stringify(movs)],{type:"application/json"}));
  if(error) throw error;
  const {data}=await sb.storage.from("hoja_gasto").list("banco",{limit:100});
  const old=(data||[]).filter(f=>/^mov_\d+\.json$/.test(f.name)&&f.name!==name).sort((a,b)=>b.name.localeCompare(a.name)).slice(4);
  if(old.length) await sb.storage.from("hoja_gasto").remove(old.map(f=>`banco/${f.name}`));
}

// Mapas JSON versionados en Storage junto al banco (banco/<prefijo>_<ts>.json)
async function jsonLoad(prefijo){
  await _bancoCola;
  const {data,error}=await sb.storage.from("hoja_gasto").list("banco",{limit:100,sortBy:{column:"name",order:"desc"}});
  if(error) throw error;
  const re=new RegExp(`^${prefijo}_\\d+\\.json$`);
  const last=(data||[]).filter(f=>re.test(f.name)).sort((a,b)=>b.name.localeCompare(a.name))[0];
  if(!last) return {};
  const {data:blob,error:e2}=await sb.storage.from("hoja_gasto").download(`banco/${last.name}`);
  if(e2) throw e2;
  return JSON.parse(await blob.text())||{};
}
function jsonSave(prefijo,map){
  const p=_bancoCola.then(async()=>{
    const name=`${prefijo}_${Date.now()}.json`;
    const {error}=await sb.storage.from("hoja_gasto").upload(`banco/${name}`,new Blob([JSON.stringify(map)],{type:"application/json"}));
    if(error) throw error;
    const re=new RegExp(`^${prefijo}_\\d+\\.json$`);
    const {data}=await sb.storage.from("hoja_gasto").list("banco",{limit:100});
    const old=(data||[]).filter(f=>re.test(f.name)&&f.name!==name).sort((a,b)=>b.name.localeCompare(a.name)).slice(4);
    if(old.length) await sb.storage.from("hoja_gasto").remove(old.map(f=>`banco/${f.name}`));
  });
  _bancoCola=p.catch(()=>{});
  return p;
}
// ── RECTIFICATIVAS ── {idFRC: idFacturaQueRectifica}
const rectLoad=()=>jsonLoad("rect");
const rectSave=map=>jsonSave("rect",map);
// ── SALDADAS A MANO ── {"ing:id"|"gas:id"|"hoja:id": {nota, fecha}} — cobradas/pagadas fuera del banco o ya saldadas
const saldadasLoad=()=>jsonLoad("saldadas");
const saldadasSave=map=>jsonSave("saldadas",map);
const totalFirmado=r=>{ const t=parseFloat(r.total)||0; return isFRCNeg(r)?-t:t; };
// Todo lo que puede ir al banco, teniendo en cuenta las rectificativas:
// - una FRC enlazada a su factura no pasa por el banco (se "anula" contra ella)
// - la factura rectificada se espera en el banco por lo que queda (total + FRC); si queda 0, también está anulada
function conciliables(ing,gas,hojas,rect,saldadas){
  const R=rect||{};
  const anuladas=new Set(), ajuste={}, rectPor={}, rectA={};
  const manuales=new Set(Object.keys(saldadas||{}));
  [["ing",ing||[]],["gas",gas||[]]].forEach(([kind,lista])=>{
    const byId=Object.fromEntries(lista.map(r=>[String(r.id),r]));
    lista.forEach(r=>{
      const orig=R[String(r.id)]&&byId[String(R[String(r.id)])];
      if(!orig||!(r.ref||"").startsWith("FRC")||String(orig.id)===String(r.id)) return;
      const fk=`${kind}:${r.id}`, ok_=`${kind}:${orig.id}`;
      anuladas.add(fk); rectA[fk]=orig.ref||"s/ref";
      ajuste[ok_]=(ajuste[ok_]??totalFirmado(orig))+totalFirmado(r);
      (rectPor[ok_]=rectPor[ok_]||[]).push(r.ref||"FRC");
    });
  });
  Object.entries(ajuste).forEach(([k,net])=>{ if(Math.abs(net)<0.02) anuladas.add(k); });
  const items=[
    ...(ing||[]).map(r=>({kind:"ing",key:`ing:${r.id}`,r})),
    ...(gas||[]).map(r=>({kind:"gas",key:`gas:${r.id}`,r})),
    ...(hojas||[]).map(r=>({kind:"hoja",key:`hoja:${r.id}`,r})),
  ].map(i=>ajuste[i.key]!==undefined&&!anuladas.has(i.key)
    ?{...i,r:{...i.r,total:String(Math.round(ajuste[i.key]*100)/100),_rectPor:rectPor[i.key],_totalOriginal:i.r.total}}:i);
  return {items,itemByKey:Object.fromEntries(items.map(i=>[i.key,i])),anuladas,rectPor,rectA,manuales};
}

// Un movimiento puede ir con varias facturas/hojas (m.matches) o marcarse como "otros gastos" (m.otro + nota).
// Compatibilidad con el formato antiguo (m.match = clave única o "otro").
// ── Ayudas para cuadrar el banco ──
// Referencia canónica de una factura: "FR2026/13" → "FR|2026|13" (acepta "FRC02026/3")
function refCanon(ref){
  const m=String(ref||"").toUpperCase().replace(/\s+/g,"").match(/^([A-Z]+?)0?(\d{4})\/(\d+)$/);
  return m?`${m[1]}|${m[2]}|${parseInt(m[3])}`:null;
}
// Referencias escritas en el concepto del banco: "FRP2026/1", "FR20/2026", rangos "FR12/2026 - FR17/2026"
function refsEnConcepto(txt){
  const t=String(txt||"").toUpperCase();
  const re=/([A-Z]{2,3})\s?0?(\d{1,4})\/(\d{1,4})/g;
  const found=[], out=new Set(); let m;
  while((m=re.exec(t))){
    const [,ty,a,b]=m; let year,num;
    if(a.length===4){ year=a; num=parseInt(b); } else if(b.length===4){ year=b; num=parseInt(a); } else continue;
    found.push({ty,year,num,ini:m.index,fin:re.lastIndex}); out.add(`${ty}|${year}|${num}`);
  }
  for(let i=0;i<found.length-1;i++){
    const x=found[i], y=found[i+1];
    if(x.ty===y.ty&&x.year===y.year&&y.num>x.num&&y.num-x.num<=40&&/^\s*(-|–|A|AL|Y)\s*$/.test(t.slice(x.fin,y.ini)))
      for(let n=x.num;n<=y.num;n++) out.add(`${x.ty}|${x.year}|${n}`);
  }
  return out;
}
// Personas nombradas en el concepto ("HG ana octubre" → Ana)
function nombresEnConcepto(txt){
  const norm=x=>String(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const t=` ${norm(txt).replace(/[^a-z0-9]+/g," ")} `;
  return [...INIT_MEMBERS,...EXTERNAL_MEMBERS].map(m=>m.name).filter(n=>t.includes(` ${norm(n)} `));
}
// Combinación de hasta maxN apuntes (mismo signo) que sume exactamente el objetivo. Devuelve índices o null
function buscarCombinacion(objetivo, valores, maxN=5, limite=400000){
  const obj=Math.round(Math.abs(objetivo)*100);
  const vals=valores.map((v,i)=>({i,c:Math.round(Math.abs(v)*100)})).filter(x=>x.c>0&&x.c<=obj+2).sort((a,b)=>b.c-a.c);
  let pasos=0, res=null;
  const suf=[]; for(let k=vals.length-1,acc=0;k>=0;k--){ acc+=vals[k].c; suf[k]=acc; }
  (function dfs(start,rest,sel){
    if(res||pasos++>limite) return;
    if(Math.abs(rest)<=2&&sel.length){ res=[...sel]; return; }
    if(sel.length>=maxN) return;
    for(let k=start;k<vals.length;k++){
      if(suf[k]<rest-2) return;
      if(vals[k].c>rest+2) continue;
      sel.push(vals[k].i); dfs(k+1,rest-vals[k].c,sel); sel.pop();
      if(res) return;
    }
  })(0,obj,[]);
  return res;
}

function movKeys(m){ return Array.isArray(m.matches)?m.matches:(m.match&&m.match!=="otro"?[m.match]:[]); }
// Movimiento apartado a la espera de que llegue su factura (sin facturas asociadas todavía)
function movEspera(m){ return !!m.espera&&!movOtro(m)&&!movKeys(m).length; }
function movOtro(m){ return !!m.otro||m.match==="otro"; }
// Estado de conciliación: solo cuenta como conciliado si la suma de lo asociado cuadra con el banco
function bancoEstado(m,itemByKey){
  if(movOtro(m)) return {otro:true,items:[],suma:0,falta:0,ok:!!(m.nota||"").trim()};
  const keys=movKeys(m);
  const its=keys.map(k=>itemByKey[k]).filter(Boolean);
  const just=m.just&&typeof m.just.importe==="number"?m.just:null;
  const suma=Math.round((its.reduce((s,i)=>s+importeBanco(i),0)+(just?just.importe:0))*100)/100;
  const falta=Math.round((m.importe-suma)*100)/100;
  const justOk=!just||!!(just.nota||"").trim();
  return {otro:false,items:its,just,suma,falta,ok:(its.length>0||!!just)&&its.length===keys.length&&Math.abs(falta)<0.02&&justOk};
}

// Cobrada / pagada = conciliada en 🏦 Banco. No se marca a mano.
// info.conc = claves conciliadas ("ing:id", "gas:id", "hoja:id"); info.desde = fecha del primer movimiento importado
function conciliacionInfo(banco, ing, gas, hojas, rect, saldadas){
  if(!banco) return null;
  const {itemByKey,anuladas,rectPor,rectA}=conciliables(ing,gas,hojas,rect,saldadas);
  const conc=new Set(banco.filter(m=>bancoEstado(m,itemByKey).ok).flatMap(movKeys));
  const ts=banco.map(m=>bancoTs(m.fecha)).filter(Boolean);
  return {conc, desde:ts.length?Math.min(...ts):null, anuladas, rectPor, rectA, saldadas:saldadas||{}};
}
// "si" = conciliada · "no" = dentro del periodo del extracto y sin conciliar · "fuera" = anterior al extracto
function estadoPago(info, key, fecha, pagado){
  if(!info) return pagado?"si":"no";
  if(info.anuladas?.has(key)) return "anulada";
  if(info.conc.has(key)) return "si";
  if(info.saldadas?.[key]) return "manual";
  if(info.desde&&bancoTs(fecha)>=info.desde) return "no";
  return pagado?"si":"fuera";
}
// Fondo de la fila según el estado: verde saldada, amarillo pendiente
function fondoEstado(estado,i){
  if(estado==="si"||estado==="manual") return "#11452D";
  if(estado==="anulada") return "#1A1145";
  if(estado==="no") return "#453B11";
  return i%2===0?"#232831":"#1F232B";
}
function EstadoPagoBadge({estado, ingreso, nota, onClick}){
  const cfg={
    manual:{t:ingreso?"✅ Cobrada":"✅ Pagada", bg:"#11452B", c:"#047857", b:"#6EE7B7", tip:`Marcada a mano (sin movimiento del banco)${nota?": "+nota:""}`},
    si:   {t:ingreso?"✅ Cobrada":"✅ Pagada",       bg:"#11452B", c:"#047857", b:"#6EE7B7", tip:"Conciliada en 🏦 Banco"},
    no:   {t:ingreso?"⏳ No cobrada":"⏳ No pagada", bg:"#453B11", c:"#B45309", b:"#FCD34D", tip:"Se marcará sola cuando se concilie en 🏦 Banco"},
    fuera:{t:"— antes del extracto",                   bg:"#262B34", c:"#969CA6", b:"#2E343E", tip:"Es anterior al primer movimiento del banco importado"},
    anulada:{t:"↩️ Rectificada",                       bg:"#1A1145", c:"#6D28D9", b:"#1A1145", tip:"Anulada con una rectificativa: no pasa por el banco"},
  }[estado];
  const puede=onClick&&(estado==="no"||estado==="manual"||estado==="fuera");
  return <span title={cfg.tip+(puede?(estado==="manual"?" · clic para quitar la marca":" · clic para marcarla como saldada a mano"):"")} onClick={puede?onClick:undefined}
    style={{background:cfg.bg,color:cfg.c,border:`1px solid ${cfg.b}`,borderRadius:99,padding:"2px 9px",fontSize:10,fontWeight:700,whiteSpace:"nowrap",cursor:puede?"pointer":"default"}}>{cfg.t}</span>;
}

// Cierra los movimientos pendientes: la diferencia se justifica como otro ingreso/gasto
// (o el movimiento entero si no tiene facturas); quita facturas asociadas que ya no existen
function planCuadre(movs,itemByKey){
  const hoyTxt=new Date().toLocaleDateString("es-ES");
  const eurP=v=>`${v.toLocaleString("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2})}€`;
  const plan=movs.filter(m=>!bancoEstado(m,itemByKey).ok&&!movEspera(m)).map(m=>{
    const keys=movKeys(m).filter(k=>itemByKey[k]);
    const base={...m,matches:keys,match:undefined,auto:false};
    if(movOtro(m)) return {m,nuevo:{...base,matches:[],otro:true,nota:(m.nota||"").trim()||`Sin factura (cuadre ${hoyTxt})`},txt:`${m.fecha} · ${m.concepto} · ${eurP(m.importe)} → motivo "Sin factura"`};
    const est=bancoEstado(base,itemByKey);
    if(!keys.length&&!est.just) return {m,nuevo:{...base,otro:true,matches:[],nota:`Sin factura (cuadre ${hoyTxt})`},txt:`${m.fecha} · ${m.concepto} · ${eurP(m.importe)} → entero como ${m.importe<0?"otro gasto":"otro ingreso"}`};
    const imp=Math.round(((est.just?.importe||0)+est.falta)*100)/100;
    const nuevo=Math.abs(imp)<0.02?(({just,...r})=>r)(base):{...base,just:{...(est.just||{}),importe:imp,nota:(est.just?.nota||"").trim()||`Diferencia sin factura (cuadre ${hoyTxt})`}};
    return {m,nuevo,txt:`${m.fecha} · ${m.concepto} · diferencia ${eurP(imp)} → ${imp<0?"otro gasto":"otro ingreso"}`};
  });
  const porId=Object.fromEntries(plan.map(p=>[p.m.id,p.nuevo]));
  return {plan,next:movs.map(m=>porId[m.id]||m)};
}

function BancoTab({ing,setIng,gas,setGas,hojas,onPendientes,onMovs,irOtros,rect,saldadas}){
  const [leyendoPdf,setLeyendoPdf]=useState(false);
  const [unlocked,setUnlocked]=useState(false);
  const [showLock,setShowLock]=useState(false);
  const [pendingAction,setPendingAction]=useState(null);
  const [filtro,setFiltro]=useState("pendientes");
  const [busca,setBusca]=useState("");

  const [movs,setMovs]=useState([]);
  const [cargando,setCargando]=useState(true);
  useEffect(()=>{ bancoLoad().then(m=>{ setMovs(m); onMovs&&onMovs(m); }).catch(err=>console.error("❌ banco load",err)).finally(()=>setCargando(false)); },[]);
  useEffect(()=>{ if(!cargando) onPendientes&&onPendientes(movs.filter(m=>!asociado(m)&&!movEspera(m)).length); },[movs,cargando,ing,gas,hojas]);
  function saveMovs(next){
    setMovs(next);
    onMovs&&onMovs(next);
    bancoSave(next).catch(err=>{ console.error("❌ banco save",err); alert("Error guardando los movimientos: "+err.message); });
  }

  function requireUnlock(action){
    if(unlocked){ action(); return; }
    setPendingAction(()=>action); setShowLock(true);
  }
  function onUnlock(){ setUnlocked(true); setShowLock(false); if(pendingAction){ pendingAction(); setPendingAction(null); } }

  // Todo lo que puede casar con un movimiento (las rectificativas enlazadas no pasan por el banco)
  const {items,itemByKey,anuladas,manuales}=conciliables(ing,gas,hojas,rect,saldadas);
  // Solo se proponen facturas/hojas desde septiembre 2025 (se cuadra 2026)
  const BANCO_DESDE=new Date(2025,8,1).getTime();
  // Solo se ofrece lo que está pendiente de verdad (amarillo): nada pagado/cobrado, rectificado ni ya conciliado
  const _ts=movs.map(m=>bancoTs(m.fecha)).filter(Boolean);
  const infoB={conc:new Set(movs.filter(m=>bancoEstado(m,itemByKey).ok).flatMap(movKeys)),desde:_ts.length?Math.min(..._ts):null,anuladas,saldadas:saldadas||{}};
  const pendienteB=i=>{ const e=estadoPago(infoB,i.key,i.r.fecha,i.r.pagado); return e==="no"||e==="fuera"; };
  const elegibles=items.filter(i=>bancoTs(i.r.fecha)>=BANCO_DESDE&&pendienteB(i));
  // Facturas/hojas marcadas a mano como cobradas/pagadas (cuadre) que aún no tienen movimiento del banco: también se pueden elegir
  const yaSaldadas=items.filter(i=>manuales.has(i.key)&&!infoB.conc.has(i.key)&&!anuladas.has(i.key));
  // Si la factura asociada se ha borrado, el movimiento vuelve a estar pendiente
  function asociado(m){ return bancoEstado(m,itemByKey).ok; }
  const usados=new Set(movs.flatMap(movKeys));

  function autoConciliar(lista){
    const usa=new Set(lista.flatMap(movKeys));
    return lista.map(m=>{
      if(movOtro(m)||movKeys(m).length) return m;
      const t=bancoTs(m.fecha);
      const porFecha=(a,b)=>Math.abs(bancoTs(a.r.fecha)-t)-Math.abs(bancoTs(b.r.fecha)-t);
      // 0) Facturas cuyo número viene escrito en el concepto (FR12/2026 - FR17/2026…) y que suman el importe
      const refs=refsEnConcepto(m.concepto);
      if(refs.size){
        const porRef=elegibles.filter(i=>!usa.has(i.key)&&refs.has(refCanon(i.r.ref)));
        if(porRef.length&&Math.abs(porRef.reduce((s,i)=>s+importeBanco(i),0)-m.importe)<0.02){ porRef.forEach(i=>usa.add(i.key)); return {...m,matches:porRef.map(i=>i.key),match:undefined,auto:true}; }
      }
      // 1) Una factura con el importe exacto
      const exactas=elegibles.filter(i=>!usa.has(i.key)&&Math.abs(importeBanco(i)-m.importe)<0.02).sort(porFecha);
      if(exactas.length){ usa.add(exactas[0].key); return {...m,matches:[exactas[0].key],match:undefined,auto:true}; }
      // 2) Hojas de la persona que sale en el concepto que sumen el importe
      const nombres=nombresEnConcepto(m.concepto);
      if(nombres.length){
        const hp=elegibles.filter(i=>i.kind==="hoja"&&!usa.has(i.key)&&nombres.includes(i.r.responsable)&&Math.sign(importeBanco(i))===Math.sign(m.importe));
        const comb=buscarCombinacion(m.importe,hp.map(importeBanco),6);
        if(comb){ comb.forEach(x=>usa.add(hp[x].key)); return {...m,matches:comb.map(x=>hp[x].key),match:undefined,auto:true}; }
      }
      // 3) Varias facturas/hojas (hasta 4) de antes del pago que sumen el importe
      const cands=elegibles.filter(i=>!usa.has(i.key)&&Math.sign(importeBanco(i))===Math.sign(m.importe)
        &&Math.abs(importeBanco(i))<Math.abs(m.importe)&&bancoTs(i.r.fecha)<=t+7*864e5&&bancoTs(i.r.fecha)>=t-120*864e5).sort(porFecha).slice(0,25);
      const comb=buscarCombinacion(m.importe,cands.map(importeBanco),4,60000);
      if(comb){ comb.forEach(x=>usa.add(cands[x].key)); return {...m,matches:comb.map(x=>cands[x].key),match:undefined,auto:true}; }
      // 4) Una factura/hoja ya marcada a mano como cobrada/pagada con el importe exacto (la del número del concepto primero)
      const nums=[...String(m.concepto||"").matchAll(/(\d{1,4})\s*\/\s*(\d{1,4})/g)].flatMap(x=>[`${x[1]}/${parseInt(x[2])}`,`${x[2]}/${parseInt(x[1])}`]);
      const numRef=r=>{ const x=String(r.ref||"").match(/(\d{4})\/(\d+)$/); return x?`${x[1]}/${parseInt(x[2])}`:null; };
      const yaM=yaSaldadas.filter(i=>!usa.has(i.key)&&Math.abs(importeBanco(i)-m.importe)<0.02&&bancoTs(i.r.fecha)<=t+5*864e5)
        .sort((a,b)=>(nums.includes(numRef(b.r))-nums.includes(numRef(a.r)))||porFecha(a,b));
      if(yaM.length){ usa.add(yaM[0].key); return {...m,matches:[yaM[0].key],match:undefined,auto:true}; }
      return m;
    });
  }
  function marcarPagados(lista){
    const ids=new Set(lista.filter(m=>bancoEstado(m,itemByKey).ok).flatMap(movKeys).filter(k=>k.startsWith("gas:")).map(k=>k.slice(4)));
    if((gas||[]).some(r=>ids.has(String(r.id))&&!r.pagado))
      setGas(g=>g.map(r=>ids.has(String(r.id))&&!r.pagado?{...r,pagado:true}:r));
    // Las facturas de ingreso conciliadas con una entrada del banco quedan como cobradas
    const idsIng=new Set(lista.filter(m=>bancoEstado(m,itemByKey).ok).flatMap(movKeys).filter(k=>k.startsWith("ing:")).map(k=>k.slice(4)));
    if(setIng&&(ing||[]).some(r=>idsIng.has(String(r.id))&&!r.pagado))
      setIng(f=>f.map(r=>idsIng.has(String(r.id))&&!r.pagado?{...r,pagado:true}:r));
  }

  function importar(e){
    const file=e.target.files?.[0]; e.target.value="";
    if(!file) return;
    if(file.type==="application/pdf"||/\.pdf$/i.test(file.name)){ requireUnlock(()=>importarPdf(file)); return; }
    requireUnlock(()=>{
      const reader=new FileReader();
      reader.onload=async evt=>{
        try{
          const {read,utils}=await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
          const wb=read(new Uint8Array(evt.target.result),{type:"array",cellDates:true});
          const rows=utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:""});
          const norm=x=>String(x).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").trim();
          const hIdx=rows.findIndex(r=>{ const h=r.map(norm); return h.some(x=>x.includes("fecha"))&&h.some(x=>/importe|cargo|abono|debe|haber|cantidad/.test(x)); });
          if(hIdx<0){ alert("No encuentro la cabecera del extracto (necesito columnas de Fecha e Importe o Cargo/Abono)."); return; }
          const h=rows[hIdx].map(norm);
          const find=(...keys)=>h.findIndex(x=>keys.some(k=>x.includes(k)));
          const cFecha=(()=>{ const i=h.findIndex(x=>x.includes("fecha")&&(x.includes("oper")||x.includes("contable"))); return i>=0?i:find("fecha"); })();
          const cConc=find("concepto","descripcion","detalle","movimiento","observ");
          const cImp=find("importe","cantidad");
          const cCargo=find("cargo","debe");
          const cAbono=find("abono","haber");
          const cSaldo=find("saldo");
          const nuevos=[];
          for(const r of rows.slice(hIdx+1)){
            const fecha=bancoParseFecha(r[cFecha]);
            if(!fecha) continue;
            let imp=cImp>=0?bancoParseNum(r[cImp]):NaN;
            if(isNaN(imp)){
              const ab=bancoParseNum(r[cAbono]), ca=bancoParseNum(r[cCargo]);
              imp=(isNaN(ab)?0:Math.abs(ab))-(isNaN(ca)?0:Math.abs(ca));
            }
            if(!imp) continue;
            const concepto=cConc>=0?String(r[cConc]).trim():"";
            const saldo=cSaldo>=0?bancoParseNum(r[cSaldo]):NaN;
            const id=`${fecha}|${imp.toFixed(2)}|${concepto}|${isNaN(saldo)?"":saldo.toFixed(2)}`;
            nuevos.push({id,fecha,concepto,importe:Math.round(imp*100)/100,saldo:isNaN(saldo)?null:saldo,match:null});
          }
          añadirMovimientos(nuevos);
        }catch(err){ console.error(err); alert("Error leyendo el extracto: "+err.message); }
      };
      reader.readAsArrayBuffer(file);
    });
  }
  function añadirMovimientos(nuevos){
    const existentes=new Set(movs.map(m=>m.id));
    const añadir=nuevos.filter(m=>!existentes.has(m.id));
    const next=autoConciliar([...movs,...añadir]).sort((a,b)=>bancoTs(a.fecha)-bancoTs(b.fecha));
    saveMovs(next); marcarPagados(next);
    const auto=next.filter(m=>m.auto&&!movs.find(o=>o.id===m.id&&movKeys(o).length)).length;
    alert(`✅ ${añadir.length} movimientos importados${nuevos.length-añadir.length>0?` (${nuevos.length-añadir.length} ya estaban)`:""}. ${auto} conciliados automáticamente.`);
  }
  async function importarPdf(file){
    setLeyendoPdf(true);
    try{
      const b64=await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(file); });
      const resp=await fetch("/api/extracto",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({b64})});
      const data=await resp.json();
      if(!resp.ok) throw new Error(data.error||`HTTP ${resp.status}`);
      const nuevos=[];
      for(const x of data.movimientos||[]){
        const fecha=bancoParseFecha(x.fecha);
        const imp=bancoParseNum(x.importe);
        if(!fecha||isNaN(imp)||!imp) continue;
        const concepto=String(x.concepto||"").trim();
        const saldo=x.saldo===null||x.saldo===undefined||x.saldo===""?NaN:bancoParseNum(x.saldo);
        const id=`${fecha}|${imp.toFixed(2)}|${concepto}|${isNaN(saldo)?"":saldo.toFixed(2)}`;
        nuevos.push({id,fecha,concepto,importe:Math.round(imp*100)/100,saldo:isNaN(saldo)?null:saldo,match:null});
      }
      if(!nuevos.length){ alert("No he encontrado movimientos en el PDF."); return; }
      añadirMovimientos(nuevos);
    }catch(err){ console.error(err); alert("Error leyendo el PDF del extracto: "+err.message); }
    finally{ setLeyendoPdf(false); }
  }
  function updMov(id,fn){
    requireUnlock(()=>{
      const next=movs.map(m=>m.id===id?{...fn(m),match:undefined,auto:false}:m);
      saveMovs(next); marcarPagados(next);
    });
  }
  function addKey(id,key){
    if(key==="otro") return updMov(id,m=>{ const {espera,...r}=m; return {...r,matches:[],otro:true}; });
    if(key==="espera") return updMov(id,m=>({...m,espera:{nota:(m.espera?.nota)||""}}));
    if(key.startsWith("just:")) return justificarResto(id,parseFloat(key.slice(5)));
    updMov(id,m=>{ const {espera,...r}=m; return {...r,otro:false,matches:[...movKeys(m).filter(k=>k!==key),key]}; });
  }
  function addKeys(id,ks){ updMov(id,m=>({...m,otro:false,matches:[...new Set([...movKeys(m),...ks])]})); }
  // Busca qué facturas/hojas (hasta 5) suman exactamente lo que falta del movimiento
  function buscarQueCuadre(m){
    const est=bancoEstado(m,itemByKey);
    const t=bancoTs(m.fecha);
    const porFecha=(a,b)=>Math.abs(bancoTs(a.r.fecha)-t)-Math.abs(bancoTs(b.r.fecha)-t);
    const nombres=nombresEnConcepto(m.concepto);
    const cands=elegibles.filter(x=>!usados.has(x.key)&&Math.sign(importeBanco(x))===Math.sign(est.falta)&&Math.abs(importeBanco(x))<=Math.abs(est.falta)+0.02
      &&bancoTs(x.r.fecha)<=t+15*864e5&&bancoTs(x.r.fecha)>=t-240*864e5)
      .sort((a,b)=>{ const pa=nombres.includes(a.r.responsable)?0:1, pb=nombres.includes(b.r.responsable)?0:1; return pa-pb||porFecha(a,b); }).slice(0,40);
    let comb=buscarCombinacion(est.falta,cands.map(importeBanco),5);
    if(!comb){
      // Si no, entre las ya marcadas a mano como cobradas/pagadas
      const c2=yaSaldadas.filter(x=>!usados.has(x.key)&&Math.sign(importeBanco(x))===Math.sign(est.falta)&&Math.abs(importeBanco(x))<=Math.abs(est.falta)+0.02&&bancoTs(x.r.fecha)<=t+15*864e5)
        .sort(porFecha).slice(0,40);
      const comb2=buscarCombinacion(est.falta,c2.map(importeBanco),5);
      if(comb2){ cands.splice(0,cands.length,...c2); comb=comb2; }
    }
    if(!comb){ alert(`No he encontrado ninguna combinación de hasta 5 facturas u hojas que sume ${eur(Math.abs(est.falta))}.\n\nO falta subir alguna factura/hoja, o la diferencia no tiene factura: elige "Justificar los ${eur(Math.abs(est.falta))} que faltan…" en el desplegable.`); return; }
    const sel=comb.map(x=>cands[x]);
    if(window.confirm(`Cuadra con:\n\n${sel.map(x=>`• ${itemLabel(x)} · ${eur(importeBanco(x))}`).join("\n")}\n\n¿Las asocio?`)) addKeys(m.id,sel.map(x=>x.key));
  }
  function removeKey(id,key){ updMov(id,m=>({...m,matches:movKeys(m).filter(k=>k!==key)})); }
  function quitarOtro(id){ updMov(id,m=>({...m,otro:false,nota:""})); }
  function setEspera(id,nota){ updMov(id,m=>({...m,espera:{nota}})); }
  function quitarEspera(id){ updMov(id,m=>{ const {espera,...r}=m; return r; }); }
  // Justificar sin factura lo que falta de un movimiento que ya tiene facturas
  function justificarResto(id,importe){ updMov(id,m=>({...m,just:{importe:Math.round(importe*100)/100,nota:""}})); }
  function setNotaJust(id,nota){ updMov(id,m=>({...m,just:{...(m.just||{}),nota}})); }
  function quitarJust(id){ updMov(id,m=>{ const {just,...rest}=m; return rest; }); }
  function setNota(id,nota){ updMov(id,m=>({...m,otro:true,nota})); }
  function borrarMov(id){ requireUnlock(()=>saveMovs(movs.filter(m=>m.id!==id))); }
  function vaciar(){ requireUnlock(()=>{ if(confirm("¿Borrar todos los movimientos importados? Las facturas no se tocan.")) saveMovs([]); }); }
  // Cierra los pendientes: la diferencia que queda se justifica como otro ingreso/gasto (o el movimiento entero si no tiene facturas)
  function cuadrarPendientes(){
    requireUnlock(()=>{
      const {plan,next}=planCuadre(movs,itemByKey);
      if(!plan.length){ alert("No queda nada por cuadrar ✅"); return; }
      if(!window.confirm(`Voy a cuadrar ${plan.length} movimiento${plan.length>1?"s":""}:\n\n${plan.map(p=>"• "+p.txt).join("\n")}\n\nLo que no tiene factura irá a la pestaña Otros gastos para que lo reviséis. ¿Sigo?`)) return;
      saveMovs(next); marcarPagados(next);
    });
  }
  function reAuto(){ requireUnlock(()=>{ const next=autoConciliar(movs); saveMovs(next); marcarPagados(next); }); }

  // Resumen
  const entradas=movs.filter(m=>m.importe>0).reduce((s,m)=>s+m.importe,0);
  const salidas=movs.filter(m=>m.importe<0).reduce((s,m)=>s+m.importe,0);
  const conc=movs.filter(asociado);
  const sinConc=movs.filter(m=>!asociado(m)&&!movEspera(m));
  const esperan=movs.filter(movEspera);
  const ultimo=[...movs].reverse().find(m=>m.saldo!==null&&m.saldo!==undefined);
  const primero=movs.find(m=>m.saldo!==null&&m.saldo!==undefined);
  const saldoIni=primero?primero.saldo-primero.importe:null;
  const cuadraSaldo=primero&&ultimo?Math.abs(saldoIni+entradas+salidas-ultimo.saldo)<0.05:null;
  const pct=movs.length?Math.round(conc.length/movs.length*100):0;
  // Facturas del periodo del extracto sin movimiento
  const tMin=movs.length?bancoTs(movs[0].fecha):0, tMax=movs.length?bancoTs(movs[movs.length-1].fecha):0;
  const sinBanco=elegibles.filter(i=>i.kind!=="hoja"&&!usados.has(i.key)&&!manuales.has(i.key)&&bancoTs(i.r.fecha)>=tMin-60*864e5&&bancoTs(i.r.fecha)<=tMax&&(parseFloat(i.r.total)||0)>0);
  const ingSinCobrar=sinBanco.filter(i=>i.kind==="ing");
  const gasSinPagar=sinBanco.filter(i=>i.kind==="gas");

  const q=busca.toLowerCase();
  const visibles=movs.filter(m=>filtro==="todos"||(filtro==="pendientes"?!asociado(m):asociado(m)))
    .filter(m=>!q||m.concepto.toLowerCase().includes(q)||String(m.importe).includes(q));

  const card=(label,val,color,bg,sub)=>(
    <div style={{background:bg,borderRadius:12,padding:"12px 14px",border:`1px solid ${color}33`}}>
      <div style={{fontSize:10,color:"#9AA1AC",fontWeight:600}}>{label}</div>
      <div style={{fontSize:20,fontWeight:800,color}}>{val}</div>
      {sub&&<div style={{fontSize:10,color:"#9AA1AC"}}>{sub}</div>}
    </div>
  );
  const eur=v=>`${v.toLocaleString("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2})}€`;
  const btn=(bg,color)=>({background:bg,color,border:"none",borderRadius:8,padding:"8px 14px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"});

  return(
    <div>
      {showLock&&<EditLockModal onUnlock={onUnlock} onClose={()=>setShowLock(false)}/>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:14}}>
        <div style={{fontSize:10,color:unlocked?"#059669":"#9AA1AC",cursor:unlocked?"default":"pointer"}} onClick={()=>!unlocked&&setShowLock(true)}>
          {unlocked?"🔓 Modo edición activo":"🔒 Modo lectura — haz clic para editar"}
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <label style={{...btn("#D5D9E0","#1F232B"),display:"inline-block",opacity:leyendoPdf?.6:1,pointerEvents:leyendoPdf?"none":"auto"}}>
            {leyendoPdf?"⏳ Leyendo PDF…":"⬆ Importar extracto (PDF/Excel/CSV)"}
            <input type="file" accept=".pdf,.xlsx,.xls,.csv" style={{display:"none"}} onChange={importar}/>
          </label>
          {movs.length>0&&<button onClick={reAuto} style={btn("#452311","#4F46E5")}>🔗 Conciliar automáticamente</button>}
          {sinConc.length>0&&<button onClick={cuadrarPendientes} title="Justifica como otro ingreso/gasto lo que no cuadra de los movimientos pendientes" style={btn("#452E11","#C2410C")}>🧹 Cuadrar lo que queda ({sinConc.length})</button>}
          {movs.length>0&&<button onClick={vaciar} style={btn("#262B34","#9AA1AC")}>Vaciar</button>}
        </div>
      </div>

      {cargando?<div style={{padding:30,textAlign:"center",color:"#7F8692",fontSize:12}}>Cargando movimientos…</div>:movs.length===0?(
        <div style={{textAlign:"center",padding:"40px 16px",color:"#9AA1AC",background:"#1F232B",borderRadius:12,border:"1px dashed #3A414D"}}>
          <div style={{fontSize:30,marginBottom:6}}>🏦</div>
          <div style={{fontSize:13,fontWeight:700,color:"#ECEEF2"}}>Sube el extracto del banco</div>
          <div style={{fontSize:11,marginTop:4}}>Descárgalo de la banca online en PDF, Excel o CSV.<br/>Cada movimiento se cruza con las facturas y hojas de gasto por importe y fecha. Todos tienen que quedar asociados.</div>
        </div>
      ):(<>
        {sinConc.length>0?(
          <div style={{background:"#451111",border:"1px solid #FCA5A5",color:"#EC8383",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:12,fontWeight:600}}>
            ⚠️ Faltan {sinConc.length} movimiento{sinConc.length>1?"s":""} por conciliar. Cada entrada tiene que ir con sus facturas de ingreso y cada salida con sus facturas u hojas de gasto, y la suma tiene que cuadrar con el importe del banco (o marcarse como "Otros gastos" con el motivo).
          </div>
        ):(
          <div style={{background:"#11452D",border:"1px solid #1F7A3F",color:"#047857",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:12,fontWeight:600}}>
            ✅ Todos los movimientos del banco están asociados.
          </div>
        )}
        {esperan.length>0&&(
          <div style={{background:"#453B11",border:"1px solid #7A681F",color:"#F3A97D",borderRadius:10,padding:"8px 14px",marginBottom:12,fontSize:11.5,fontWeight:600}}>
            ⏳ {esperan.length} movimiento{esperan.length>1?"s":""} esperando factura: {esperan.map(m=>`${m.concepto} (${eur(m.importe)})`).join(", ")}. Cuando subáis la factura, asociadla en el movimiento.
          </div>
        )}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8,marginBottom:14}}>
          {card("Movimientos",movs.length,"#D5D9E0","#232831",`${movs[0].fecha} → ${movs[movs.length-1].fecha}`)}
          {card("Entradas",eur(entradas),"#059669","#11452D")}
          {card("Salidas",eur(salidas),"#B91C1C","#451111")}
          {ultimo&&card("Saldo final",eur(ultimo.saldo),"#D5D9E0","#232831",cuadraSaldo===null?"":cuadraSaldo?"✅ Cuadra con los movimientos":"⚠️ No cuadra: faltan movimientos")}
          {card("Conciliado",`${pct}%`,pct===100?"#059669":"#D97706",pct===100?"#11452D":"#453B11",`${conc.length} de ${movs.length} · ${sinConc.length} pendientes${esperan.length?` · ${esperan.length} esperando factura`:""}`)}
        </div>

        <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
          {[["pendientes",`Sin conciliar (${sinConc.length}${esperan.length?` + ${esperan.length} ⏳`:""})`],["conciliados",`Conciliados (${conc.length})`],["todos","Todos"]].map(([id,l])=>(
            <button key={id} onClick={()=>setFiltro(id)} style={{background:filtro===id?"#323844":"#262B34",color:filtro===id?"#FFF":"#C3C8D0",border:"none",borderRadius:99,padding:"4px 12px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
          ))}
          <input value={busca} onChange={e=>setBusca(e.target.value)} placeholder="Buscar concepto o importe…" style={{marginLeft:"auto",border:"1px solid #2E343E",borderRadius:8,padding:"5px 10px",fontSize:11,fontFamily:"inherit",outline:"none",minWidth:0,flex:"0 1 220px"}}/>
        </div>

        <div style={{background:"#1F232B",borderRadius:12,border:"1px solid #2E343E",overflowX:"auto",marginBottom:16}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <THead cols={["Fecha","Concepto banco","Importe","Saldo","Conciliado con",""]} color="#D5D9E0"/>
            <tbody>
              {visibles.map((m,i)=>{
                const est=bancoEstado(m,itemByKey);
                const keys=movKeys(m);
                const perdidas=keys.filter(k=>!itemByKey[k]);
                const objetivo=est.falta; // lo que falta por cubrir
                const tm=bancoTs(m.fecha);
                const porFecha=(a,b)=>Math.abs(bancoTs(a.r.fecha)-tm)-Math.abs(bancoTs(b.r.fecha)-tm);
                const pool=elegibles.filter(x=>!usados.has(x.key)&&Math.sign(importeBanco(x))===Math.sign(m.importe));
                const exactas=pool.filter(x=>Math.abs(importeBanco(x)-objetivo)<0.02).sort(porFecha);
                const caben=pool.filter(x=>!exactas.includes(x)&&Math.abs(importeBanco(x))<Math.abs(objetivo)).sort(porFecha);
                const resto=pool.filter(x=>!exactas.includes(x)&&!caben.includes(x)).sort(porFecha);
                const marcadas=yaSaldadas.filter(x=>!usados.has(x.key)&&Math.sign(importeBanco(x))===Math.sign(m.importe))
                  .sort((a,b)=>((Math.abs(importeBanco(a)-objetivo)<0.02?0:1)-(Math.abs(importeBanco(b)-objetivo)<0.02?0:1))||porFecha(a,b)).slice(0,80);
                const opt=c=><option key={c.key} value={c.key}>{Math.abs(importeBanco(c)-objetivo)<0.02?"★ ":""}{itemLabel(c)} · {eur(importeBanco(c))}{c.kind!=="hoja"?` · ${c.r.fecha||"s/f"}`:""}{usados.has(c.key)?" · (ya en otro movimiento)":""}</option>;
                // Sugerencias: facturas con el número escrito en el concepto y hojas de la persona nombrada
                const refsM=refsEnConcepto(m.concepto);
                const porRef=refsM.size?items.filter(x=>!anuladas.has(x.key)&&!keys.includes(x.key)&&refsM.has(refCanon(x.r.ref))):[];
                const nombresM=nombresEnConcepto(m.concepto);
                const hojasPers=nombresM.length?elegibles.filter(x=>x.kind==="hoja"&&!usados.has(x.key)&&nombresM.includes(x.r.responsable)&&!porRef.includes(x)).sort(porFecha):[];
                const sumRef=porRef.reduce((s2,x)=>s2+importeBanco(x),0);
                const signoRaro=porRef.length>0&&Math.sign(sumRef)!==Math.sign(m.importe);
                return(
                  <tr key={m.id} style={{background:i%2?"#1F232B":"#232831",borderTop:"1px solid #2E343E",verticalAlign:"top"}}>
                    <td style={{padding:"6px 8px",whiteSpace:"nowrap"}}>{m.fecha}</td>
                    <td style={{padding:"6px 8px",maxWidth:280}}>{m.concepto||"—"}</td>
                    <td style={{padding:"6px 8px",fontWeight:700,whiteSpace:"nowrap",color:m.importe<0?"#EC8383":"#059669",textAlign:"right"}}>{m.importe>0?"+":""}{eur(m.importe)}</td>
                    <td style={{padding:"6px 8px",whiteSpace:"nowrap",color:"#9AA1AC",textAlign:"right"}}>{m.saldo!=null?eur(m.saldo):"—"}</td>
                    <td style={{padding:"6px 8px",minWidth:280}}>
                      {est.otro?(
                        <div style={{display:"flex",gap:4,alignItems:"center"}}>
                          <span onClick={irOtros} title="Ver en Otros gastos" style={{background:m.importe<0?"#452E11":"#11452D",color:m.importe<0?"#C2410C":"#047857",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700,whiteSpace:"nowrap",cursor:irOtros?"pointer":"default"}}>{m.importe<0?"Otros gastos":"Otros ingresos"}</span>
                          <input defaultValue={m.nota||""} placeholder="Motivo obligatorio (comisión, traspaso…)" onBlur={e=>e.target.value!==(m.nota||"")&&setNota(m.id,e.target.value)}
                            style={{border:`1px solid ${(m.nota||"").trim()?"#2E343E":"#FCA5A5"}`,background:(m.nota||"").trim()?"#1F232B":"#451111",borderRadius:5,padding:"3px 6px",fontSize:10,fontFamily:"inherit",flex:1,minWidth:0}}/>
                          <button onClick={()=>quitarOtro(m.id)} style={{background:"none",border:"none",color:"#7F8692",cursor:"pointer"}}>✕</button>
                        </div>
                      ):(
                        <div style={{display:"flex",flexDirection:"column",gap:4}}>
                          {movEspera(m)&&(
                            <div style={{display:"flex",gap:4,alignItems:"center"}}>
                              <span style={{background:"#453B11",color:"#F3A97D",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700,whiteSpace:"nowrap"}}>⏳ Esperando factura</span>
                              <input defaultValue={m.espera?.nota||""} placeholder="De quién / qué es (opcional)" onBlur={e=>e.target.value!==(m.espera?.nota||"")&&setEspera(m.id,e.target.value)}
                                style={{border:"1px solid #2E343E",background:"#1F232B",borderRadius:5,padding:"3px 6px",fontSize:10,fontFamily:"inherit",flex:1,minWidth:0}}/>
                              <button onClick={()=>quitarEspera(m.id)} style={{background:"none",border:"none",color:"#7F8692",cursor:"pointer"}} title="Quitar">✕</button>
                            </div>
                          )}
                          {est.items.map(it=>(
                            <div key={it.key} style={{display:"flex",gap:6,alignItems:"center"}}>
                              <span style={{background:est.ok?"#11452B":"#453B11",color:est.ok?"#047857":"#F3A97D",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700}}>
                                {est.ok?"✅":"🧩"} {itemLabel(it)} · {eur(importeBanco(it))}
                              </span>
                              {it.r.linkFactura&&<a href={it.r.linkFactura} target="_blank" rel="noreferrer" style={{fontSize:11,textDecoration:"none"}} title="Ver archivo">📄</a>}
                              <button onClick={()=>removeKey(m.id,it.key)} style={{background:"none",border:"none",color:"#7F8692",cursor:"pointer"}} title="Quitar">✕</button>
                            </div>
                          ))}
                          {est.just&&(
                            <div style={{display:"flex",gap:4,alignItems:"center"}}>
                              <span style={{background:est.just.importe<0?"#452E11":"#11452D",color:est.just.importe<0?"#C2410C":"#047857",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700,whiteSpace:"nowrap"}}>
                                {est.just.importe<0?"Otro gasto":"Otro ingreso"} · {eur(est.just.importe)}
                              </span>
                              <input defaultValue={est.just.nota||""} placeholder="Motivo obligatorio (premio, aportación, fianza…)" onBlur={e=>e.target.value!==(est.just.nota||"")&&setNotaJust(m.id,e.target.value)}
                                style={{border:`1px solid ${(est.just.nota||"").trim()?"#2E343E":"#FCA5A5"}`,background:(est.just.nota||"").trim()?"#1F232B":"#451111",borderRadius:5,padding:"3px 6px",fontSize:10,fontFamily:"inherit",flex:1,minWidth:0}}/>
                              <button onClick={()=>quitarJust(m.id)} style={{background:"none",border:"none",color:"#7F8692",cursor:"pointer"}} title="Quitar">✕</button>
                            </div>
                          )}
                          {perdidas.length>0&&(
                            <div style={{fontSize:10,color:"#EC8383",display:"flex",gap:6,alignItems:"center"}}>
                              ⚠️ {perdidas.length} factura{perdidas.length>1?"s":""} asociada{perdidas.length>1?"s":""} ya no existe{perdidas.length>1?"n":""}
                              <button onClick={()=>perdidas.forEach(k=>removeKey(m.id,k))} style={{background:"none",border:"none",color:"#EC8383",cursor:"pointer",textDecoration:"underline",fontSize:10,fontFamily:"inherit"}}>quitar</button>
                            </div>
                          )}
                          {(est.items.length>0||est.just)&&!est.ok&&Math.abs(est.falta)>=0.02&&(
                            <div style={{fontSize:10,fontWeight:700,color:"#B45309"}}>
                              Asociado {eur(est.suma)} de {eur(m.importe)} · {Math.sign(est.falta)===Math.sign(m.importe)?`falta ${eur(Math.abs(est.falta))}`:`sobra ${eur(Math.abs(est.falta))}`}
                            </div>
                          )}
                          {!est.ok&&(
                            <select value="" onChange={e=>e.target.value&&addKey(m.id,e.target.value)}
                              style={{width:"100%",border:"1px solid #7A651F",background:"#453B11",borderRadius:6,padding:"4px 6px",fontSize:11,fontFamily:"inherit",color:"#F3A97D",cursor:"pointer"}}>
                              <option value="">{keys.length?"+ Añadir otra factura…":"⚠️ Elegir factura…"}</option>
                              {porRef.length>0&&<optgroup label="📎 Mencionadas en el concepto">{porRef.map(opt)}</optgroup>}
                              {hojasPers.length>0&&<optgroup label={`🧾 Hojas de ${nombresM.join(", ")}`}>{hojasPers.map(opt)}</optgroup>}
                              {!keys.length&&!est.just&&!movEspera(m)&&<option value="espera">⏳ Esperando factura (aún no la tenemos)</option>}
                              {!keys.length&&!est.just&&<option value="otro">{m.importe<0?"— Otros gastos (comisión, impuesto, nómina, traspaso…)":"— Otros ingresos (subvención, aportación, traspaso…)"}</option>}
                              {keys.length>0&&!est.just&&Math.abs(est.falta)>=0.02&&Math.sign(est.falta)===Math.sign(m.importe)&&<option value={`just:${est.falta}`}>{est.falta<0?`— Justificar los ${eur(Math.abs(est.falta))} que faltan como otro gasto (sin factura)`:`— Justificar los ${eur(est.falta)} que faltan como otro ingreso (sin factura)`}</option>}
                              {exactas.length>0&&<optgroup label="★ Cuadran exacto">{exactas.map(opt)}</optgroup>}
                              {caben.length>0&&<optgroup label={`Menores que lo que falta (${eur(Math.abs(objetivo))}) — por fecha`}>{caben.map(opt)}</optgroup>}
                              {resto.length>0&&<optgroup label="Resto — por fecha">{resto.map(opt)}</optgroup>}
                              {marcadas.length>0&&<optgroup label={m.importe>0?"✅ Ya marcadas como cobradas a mano (sin cobro en el banco)":"✅ Ya marcadas como pagadas a mano (sin pago en el banco)"}>{marcadas.map(opt)}</optgroup>}
                            </select>
                          )}
                          {!est.ok&&(
                            <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                              {porRef.length>1&&(
                                <button onClick={()=>addKeys(m.id,porRef.map(x=>x.key))} style={{background:"#452311",color:"#948EE1",border:"1px solid #1F317A",borderRadius:6,padding:"3px 9px",fontSize:10.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                                  📎 Añadir las {porRef.length} del concepto ({eur(sumRef)})
                                </button>
                              )}
                              {Math.abs(est.falta)>=0.02&&(
                                <button onClick={()=>buscarQueCuadre(m)} style={{background:"#114521",color:"#047857",border:"1px solid #1F7A3F",borderRadius:6,padding:"3px 9px",fontSize:10.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                                  🔍 Buscar qué cuadra {eur(Math.abs(est.falta))}
                                </button>
                              )}
                              {signoRaro&&(
                                <span style={{fontSize:10,color:"#EC8383",fontWeight:600}}>⚠️ Las facturas del concepto están como {sumRef<0?"gasto":"ingreso"} pero el movimiento es {m.importe<0?"una salida":"una entrada"}: revisa si están en la pestaña correcta</span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td style={{padding:"6px 4px"}}><DelBtn onClick={()=>borrarMov(m.id)}/></td>
                  </tr>
                );
              })}
              {visibles.length===0&&<tr><td colSpan={6} style={{padding:20,textAlign:"center",color:"#7F8692"}}>{filtro==="pendientes"?"🎉 Todo conciliado":"Nada que mostrar"}</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:10}}>
          {[["💰 Facturas emitidas sin cobro en el banco",ingSinCobrar,"#059669"],["💸 Facturas de gasto sin pago en el banco",gasSinPagar,"#B91C1C"]].map(([t,list,c])=>(
            <div key={t} style={{background:"#1F232B",borderRadius:12,border:"1px solid #2E343E",padding:"12px 14px"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#ECEEF2",marginBottom:2}}>{t} ({list.length})</div>
              <div style={{fontSize:10,color:"#9AA1AC",marginBottom:8}}>Del periodo del extracto · {eur(list.reduce((s,i)=>s+Math.abs(importeBanco(i)),0))}</div>
              {list.slice(0,50).map(i=>(
                <div key={i.key} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:11,padding:"3px 0",borderBottom:"1px solid #2E343E"}}>
                  <span style={{color:"#C3C8D0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{i.r.fecha} · {itemLabel(i)}</span>
                  <span style={{fontWeight:700,color:c,whiteSpace:"nowrap"}}>{eur(Math.abs(importeBanco(i)))}</span>
                </div>
              ))}
              {list.length===0&&<div style={{fontSize:11,color:"#7F8692"}}>Todo cuadrado ✅</div>}
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
}

// ── OTROS GASTOS ──────────────────────────────────────────────────────────────
// Movimientos del banco sin factura (comisiones, impuestos, nóminas, traspasos…).
// Se marcan en 🏦 Banco y aquí se clasifican: categoría, proyecto y motivo.
function OtrosGastosTab({movs, guardar, projects, irBanco, ing}){
  const [unlocked,setUnlocked]=useState(false);
  const [showLock,setShowLock]=useState(false);
  const [pendingAction,setPendingAction]=useState(null);
  const [collapsed,setCollapsed]=useState({});
  function requireUnlock(action){
    if(unlocked){ action(); return; }
    setPendingAction(()=>action); setShowLock(true);
  }
  function onUnlock(){ setUnlocked(true); setShowLock(false); if(pendingAction){ pendingAction(); setPendingAction(null); } }

  if(movs===null) return <div style={{padding:40,textAlign:"center",color:"#7F8692",fontSize:12}}>Cargando movimientos del banco…</div>;

  const todosOtros=otrosDeBanco(movs);
  const ajustesCuadre=todosOtros.filter(o=>o.partida);
  const otros=todosOtros.filter(o=>!o.partida).sort((a,b)=>bancoTs(b.fecha)-bancoTs(a.fecha));
  const gastosO=otros.filter(o=>o.importe<0);
  const ingresosO=otros.filter(o=>o.importe>0);
  const ac="#C2410C", acBg="#452E11";
  const eur=v=>`${v.toLocaleString("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2})}€`;

  function upd(id,field,val){
    const extra=field==="categoria"?{catManual:true}:{};
    if(String(id).endsWith("#just")){ const mid=String(id).slice(0,-5); return requireUnlock(()=>guardar(movs.map(m=>m.id===mid?{...m,just:{...(m.just||{}),[field]:val,...extra}}:m))); }
    requireUnlock(()=>guardar(movs.map(m=>m.id===id?{...m,[field]:val,...extra}:m)));
  }
  function devolver(id){
    requireUnlock(()=>{
      if(!window.confirm("¿Quitar este movimiento de Otros gastos? Volverá a quedar pendiente de conciliar en 🏦 Banco.")) return;
      if(String(id).endsWith("#just")){ const mid=String(id).slice(0,-5); return guardar(movs.map(m=>{ if(m.id!==mid) return m; const {just,...rest}=m; return rest; })); }
      guardar(movs.map(m=>m.id===id?{...m,otro:false,match:undefined,nota:"",categoria:undefined,proyecto:undefined,persona:undefined}:m));
    });
  }

  const totGasto=gastosO.filter(o=>o.computa).reduce((s,o)=>s-o.importe,0);
  // Facturas de otros ingresos (ref "OI…") de Ingresos: se enseñan aquí también (se editan en 💰 Ingresos)
  const facturasOI=(ing||[]).filter(r=>(r.ref||"").toUpperCase().startsWith("OI")).sort((a,b)=>bancoTs(b.fecha)-bancoTs(a.fecha));
  const totOI=facturasOI.reduce((s,r)=>s+signedBase(r),0);
  const totIng=ingresosO.filter(o=>o.computa).reduce((s,o)=>s+o.importe,0)+totOI;
  const sinMotivo=otros.filter(o=>!(o.nota||"").trim()).length;
  const noComputa=otros.filter(o=>!o.computa);
  const porCat=OTROS_CATS.map(c=>({...c,total:gastosO.filter(o=>o.categoria===c.id).reduce((s,o)=>s-o.importe,0),n:gastosO.filter(o=>o.categoria===c.id).length})).filter(c=>c.n>0);

  const selStyle={border:"1px solid #2E343E",borderRadius:5,padding:"3px 5px",fontSize:10.5,fontFamily:"inherit",background:"#1F232B",maxWidth:170};

  function tabla(lista,color){
    return(
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
          <THead cols={["Proyecto","Persona","Fecha","Importe €","Categoría","Concepto del banco","Motivo",""]} color={color}/>
          <tbody>
            {lista.map((r,i)=>{
              return(
                <tr key={r.id} style={{background:!r.computa?"#232831":i%2===0?"#452B11":"#1F232B",opacity:r.computa?1:.7}}>
                  <td style={{padding:"3px 5px",minWidth:130}}>
                    <select value={r.proyecto||""} onChange={e=>upd(r.id,"proyecto",e.target.value)} style={{...selStyle,color:(projects||[]).find(p=>p.name===r.proyecto)?.color||"#C3C8D0",fontWeight:r.proyecto?600:400}}>
                      <option value="">— Empresa (general) —</option>
                      {(projects||[]).map(p=><option key={p.name} value={p.name}>{p.name}</option>)}
                    </select>
                  </td>
                  <td style={{padding:"3px 5px",minWidth:110}}>
                    <select value={r.persona||""} onChange={e=>upd(r.id,"persona",e.target.value)} title="Si eliges a alguien, cuenta en su beneficio neto (Equipo)"
                      style={{...selStyle,color:INIT_MEMBERS.find(m=>m.name===r.persona)?.color||"#C3C8D0",fontWeight:r.persona?600:400}}>
                      <option value="">— Nadie —</option>
                      {INIT_MEMBERS.filter(m=>!MIEMBROS_OCULTOS.includes(m.name)||m.name===r.persona).map(m=><option key={m.name} value={m.name}>{m.name}</option>)}
                    </select>
                  </td>
                  <td style={{padding:"3px 8px",whiteSpace:"nowrap",color:"#C3C8D0"}}>{r.fecha}</td>
                  <td style={{padding:"3px 8px",whiteSpace:"nowrap",textAlign:"right",fontWeight:700,color:r.importe<0?"#EC8383":"#059669"}}>{eur(Math.abs(r.importe))}</td>
                  <td style={{padding:"3px 5px"}}>
                    <select value={r.categoria} onChange={e=>upd(r.id,"categoria",e.target.value)} style={{...selStyle,color:r.computa?"#C3C8D0":"#9AA1AC"}}>
                      {OTROS_CATS.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    {!r.computa&&<div style={{fontSize:9,color:"#9AA1AC",marginTop:2}}>No entra en la cuenta de resultados</div>}
                  </td>
                  <td style={{padding:"3px 8px",color:"#9AA1AC",maxWidth:240,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={r.concepto}>{r.concepto||"—"}{r.parcial&&<span style={{color:"#7F8692",fontSize:9.5}}> · parte de un movimiento de {eur(r.importeMov)}</span>}</td>
                  <td style={{padding:"3px 5px",minWidth:170}}>
                    <InpBlur value={r.nota||""} onChange={v=>upd(r.id,"nota",v)} placeholder="Motivo (obligatorio)" w="100%" locked={!unlocked} onLock={()=>setShowLock(true)}/>
                    {!(r.nota||"").trim()&&<div style={{fontSize:9,color:"#EC8383",marginTop:2,fontWeight:600}}>⚠️ Falta el motivo</div>}
                  </td>
                  <td style={{padding:"3px 5px"}}>
                    <button onClick={()=>devolver(r.id)} title="Devolver a Banco (pendiente de conciliar)"
                      style={{background:"none",border:"1px solid #2E343E",borderRadius:5,color:"#9AA1AC",cursor:"pointer",fontSize:10,padding:"2px 6px",fontFamily:"inherit",whiteSpace:"nowrap"}}>↩ Banco</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const years=[...new Set(gastosO.map(o=>fechaYM(o.fecha)?.y).filter(Boolean))].sort((a,b)=>b-a);
  const currentYear=new Date().getFullYear();

  return(
    <div>
      {showLock&&<EditLockModal onUnlock={onUnlock} onClose={()=>setShowLock(false)}/>}
      {!unlocked?(
        <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#15181D",border:"1px solid #2E343E",borderRadius:8,padding:"5px 12px",marginBottom:12,fontSize:10,color:"#9AA1AC",cursor:"pointer"}} onClick={()=>setShowLock(true)}>
          🔒 Modo lectura — <span style={{color:"#ECEEF2",fontWeight:600}}>Haz clic para editar</span>
        </div>
      ):(
        <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#11452D",border:"1px solid #1F7A3F",borderRadius:8,padding:"5px 12px",marginBottom:12,fontSize:10,color:"#059669"}}>
          🔓 Modo edición activo
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8,marginBottom:14}}>
        {[
          {label:"🧾 Total otros gastos", val:`${totGasto.toFixed(0)}€`, sub:"Sin traspasos", color:ac, bg:acBg},
          {label:"🏦 Movimientos", val:gastosO.length, color:"#E8501C", bg:"#452311"},
          ...(totIng?[{label:"💰 Otros ingresos", val:`${totIng.toFixed(0)}€`, color:"#059669", bg:"#11452D"}]:[]),
          {label:"⚠️ Sin motivo", val:sinMotivo, color:sinMotivo?"#EC8383":"#059669", bg:sinMotivo?"#451111":"#11452D"},
          ...(noComputa.length?[{label:"↔️ Traspasos (no computan)", val:noComputa.length, color:"#9AA1AC", bg:"#232831"}]:[]),
        ].map(k=>(
          <div key={k.label} style={{background:k.bg,borderRadius:10,padding:"10px 12px",border:`1.5px solid ${k.color}22`}}>
            <div style={{fontSize:9,color:"#9AA1AC",marginBottom:2}}>{k.label}</div>
            <div style={{fontSize:18,fontWeight:900,color:k.color}}>{k.val}</div>
            {k.sub&&<div style={{fontSize:9,color:"#7F8692"}}>{k.sub}</div>}
          </div>
        ))}
      </div>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {porCat.map(c=>(
            <span key={c.id} style={{background:c.excluye?"#262B34":acBg,color:c.excluye?"#9AA1AC":ac,border:`1px solid ${c.excluye?"#2E343E":"#7A501F"}`,borderRadius:99,padding:"3px 10px",fontSize:10,fontWeight:600}}>
              {c.label}: {c.total.toFixed(0)}€ <span style={{opacity:.6}}>({c.n})</span>
            </span>
          ))}
        </div>
        <button onClick={irBanco} style={{background:"#323844",color:"#FFF",border:"none",borderRadius:7,padding:"6px 14px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
          🏦 Añadir desde Banco
        </button>
      </div>

      {ajustesCuadre.length>0&&(
        <div style={{fontSize:10.5,color:"#AD86EA",background:"#1A1145",border:"1px solid #2F1F7A",borderRadius:8,padding:"7px 12px",marginBottom:8}}>
          🧹 {ajustesCuadre.length} ajustes del cuadre del banco no salen aquí: cuentan en la cuenta de resultados como facturas emitidas ({ajustesCuadre.filter(o=>o.partida==="emitidas").reduce((s,o)=>s+o.importe,0).toFixed(2)}€), facturas recibidas ({(-ajustesCuadre.filter(o=>o.partida==="recibidas").reduce((s,o)=>s+o.importe,0)).toFixed(2)}€) y hojas de gastos ({(-ajustesCuadre.filter(o=>o.partida==="hojas").reduce((s,o)=>s+o.importe,0)).toFixed(2)}€).
        </div>
      )}
      <div style={{fontSize:10.5,color:"#9AA1AC",background:"#232831",border:"1px solid #2E343E",borderRadius:8,padding:"7px 12px",marginBottom:12}}>
        Aquí aparecen los movimientos del banco que no tienen factura. Para añadir uno, ve a <b>🏦 Banco</b> y en "Elegir factura…" escoge <b>Otros gastos</b>. Los <b>traspasos</b> (entre cuentas, aportaciones que se devuelven…) no entran en la cuenta de resultados.
      </div>

      {gastosO.length===0&&ingresosO.length===0&&(
        <div style={{textAlign:"center",padding:"32px",color:"#7F8692"}}>
          <div style={{fontSize:28,marginBottom:6}}>🧾</div>
          <div style={{fontSize:12,fontWeight:600}}>Sin otros gastos todavía</div>
        </div>
      )}

      {years.map(year=>{
        const yrows=gastosO.filter(o=>fechaYM(o.fecha)?.y===year);
        const yTot=yrows.filter(o=>o.computa).reduce((s,o)=>s-o.importe,0);
        const isOpen=collapsed[year]===undefined?year===currentYear||years.length===1:!collapsed[year];
        return(
          <div key={year} style={{marginBottom:12,borderRadius:12,overflow:"hidden",border:`1px solid ${ac}33`}}>
            <div onClick={()=>setCollapsed(c=>({...c,[year]:isOpen}))}
              style={{background:ac,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
              <span style={{color:"#FFF",fontWeight:700,fontSize:13}}>{year} · {yrows.length} movimientos</span>
              <div style={{display:"flex",gap:16,alignItems:"center"}}>
                <span style={{color:"#FFFFFFCC",fontSize:11,fontWeight:700}}>Total: {yTot.toFixed(0)}€</span>
                <span style={{color:"#FFF",fontSize:14}}>{isOpen?"▲":"▼"}</span>
              </div>
            </div>
            {isOpen&&<div style={{background:"#1F232B"}}>{tabla(yrows,ac)}</div>}
          </div>
        );
      })}

      {(ingresosO.length>0||facturasOI.length>0)&&(
        <div style={{marginBottom:12,borderRadius:12,overflow:"hidden",border:"1px solid #05966933"}}>
          <div style={{background:"#059669",padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{color:"#FFF",fontWeight:700,fontSize:13}}>💰 Otros ingresos · {facturasOI.length} facturas OI + {ingresosO.length} entradas del banco</span>
            <span style={{color:"#FFFFFFCC",fontSize:11,fontWeight:700}}>Total: {totIng.toFixed(0)}€</span>
          </div>
          {facturasOI.length>0&&(
            <div style={{background:"#1F232B",overflowX:"auto"}}>
              <div style={{padding:"6px 14px",background:"#11452D",fontSize:10,fontWeight:700,color:"#047857"}}>🧾 Facturas de otros ingresos (OI) · {totOI.toFixed(0)}€ sin IVA · se editan en 💰 Ingresos</div>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <THead cols={["Proyecto","Persona","Fecha","Base €","Total €","Nº factura","Descripción","PDF"]} color="#059669"/>
                <tbody>
                  {facturasOI.map((r,i)=>{
                    const proj=(projects||[]).find(p=>p.name===r.proyecto);
                    const personas=(r.reparto||[]).filter(x=>parseFloat(x.importe)>0).map(x=>x.member);
                    return(
                      <tr key={r.id} style={{background:i%2===0?"#114528":"#1F232B"}}>
                        <td style={{padding:"5px 8px",color:proj?.color||"#9AA1AC",fontWeight:proj?600:400}}>{r.proyecto||"— Empresa (general) —"}</td>
                        <td style={{padding:"5px 8px",color:"#C3C8D0"}}>{personas.length?personas.join(", "):"—"}</td>
                        <td style={{padding:"5px 8px",whiteSpace:"nowrap",color:"#C3C8D0"}}>{r.fecha||"—"}</td>
                        <td style={{padding:"5px 8px",whiteSpace:"nowrap",textAlign:"right",fontWeight:700,color:"#059669"}}>{eur(signedBase(r))}</td>
                        <td style={{padding:"5px 8px",whiteSpace:"nowrap",textAlign:"right",color:"#9AA1AC"}}>{r.total?eur(parseFloat(r.total)||0):"—"}</td>
                        <td style={{padding:"5px 8px",fontWeight:600}}>{r.ref}</td>
                        <td style={{padding:"5px 8px",color:"#9AA1AC",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={r.descripcion}>{r.descripcion||"—"}</td>
                        <td style={{padding:"5px 8px"}}>{r.linkFactura?<a href={r.linkFactura} target="_blank" rel="noreferrer" style={{textDecoration:"none"}}>📄</a>:<span style={{color:"#5C6370"}}>—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {ingresosO.length>0&&(
            <div style={{background:"#1F232B"}}>
              {facturasOI.length>0&&<div style={{padding:"6px 14px",background:"#11452D",fontSize:10,fontWeight:700,color:"#047857",borderTop:"1px solid #1F7A4B"}}>🏦 Entradas del banco sin factura</div>}
              {tabla(ingresosO,"#059669")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── CUENTA DE RESULTADOS EN DIRECTO ──────────────────────────────────────────
// Formato de la asesoría: meses 1–12 con 1T–4T (suma de cada trimestre) y TOTAL.
// Ingresos = facturas emitidas + otros ingresos · Gastos = facturas recibidas + hojas de gastos + otros gastos.
// Se calcula en cada render con las facturas, hojas y otros gastos del banco, así que se actualiza sola.
// Apuntes de la cuenta de resultados de un año (por partida), filtrados por proyecto ("__all", "__none" o nombre)
function pygApuntes(year,{ing,gas,hojas,otros},proy="__all"){
  const enProy=p=>proy==="__all"||(proy==="__none"?!p:p===proy);
  const delAño=f=>{ const ym=fechaYM(f); return ym&&ym.y===year?ym.m:0; };
  // Cada partida es una lista de apuntes {m, fecha, label, proyecto, importe}
  function apuntes(lista,fn){ return lista.map(fn).filter(x=>x&&x.m&&Math.abs(x.importe)>0.001); }
  const ajustes=(otros||[]).filter(o=>o.computa&&o.partida);           // ajustes del cuadre del banco
  const otrosC=(otros||[]).filter(o=>o.computa&&!o.partida);
  const ajuste=(partida,signo)=>apuntes(ajustes.filter(o=>o.partida===partida),o=>enProy(o.proyecto)&&{m:delAño(o.fecha),fecha:o.fecha,label:`Ajuste cuadre banco · ${o.concepto}`,proyecto:o.proyecto,importe:signo*o.importe});
  const catLabel=id=>OTROS_CATS.find(c=>c.id===id)?.label||"Otros";
  // Las facturas OI (otros ingresos) van a "Otros ingresos", no a "Facturas emitidas"
  const esOI=r=>(r.ref||"").toUpperCase().startsWith("OI");
  const emitidas=[...apuntes((ing||[]).filter(r=>!esOI(r)),r=>enProy(r.proyecto)&&{m:delAño(r.fecha),fecha:r.fecha,label:`${r.ref||"s/ref"} · ${r.descripcion||""}`,proyecto:r.proyecto,importe:signedBase(r)}),...ajuste("emitidas",1)];
  const otrosIng=[
    ...apuntes((ing||[]).filter(esOI),r=>enProy(r.proyecto)&&{m:delAño(r.fecha),fecha:r.fecha,label:`${r.ref} · ${r.descripcion||""}`,proyecto:r.proyecto,importe:signedBase(r)}),
    ...apuntes(otrosC.filter(o=>o.importe>0),o=>enProy(o.proyecto)&&{m:delAño(o.fecha),fecha:o.fecha,label:`Banco · ${o.nota||o.concepto}`,proyecto:o.proyecto,importe:o.importe}),
  ];
  const recibidas=[...apuntes(gas||[],r=>enProy(r.proyecto)&&{m:delAño(r.fecha),fecha:r.fecha,label:`${r.ref||"s/ref"} · ${r.descripcion||""}`,proyecto:r.proyecto,importe:signedBase(r)}),...ajuste("recibidas",-1)];
  const hojasG=(hojas||[]).flatMap(r=>{
    const m=delAño(r.fecha); if(!m) return [];
    const label=`HG · ${r.responsable||"Sin responsable"}`;
    if(proy==="__all") return [{m,fecha:r.fecha,label,proyecto:hojaPorProyecto(r).map(x=>x.proyecto).filter(Boolean).join(", "),importe:parseFloat(r.importe)||0}];
    return hojaPorProyecto(r).filter(x=>enProy(x.proyecto)).map(x=>({m,fecha:r.fecha,label,proyecto:x.proyecto,importe:x.importe}));
  }).filter(x=>Math.abs(x.importe)>0.001).concat(ajuste("hojas",-1));
  const otrosG=apuntes(otrosC.filter(o=>o.importe<0),o=>enProy(o.proyecto)&&{m:delAño(o.fecha),fecha:o.fecha,label:`${catLabel(o.categoria)} · ${o.nota||o.concepto}`,proyecto:o.proyecto,importe:-o.importe});

  return {emitidas,otrosIng,recibidas,hojasG,otrosG};
}
function CuentaResultadosTab({ing, gas, hojas, otros, projects, irBalance}){
  const hoy=new Date();
  const todosYears=[...new Set([...(ing||[]),...(gas||[]),...(hojas||[]),...(otros||[])].map(r=>fechaYM(r.fecha)?.y).filter(y=>y&&y>2000&&y<2100))].sort((a,b)=>b-a);
  const [year,setYear]=useState(()=>todosYears.includes(hoy.getFullYear())?hoy.getFullYear():(todosYears[0]||hoy.getFullYear()));
  const [proy,setProy]=useState("__all");
  const [abierta,setAbierta]=useState(null);
  // Impuesto sobre sociedades: 19% (confirmado por la asesoría); se puede cambiar en el campo de arriba
  const [tipoIS,setTipoIS]=useState(()=>{ try{ const v=localStorage.getItem("blesk_tipo_is_v2"); return v===null?"19":v; }catch{ return "19"; } });
  function cambiarTipo(v){ setTipoIS(v); try{ localStorage.setItem("blesk_tipo_is_v2",v); }catch{} }
  const tasa=(parseFloat(String(tipoIS).replace(",","."))||0)/100;

  const enProy=p=>proy==="__all"||(proy==="__none"?!p:p===proy);
  const delAño=f=>{ const ym=fechaYM(f); return ym&&ym.y===year?ym.m:0; };
  const eur0=v=>Math.round(v).toLocaleString("es-ES");
  const eur2=v=>`${v.toLocaleString("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2})}€`;

  // Columnas: 1 2 3 1T 4 5 6 2T 7 8 9 3T 10 11 12 4T TOTAL
  const COLS=[];
  for(let q=0;q<4;q++){
    for(let k=1;k<=3;k++){ const m=q*3+k; COLS.push({tipo:"mes",m,label:MESES_PREV[m-1],meses:[m]}); }
    COLS.push({tipo:"tri",label:`${q+1}T`,meses:[q*3+1,q*3+2,q*3+3]});
  }
  COLS.push({tipo:"total",label:"TOTAL",meses:[1,2,3,4,5,6,7,8,9,10,11,12]});

  const {emitidas,otrosIng,recibidas,hojasG,otrosG}=pygApuntes(year,{ing,gas,hojas,otros},proy);
  const porMes=items=>{ const a=Array(13).fill(0); items.forEach(x=>{ a[x.m]+=x.importe; }); return a; };
  const sumaM=(...arrs)=>Array.from({length:13},(_,i)=>arrs.reduce((s,a)=>s+a[i],0));
  const mEmit=porMes(emitidas), mOIng=porMes(otrosIng), mIng=sumaM(mEmit,mOIng);
  const mRec=porMes(recibidas), mHoj=porMes(hojasG), mOGas=porMes(otrosG), mGas=sumaM(mRec,mHoj,mOGas);
  const mRAI=mIng.map((v,i)=>v-mGas[i]);
  const mIS=mRAI.map(v=>v*tasa);
  const mNeto=mRAI.map((v,i)=>v-mIS[i]);
  const col=(arr,c)=>c.meses.reduce((s,m)=>s+arr[m],0);
  const T=arr=>col(arr,COLS[COLS.length-1]);

  const FILAS=[
    {key:"emit", label:"Facturas emitidas", arr:mEmit, items:emitidas},
    {key:"oing", label:"Otros ingresos",    arr:mOIng, items:otrosIng},
    {tipo:"ing", label:"Ingresos",          arr:mIng,  color:"#16A34A"},
    {key:"rec",  label:"Facturas recibidas",arr:mRec,  items:recibidas, gasto:true},
    {key:"hoj",  label:"Hojas de gastos",   arr:mHoj,  items:hojasG,    gasto:true},
    {key:"ogas", label:"Otros gastos",      arr:mOGas, items:otrosG,    gasto:true},
    {tipo:"gas", label:"Gastos",            arr:mGas,  color:"#EB8484", gasto:true},
    {tipo:"rai", label:"Resultado antes de impuestos", arr:mRAI},
    {tipo:"is",  label:`Impuesto sobre sociedades${tasa?` (${(tasa*100).toLocaleString("es-ES")}%)`:""}`, arr:mIS, gasto:true},
    {tipo:"neto",label:"Resultado neto",    arr:mNeto},
  ];

  const esFuturoMes=m=>year>hoy.getFullYear()||(year===hoy.getFullYear()&&m>hoy.getMonth()+1);
  const esActualMes=m=>year===hoy.getFullYear()&&m===hoy.getMonth()+1;
  const colRes=v=>v>0.5?"#059669":v<-0.5?"#B91C1C":"#969CA6";
  // Importes tal cual (gastos en positivo, como en la plantilla); el resultado lleva signo
  const fmt=v=>Math.abs(v)<0.5?"":(v<0?"−":"")+eur0(Math.abs(v));
  const nomProy=proy==="__all"?"Toda la empresa":proy==="__none"?"Sin proyecto":proy;

  const tIng=T(mIng), tGas=T(mGas), tRAI=T(mRAI), tNeto=T(mNeto);
  const margen=tIng?tNeto/tIng*100:null;

  function exportar(){
    const fecha=hoy.toLocaleDateString("es-ES",{day:"2-digit",month:"long",year:"numeric"});
    const head=COLS.map(c=>`<th class="${c.tipo}">${c.tipo==="mes"?c.m:c.label}</th>`).join("");
    const body=FILAS.map(f=>{
      const cls=f.tipo||f.key;
      const lbl=f.tipo==="ing"?`<span style="color:#16A34A">${f.label}</span>`:f.tipo==="gas"?`<span style="color:#EB8484">${f.label}</span>`:f.label;
      return `<tr class="${cls}"><td class="lbl">${lbl}</td>${COLS.map(c=>`<td class="${c.tipo}">${fmt(col(f.arr,c))}</td>`).join("")}</tr>`;
    }).join("");
    const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${EMPRESA} — Cuenta de resultados ${year}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;color:#ECEEF2;padding:18px 22px}
.hdr{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2.5px solid #ECEEF2;padding-bottom:10px;margin-bottom:14px}
.brand{font-size:24px;font-weight:900;letter-spacing:-1px}.sub{font-size:8.5px;color:#9AA1AC;margin-top:3px}h1{font-size:15px;text-align:right}
h2{text-align:center;font-size:10px;letter-spacing:.5px;margin-bottom:4px}
table{width:100%;border-collapse:collapse;border:1.5px solid #ECEEF2}th{font-size:8.5px;padding:4px 3px;border-bottom:1.5px solid #ECEEF2;text-align:right}
td{padding:4px 3px;text-align:right;font-variant-numeric:tabular-nums}td.lbl{text-align:left;white-space:nowrap;padding-left:6px;border-right:1.5px solid #ECEEF2}
th.mes,td.mes{background:#262B34}th.tri,td.tri{background:#1F232B;font-weight:700;border-left:1px solid #ECEEF2;border-right:1px solid #ECEEF2}th.total,td.total{font-weight:800;border-left:1.5px solid #ECEEF2}
tr.ing td,tr.gas td{border-bottom:1px solid #ECEEF2;font-weight:700}tr.rai td{font-weight:800;border-bottom:1px solid #ECEEF2}tr.neto td{font-weight:900;border-top:1.5px solid #ECEEF2}
tr.oing td,tr.is td{border-bottom:1px solid #ECEEF2}
.foot{margin-top:12px;font-size:7.5px;color:#9AA1AC;display:flex;justify-content:space-between;gap:20px}@media print{@page{size:A4 landscape;margin:8mm}}</style></head><body>
<div class="hdr"><div><div class="brand">${EMPRESA}</div><div class="sub">${EMPRESA_SUB}</div></div><div><h1>Cuenta de resultados ${year}</h1><div class="sub" style="text-align:right">${nomProy} · generado el ${fecha}</div></div></div>
<h2>CUENTA DE RESULTADOS</h2>
<table><thead><tr><th style="text-align:left;border-right:1.5px solid #ECEEF2"></th>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="foot"><span>Importes en euros, sin IVA (base imponible). Hojas de gastos por su importe total. Otros gastos = comisiones y gastos no deducibles (traspasos excluidos).${tasa?` Impuesto sobre sociedades estimado al ${(tasa*100).toLocaleString("es-ES")}%.`:""}</span><span>${EMPRESA} · Documento interno</span></div></body></html>`;
    const win=window.open("","_blank"); win.document.write(html); win.document.close(); win.focus(); setTimeout(()=>win.print(),500);
  }

  const filaAbierta=FILAS.find(r=>r.key&&r.key===abierta);
  const thBase={padding:"7px 5px",textAlign:"right",fontSize:10,fontWeight:700,whiteSpace:"nowrap"};

  return(
    <div>
      <style>{`@keyframes bleskPulse{0%{box-shadow:0 0 0 0 rgba(5,150,105,.5)}70%{box-shadow:0 0 0 6px rgba(5,150,105,0)}100%{box-shadow:0 0 0 0 rgba(5,150,105,0)}}`}</style>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontWeight:800,fontSize:17,color:"#ECEEF2",display:"flex",alignItems:"center",gap:10}}>
            📈 Cuenta de Resultados {year}
            <span style={{display:"inline-flex",alignItems:"center",gap:5,background:"#11452D",color:"#047857",borderRadius:99,padding:"2px 9px",fontSize:9.5,fontWeight:700}}>
              <span style={{width:6,height:6,borderRadius:99,background:"#059669",animation:"bleskPulse 1.8s infinite"}}/> En directo
            </span>
          </div>
          <div style={{fontSize:11,color:"#9AA1AC",marginTop:2}}>Se actualiza sola con cada factura, hoja de gasto y otro gasto del banco · Clic en una partida para ver el detalle</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <select value={year} onChange={e=>{setYear(+e.target.value);setAbierta(null);}} style={{border:"1px solid #2E343E",borderRadius:8,padding:"6px 10px",fontSize:11,fontFamily:"inherit",fontWeight:700,background:"#1F232B"}}>
            {(todosYears.length?todosYears:[year]).map(y=><option key={y} value={y}>{y}</option>)}
          </select>
          <select value={proy} onChange={e=>{setProy(e.target.value);setAbierta(null);}} style={{border:"1px solid #2E343E",borderRadius:8,padding:"6px 10px",fontSize:11,fontFamily:"inherit",background:"#1F232B",maxWidth:200}}>
            <option value="__all">🏢 Toda la empresa</option>
            <option value="__none">Sin proyecto</option>
            {(projects||[]).map(p=><option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <label style={{display:"flex",alignItems:"center",gap:5,fontSize:10.5,color:"#9AA1AC",background:"#1F232B",border:"1px solid #2E343E",borderRadius:8,padding:"4px 8px"}} title="Tipo del impuesto sobre sociedades que se aplica al resultado antes de impuestos">
            Imp. sociedades
            <input value={tipoIS} onChange={e=>cambiarTipo(e.target.value.replace(/[^0-9.,]/g,""))} inputMode="decimal"
              style={{width:34,border:"none",borderBottom:"1px solid #3A414D",fontSize:11,fontWeight:700,textAlign:"right",fontFamily:"inherit",outline:"none",color:"#ECEEF2"}}/>%
          </label>
          <button onClick={exportar} style={{background:"#262B34",color:"#C3C8D0",border:"1px solid #2E343E",borderRadius:8,padding:"7px 14px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>⬇ Exportar PDF</button>
          {irBalance&&<button onClick={irBalance} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"7px 14px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>⚖️ Ver balance</button>}
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8,marginBottom:14}}>
        {[
          {l:"Ingresos",v:`${eur0(tIng)}€`,c:"#059669",bg:"#11452D"},
          {l:"Gastos",v:`${eur0(tGas)}€`,c:"#B91C1C",bg:"#451111"},
          {l:"Resultado antes de imp.",v:`${eur0(tRAI)}€`,c:colRes(tRAI),bg:"#232831"},
          {l:"Resultado neto",v:`${eur0(tNeto)}€`,c:colRes(tNeto),bg:tNeto>=0?"#11452D":"#451111",big:true},
          {l:"Margen neto",v:margen===null?"—":`${margen.toFixed(1)}%`,c:"#D5D9E0",bg:"#112845"},
        ].map(k=>(
          <div key={k.l} style={{background:k.bg,borderRadius:10,padding:"11px 14px",border:k.big?`1.5px solid ${k.c}55`:"none"}}>
            <div style={{fontSize:9,color:k.c,fontWeight:700,letterSpacing:"0",marginBottom:3}}>{k.l}</div>
            <div style={{fontSize:20,fontWeight:800,color:k.c,letterSpacing:"-1px"}}>{k.v}</div>
          </div>
        ))}
      </div>

      <div style={{border:"1.5px solid #ECEEF2",borderRadius:10,overflow:"hidden",background:"#1F232B"}}>
        <div style={{textAlign:"center",fontWeight:800,fontSize:11,letterSpacing:"0",padding:"7px 0 3px",color:"#ECEEF2"}}>CUENTA DE RESULTADOS · {nomProy.toUpperCase()}</div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead>
              <tr style={{borderBottom:"1.5px solid #ECEEF2"}}>
                <th style={{...thBase,textAlign:"left",position:"sticky",left:0,background:"#1F232B",minWidth:200,borderRight:"1.5px solid #ECEEF2"}}></th>
                {COLS.map((c,i)=>(
                  <th key={i} style={{...thBase,minWidth:c.tipo==="mes"?50:58,
                    background:c.tipo==="mes"?(esActualMes(c.m)?"#453B11":"#262B34"):c.tipo==="total"?"#3A414D":"#1F232B",
                    color:c.tipo==="total"?"#FFF":c.tipo==="mes"&&esFuturoMes(c.m)?"#7F8692":"#ECEEF2",
                    borderLeft:c.tipo!=="mes"?"1px solid #ECEEF2":"none",borderRight:c.tipo==="tri"?"1px solid #ECEEF2":"none"}}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FILAS.map((f,ri)=>{
                const clic=!!f.items;
                const fuerte=["ing","gas","rai","neto"].includes(f.tipo);
                const lineaAbajo=["oing","ing","gas","rai","is"].includes(f.tipo||f.key);
                const bgFila=f.tipo==="neto"?"#232831":abierta&&abierta===f.key?"#453B11":"#1F232B";
                const signo=["rai","neto"].includes(f.tipo);
                return(
                  <tr key={ri} onClick={clic?()=>setAbierta(abierta===f.key?null:f.key):undefined}
                    style={{cursor:clic?"pointer":"default",borderBottom:lineaAbajo?"1px solid #ECEEF2":"1px solid #2E343E",borderTop:f.tipo==="neto"?"1.5px solid #ECEEF2":undefined,background:bgFila}}>
                    <td style={{padding:"6px 10px",textAlign:"left",whiteSpace:"nowrap",position:"sticky",left:0,background:bgFila,borderRight:"1.5px solid #ECEEF2",
                      fontWeight:fuerte?800:500,color:f.color||"#ECEEF2",fontSize:f.tipo==="neto"?12:11}}>
                      {clic&&<span style={{color:"#7F8692",fontSize:9,marginRight:5}}>{abierta===f.key?"▼":"▸"}</span>}
                      {f.label}
                      {clic&&<span style={{color:"#7F8692",fontSize:9,marginLeft:5}}>({f.items.length})</span>}
                    </td>
                    {COLS.map((c,i)=>{
                      const v=col(f.arr,c);
                      return(
                        <td key={i} style={{padding:"6px 5px",textAlign:"right",fontVariantNumeric:"tabular-nums",
                          background:c.tipo==="mes"?(esActualMes(c.m)?"#453B11":"#232831"):c.tipo==="total"?"#262B34":undefined,
                          borderLeft:c.tipo!=="mes"?"1px solid #ECEEF2":"none",borderRight:c.tipo==="tri"?"1px solid #ECEEF2":"none",
                          fontWeight:c.tipo!=="mes"||fuerte?800:500,
                          color:signo?colRes(v):f.color||"#C3C8D0",
                          opacity:c.tipo==="mes"&&esFuturoMes(c.m)?.4:1}}>
                          {fmt(v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {filaAbierta&&(
        <div style={{marginTop:12,border:"1px solid #7A681F",borderRadius:12,background:"#453B11",padding:"12px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontWeight:700,fontSize:12,color:"#ECEEF2"}}>{filaAbierta.label} · {year} · {filaAbierta.items.length} apuntes · {eur2(T(filaAbierta.arr))}</div>
            <button onClick={()=>setAbierta(null)} style={{background:"none",border:"none",color:"#7F8692",cursor:"pointer",fontSize:14}}>✕</button>
          </div>
          <div style={{maxHeight:320,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <tbody>
                {[...filaAbierta.items].sort((a,b)=>bancoTs(b.fecha)-bancoTs(a.fecha)).map((x,i)=>(
                  <tr key={i} style={{borderTop:"1px solid #7A681F"}}>
                    <td style={{padding:"4px 6px",color:"#9AA1AC",whiteSpace:"nowrap",width:80}}>{x.fecha}</td>
                    <td style={{padding:"4px 6px",color:"#ECEEF2"}}>{x.label}</td>
                    <td style={{padding:"4px 6px",color:"#9AA1AC",fontSize:10}}>{x.proyecto||"—"}</td>
                    <td style={{padding:"4px 6px",textAlign:"right",fontWeight:700,whiteSpace:"nowrap",color:filaAbierta.gasto?"#EC8383":"#059669"}}>{eur2(x.importe)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{fontSize:10,color:"#7F8692",marginTop:10,lineHeight:1.5}}>
        1T–4T = suma de los tres meses de cada trimestre. Importes sin IVA (base imponible); las hojas de gastos cuentan por su importe total y las rectificativas en negativo restan.
        "Otros gastos" = comisiones y gastos no deducibles que se marcan en 🏦 Banco (los traspasos no entran).
        {tasa?` El impuesto sobre sociedades se estima al ${(tasa*100).toLocaleString("es-ES")}% del resultado antes de impuestos.`:" Pon el tipo del impuesto sobre sociedades arriba cuando lo confirméis con la asesoría."}
      </div>
    </div>
  );
}

// ── BALANCE DE SITUACIÓN ──────────────────────────────────────────────────────
// Caja y saldos con socios (lo que no sale de ningún sitio): {caja:{"2026-09":120}, socios:{...}} — el valor se arrastra a los meses siguientes
const balanceLoad=()=>jsonLoad("balance");
const balanceSave=map=>jsonSave("balance",map);
function tsDoc(f){
  const s=String(f||"").trim();
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m) return new Date(+m[1],+m[2]-1,+m[3]).getTime();
  m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if(m){ const y=m[3].length===2?2000+(+m[3]):+m[3]; return new Date(y,+m[2]-1,+m[1]).getTime(); }
  return 0;
}
function BalanceTab({ing, gas, hojas, otros, banco, rect, saldadas}){
  const hoy=new Date();
  const ahora=hoy.getTime();
  const todosYears=[...new Set([...(ing||[]),...(gas||[]),...(hojas||[])].map(r=>fechaYM(r.fecha)?.y).filter(y=>y&&y>2000&&y<2100))].sort((a,b)=>b-a);
  const [year,setYear]=useState(()=>todosYears.includes(hoy.getFullYear())?hoy.getFullYear():(todosYears[0]||hoy.getFullYear()));
  const [manual,setManual]=useState({});
  const [abierta,setAbierta]=useState(null);
  const [unlocked,setUnlocked]=useState(false);
  const [showLock,setShowLock]=useState(false);
  const [pendingAction,setPendingAction]=useState(null);
  useEffect(()=>{ balanceLoad().then(m=>setManual(m||{})).catch(()=>{}); },[]);
  function requireUnlock(action){ if(unlocked){ action(); return; } setPendingAction(()=>action); setShowLock(true); }
  function onUnlock(){ setUnlocked(true); setShowLock(false); if(pendingAction){ pendingAction(); setPendingAction(null); } }
  const tasa=(()=>{ try{ const v=localStorage.getItem("blesk_tipo_is_v2"); return (parseFloat(String(v===null?"19":v).replace(",","."))||0)/100; }catch{ return 0.19; } })();

  // ── Cuándo se cobró / pagó cada factura u hoja ──
  const {itemByKey,anuladas}=conciliables(ing,gas,hojas,rect,saldadas);
  const pagoTs={};
  (banco||[]).forEach(m=>{
    if(!bancoEstado(m,itemByKey).ok) return;
    const t=bancoTs(m.fecha);
    movKeys(m).forEach(k=>{ if(pagoTs[k]===undefined||t<pagoTs[k]) pagoTs[k]=t; });
  });
  const tsBanco=(banco||[]).map(m=>bancoTs(m.fecha)).filter(Boolean);
  const desde=tsBanco.length?Math.min(...tsBanco):null;
  function fechaPago(k,r){
    if(anuladas.has(k)) return -Infinity;                    // rectificada por completo: nunca queda pendiente
    if(pagoTs[k]!==undefined) return pagoTs[k];              // conciliada: fecha del movimiento del banco
    const s=saldadas?.[k];
    if(s) return /cuadre/i.test(s.nota||"")?tsDoc(r.fecha):(tsDoc(s.fecha)||tsDoc(r.fecha)); // saldada a mano
    if(r.pagado&&(!desde||tsDoc(r.fecha)<desde)) return tsDoc(r.fecha); // anterior al extracto y pagada
    return Infinity;
  }
  const docs=[
    ...(ing||[]).map(r=>({kind:"ing",k:`ing:${r.id}`,r})),
    ...(gas||[]).map(r=>({kind:"gas",k:`gas:${r.id}`,r})),
    ...(hojas||[]).map(r=>({kind:"hoja",k:`hoja:${r.id}`,r})),
  ].map(d=>{
    const rr=itemByKey[d.k]?.r||d.r;
    return {...d,t:tsDoc(d.r.fecha),pago:fechaPago(d.k,d.r),
      pendiente:d.kind==="hoja"?(parseFloat(d.r.importe)||0):totalFirmado(rr),
      cuota:d.kind==="hoja"?0:totalFirmado(d.r)-signedBase(d.r)};
  });

  // ── Resultados (los mismos números que la Cuenta de Resultados) ──
  const data={ing,gas,hojas,otros};
  const raiMeses=y=>{
    const a=Array(13).fill(0);
    const P=pygApuntes(y,data);
    [...P.emitidas,...P.otrosIng].forEach(x=>{ a[x.m]+=x.importe; });
    [...P.recibidas,...P.hojasG,...P.otrosG].forEach(x=>{ a[x.m]-=x.importe; });
    return a;
  };
  const raiAño=raiMeses(year);
  // Resultado del ejercicio anterior = resultado neto de la cuenta de resultados del año anterior
  const raiAnt=raiMeses(year-1).reduce((s,v)=>s+v,0);
  const resAnterior=raiAnt-raiAnt*tasa;

  // ── Situación a una fecha ──
  const ymKey=(y,m)=>`${y}-${String(m).padStart(2,"0")}`;
  const arrastre=(mapa,y,m)=>{ const ks=Object.keys(mapa||{}).filter(k=>k<=ymKey(y,m)).sort(); return ks.length?(parseFloat(mapa[ks[ks.length-1]])||0):0; };
  function saldoBanco(T){
    const movs=(banco||[]).filter(m=>bancoTs(m.fecha)&&bancoTs(m.fecha)<=T);
    if(!movs.length) return null;
    const conSaldo=movs.filter(m=>m.saldo!==null&&m.saldo!==undefined&&!isNaN(m.saldo));
    if(!conSaldo.length) return null;
    // el último con saldo (en el orden del extracto si hay varios el mismo día)
    const tUlt=Math.max(...conSaldo.map(m=>bancoTs(m.fecha)));
    const delDia=conSaldo.filter(m=>bancoTs(m.fecha)===tUlt);
    const idxs=delDia.map(m=>banco.indexOf(m));
    const ordenAsc=banco.length>1&&bancoTs(banco[0].fecha)<=bancoTs(banco[banco.length-1].fecha);
    const ult=delDia[idxs.indexOf(ordenAsc?Math.max(...idxs):Math.min(...idxs))];
    const despues=movs.filter(m=>bancoTs(m.fecha)>tUlt&&(m.saldo===null||m.saldo===undefined)).reduce((s,m)=>s+m.importe,0);
    return ult.saldo+despues;
  }
  function situacion(m){
    const T=Math.min(new Date(year,m,0,23,59,59).getTime(),ahora);
    const pend=kind=>docs.filter(d=>d.kind===kind&&d.t&&d.t<=T&&d.pago>T);
    const iniAño=new Date(year,0,1).getTime();
    const hasta=kind=>docs.filter(d=>d.kind===kind&&d.t&&d.t>=iniAño&&d.t<=T);   // IVA de las facturas del año
    const sum=(l,f)=>l.reduce((s,d)=>s+f(d),0);
    const cli=pend("ing"), prov=pend("gas"), hg=pend("hoja");
    // Liquidaciones de IVA pagadas (o devueltas) a Hacienda por trimestres de este año: las de enero-febrero son del 4T del año anterior
    const desdeMarzo=new Date(year,2,1).getTime();
    const liqIVA=(otros||[]).filter(o=>o.categoria==="hacienda"&&!RE_SOCIEDADES.test(`${o.concepto||""} ${o.nota||""}`)&&bancoTs(o.fecha)>=desdeMarzo&&bancoTs(o.fecha)<=T);
    const ivaPagado=liqIVA.filter(o=>o.importe<0).reduce((a,o)=>a-o.importe,0);
    const ivaDevuelto=liqIVA.filter(o=>o.importe>0).reduce((a,o)=>a+o.importe,0);
    const v={
      clientes:sum(cli,d=>d.pendiente),
      ivaCobro:sum(hasta("gas"),d=>d.cuota)-ivaDevuelto,
      cuenta:saldoBanco(T),
      caja:arrastre(manual.caja,year,m),
      rai:raiAño.slice(1,m+1).reduce((s,x)=>s+x,0),
      anterior:resAnterior,
      proveedores:sum(prov,d=>d.pendiente),
      ivaPago:sum(hasta("ing"),d=>d.cuota)-ivaPagado,
      hojas:sum(hg,d=>d.pendiente),
      socios:arrastre(manual.socios,year,m),
    };
    v.deudores=v.clientes+v.ivaCobro;
    v.efectivo=(v.cuenta||0)+v.caja;
    v.noCorriente=0;
    v.corriente=v.deudores+v.efectivo;
    v.activo=v.noCorriente+v.corriente;
    v.fondos=v.rai+v.anterior;
    v.pasivoCorriente=v.proveedores+v.ivaPago+v.hojas+v.socios;
    v.pnPasivo=v.fondos+v.pasivoCorriente;
    v.dif=v.activo-v.pnPasivo;
    v.detalle={clientes:cli,proveedores:prov,hojas:hg};
    v.T=T;
    return v;
  }

  // Columnas: 1 2 3 1T … 10 11 12 4T AÑO (el trimestre y el año son la foto al cierre)
  const mesActual=year===hoy.getFullYear()?hoy.getMonth()+1:year<hoy.getFullYear()?12:0;
  const futuro=m=>m>mesActual;
  const COLS=[];
  for(let q=0;q<4;q++){
    for(let k=1;k<=3;k++){ const m=q*3+k; COLS.push({tipo:"mes",m,label:String(m)}); }
    COLS.push({tipo:"tri",m:q*3+3,label:`${q+1}T`});
  }
  COLS.push({tipo:"total",m:Math.max(1,Math.min(12,mesActual||12)),label:String(year)});
  const sit={};
  for(let m=1;m<=12;m++) if(!futuro(m)) sit[m]=situacion(m);
  const valor=(c,campo)=>{ if(futuro(c.m)) return undefined; return sit[c.m]?.[campo]; };

  // Fecha de análisis: último mes cerrado (o el que se elija pinchando en la cabecera)
  const cerradoDef=year<hoy.getFullYear()?12:Math.max(1,hoy.getMonth());
  const [mesSel,setMesSel]=useState(cerradoDef);
  useEffect(()=>{ setMesSel(year<hoy.getFullYear()?12:Math.max(1,hoy.getMonth())); setAbierta(null); },[year]);
  const S=sit[mesSel]||situacion(Math.min(mesSel,Math.max(1,mesActual)));
  const fechaSel=new Date(S.T).toLocaleDateString("es-ES",{day:"numeric",month:"long",year:"numeric"});

  const eur0=v=>Math.round(v).toLocaleString("es-ES");
  const eur2=v=>`${(v||0).toLocaleString("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2})}€`;
  const fmt=v=>v===undefined?"":v===null?"—":Math.abs(v)<0.5?"":(v<0?"−":"")+eur0(Math.abs(v));

  function editarManual(campo,m,etiqueta){
    requireUnlock(()=>{
      const actual=arrastre(manual[campo],year,m);
      const r=window.prompt(`${etiqueta} a ${new Date(year,m,0).toLocaleDateString("es-ES")} (€).\nSe mantiene en los meses siguientes hasta que lo cambies:`,String(actual||0));
      if(r===null) return;
      const v=parseFloat(String(r).replace(/\./g,"").replace(",","."));
      if(isNaN(v)) return;
      setManual(prev=>{ const n={...prev,[campo]:{...(prev[campo]||{}),[ymKey(year,m)]:v}}; balanceSave(n).catch(err=>alert("Error guardando: "+err.message)); return n; });
    });
  }

  // nivel: 0 = gran bloque (A, B…), 1 = epígrafe (I, II…), 2 = partida
  const ACTIVO=[
    {label:"A) ACTIVO NO CORRIENTE", campo:"noCorriente", nivel:0},
    {label:"I. Inmovilizado intangible", nivel:1},
    {label:"II. Inmovilizado material", nivel:1},
    {label:"III. Inversiones financieras a largo plazo", nivel:1},
    {label:"IV. Proveedores de inmovilizado a largo plazo", nivel:1},
    {label:"B) ACTIVO CORRIENTE", campo:"corriente", nivel:0},
    {label:"I. Existencias", nivel:1},
    {label:"II. Deudores comerciales y otras cuentas a cobrar", campo:"deudores", nivel:1},
    {label:"Clientes pendientes de cobro", campo:"clientes", nivel:2, det:"clientes"},
    {label:"Hacienda - IVA pendiente de cobro", campo:"ivaCobro", nivel:2, nota:"IVA de las facturas recibidas (lo revisáis con la asesoría)"},
    {label:"III. Inversiones financieras a corto plazo", nivel:1},
    {label:"IV. Efectivo y otros activos líquidos equivalentes", campo:"efectivo", nivel:1},
    {label:"Cuenta corriente", campo:"cuenta", nivel:2, nota:"Saldo del extracto del banco"},
    {label:"Caja", campo:"caja", nivel:2, editable:"caja", nota:"Doble clic en un mes para poner el dinero en mano"},
    {label:"TOTAL ACTIVO (A + B)", campo:"activo", total:true},
  ];
  const PASIVO=[
    {label:"A) PATRIMONIO NETO", campo:"fondos", nivel:0},
    {label:"A-1) Fondos propios", campo:"fondos", nivel:1},
    {label:"Resultado antes de impuestos", campo:"rai", nivel:2, nota:`Cuenta de resultados ${year} acumulada hasta ese mes`},
    {label:"Resultado del ejercicio anterior", campo:"anterior", nivel:2, nota:`Resultado neto de la cuenta de resultados de ${year-1}`},
    {label:"B) PASIVO NO CORRIENTE", nivel:0},
    {label:"C) PASIVO CORRIENTE", campo:"pasivoCorriente", nivel:0},
    {label:"Proveedores pendientes de pago", campo:"proveedores", nivel:2, det:"proveedores"},
    {label:"Hacienda - IVA pendiente de pago", campo:"ivaPago", nivel:2, nota:"IVA de las facturas emitidas del año menos lo ya pagado a Hacienda por los trimestres del año (lo revisáis con la asesoría)"},
    {label:"Hojas de gasto pendientes de pago", campo:"hojas", nivel:2, det:"hojas"},
    {label:"Saldos pendientes de pago a socios", campo:"socios", nivel:2, editable:"socios", nota:"Cualquier otro saldo pendiente (doble clic en un mes si hubiera algo)"},
    {label:"TOTAL PATRIMONIO NETO Y PASIVO (A + B + C)", campo:"pnPasivo", total:true},
  ];

  const thBase={padding:"6px 4px",textAlign:"right",fontSize:10,fontWeight:700,whiteSpace:"nowrap"};
  function Tabla({titulo,filas}){
    return(
      <div style={{border:"1.5px solid #ECEEF2",borderRadius:10,overflow:"hidden",background:"#1F232B",marginBottom:14}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead>
              <tr style={{borderBottom:"1.5px solid #ECEEF2",background:"#3A414D"}}>
                <th style={{...thBase,textAlign:"left",position:"sticky",left:0,background:"#3A414D",color:"#FFF",minWidth:290,padding:"7px 10px",letterSpacing:"0"}}>{titulo}</th>
                {COLS.map((c,i)=>{
                  const sel=!futuro(c.m)&&c.m===mesSel&&c.tipo!=="total"&&(c.tipo==="mes"||c.m===mesSel);
                  return(
                    <th key={i} onClick={futuro(c.m)?undefined:()=>setMesSel(c.m)} title={futuro(c.m)?"":"Ver el balance a esta fecha"}
                      style={{...thBase,minWidth:c.tipo==="mes"?52:60,cursor:futuro(c.m)?"default":"pointer",
                        background:sel&&c.tipo==="mes"?"#453B11":c.tipo==="mes"?"#1F2937":"#3A414D",
                        color:sel&&c.tipo==="mes"?"#ECEEF2":futuro(c.m)?"#9AA1AC":"#FFF",
                        borderLeft:c.tipo!=="mes"?"1px solid #4B5563":"none"}}>
                      {c.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filas.map((f,ri)=>{
                const vacia=!f.campo;
                const clic=!!f.det;
                const bg=f.total?"#ECEEF2":f.nivel===0?"#2E343E":abierta===f.det&&clic?"#453B11":"#1F232B";
                const color=f.total?"#1F232B":vacia?"#969CA6":"#ECEEF2";
                return(
                  <tr key={ri} onClick={clic?()=>setAbierta(abierta===f.det?null:f.det):undefined}
                    style={{cursor:clic?"pointer":"default",background:bg,borderBottom:f.nivel===0||f.total?"1px solid #ECEEF2":"1px solid #2E343E"}}>
                    <td title={f.nota||""} style={{padding:"5px 10px",paddingLeft:f.nivel===2?30:f.nivel===1?18:10,textAlign:"left",whiteSpace:"nowrap",position:"sticky",left:0,background:bg,
                      borderRight:"1.5px solid #ECEEF2",fontWeight:f.total||f.nivel===0?800:f.nivel===1?700:500,color,fontSize:f.total?11.5:11}}>
                      {clic&&<span style={{color:"#7F8692",fontSize:9,marginRight:5}}>{abierta===f.det?"▼":"▸"}</span>}
                      {f.label}
                      {f.editable&&<span style={{color:"#7F8692",fontSize:9,marginLeft:5}}>✎</span>}
                      {f.nota&&!f.editable&&<span style={{color:"#5C6370",fontSize:9,marginLeft:5}}>ⓘ</span>}
                    </td>
                    {COLS.map((c,i)=>{
                      const v=f.campo?valor(c,f.campo):undefined;
                      const sel=c.tipo==="mes"&&c.m===mesSel;
                      return(
                        <td key={i} onDoubleClick={f.editable&&c.tipo==="mes"&&!futuro(c.m)?()=>editarManual(f.editable,c.m,f.label):undefined}
                          style={{padding:"5px 4px",textAlign:"right",fontVariantNumeric:"tabular-nums",
                            background:f.total?undefined:sel?"#453B11":c.tipo==="mes"?"#232831":c.tipo==="total"?"#262B34":undefined,
                            borderLeft:c.tipo!=="mes"?`1px solid ${f.total?"#4B5563":"#3A414D"}`:"none",
                            fontWeight:f.total||f.nivel===0||c.tipo!=="mes"?800:500,
                            color:f.total?"#FFF":v<0?"#EC8383":color,
                            cursor:f.editable&&c.tipo==="mes"&&!futuro(c.m)?"cell":undefined}}>
                          {fmt(v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  function exportar(){
    const fecha=hoy.toLocaleDateString("es-ES",{day:"2-digit",month:"long",year:"numeric"});
    const head=COLS.map(c=>`<th class="${c.tipo}">${c.label}</th>`).join("");
    const tabla=(titulo,filas)=>`<table><thead><tr><th class="lbl">${titulo}</th>${head}</tr></thead><tbody>${filas.map(f=>{
      const cls=f.total?"tot":f.nivel===0?"n0":f.nivel===1?"n1":"n2";
      return `<tr class="${cls}"><td class="lbl">${f.label}</td>${COLS.map(c=>{ const v=f.campo?valor(c,f.campo):undefined; return `<td class="${c.tipo}">${fmt(v)}</td>`; }).join("")}</tr>`;
    }).join("")}</tbody></table>`;
    const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${EMPRESA} — Balance de situación ${year}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:8.5px;color:#ECEEF2;padding:16px 20px}
.hdr{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2.5px solid #ECEEF2;padding-bottom:8px;margin-bottom:12px}
.brand{font-size:22px;font-weight:900;letter-spacing:-1px}.sub{font-size:8px;color:#9AA1AC;margin-top:3px}h1{font-size:14px;text-align:right}
table{width:100%;border-collapse:collapse;border:1.5px solid #ECEEF2;margin-bottom:12px}th{font-size:8px;padding:3px;background:#3A414D;color:#FFF;text-align:right}
td{padding:3px;text-align:right;font-variant-numeric:tabular-nums}td.lbl,th.lbl{text-align:left;white-space:nowrap;padding-left:6px;border-right:1.5px solid #ECEEF2}
td.mes{background:#232831}td.tri,td.total{font-weight:700;border-left:1px solid #5C6370}
tr.n0 td{background:#2E343E;font-weight:800;border-bottom:1px solid #ECEEF2}tr.n1 td.lbl{padding-left:12px;font-weight:700}tr.n2 td.lbl{padding-left:22px}
tr.tot td{background:#3A414D;color:#FFF;font-weight:800}
.foot{margin-top:6px;font-size:7.5px;color:#9AA1AC}@media print{@page{size:A4 landscape;margin:8mm}}</style></head><body>
<div class="hdr"><div><div class="brand">${EMPRESA}</div><div class="sub">${EMPRESA_SUB}</div></div><div><h1>Balance de situación ${year}</h1><div class="sub" style="text-align:right">Saldos a fin de cada mes · generado el ${fecha}</div></div></div>
${tabla("ACTIVO",ACTIVO)}${tabla("PATRIMONIO NETO Y PASIVO",PASIVO)}
<div class="foot">Importes en euros. Clientes y proveedores por el total de la factura (con IVA). El trimestre y el año muestran el saldo al cierre. Resultado del ejercicio anterior = resultado neto de la cuenta de resultados de ${year-1}.</div></body></html>`;
    const win=window.open("","_blank"); win.document.write(html); win.document.close(); win.focus(); setTimeout(()=>win.print(),500);
  }

  const detalle=abierta&&S.detalle[abierta];
  const DET={clientes:"Clientes pendientes de cobro",proveedores:"Proveedores pendientes de pago",hojas:"Hojas de gasto pendientes de pago"};

  return(
    <div>
      <style>{`@keyframes bleskPulse{0%{box-shadow:0 0 0 0 rgba(5,150,105,.5)}70%{box-shadow:0 0 0 6px rgba(5,150,105,0)}100%{box-shadow:0 0 0 0 rgba(5,150,105,0)}}`}</style>
      {showLock&&<EditLockModal onUnlock={onUnlock} onClose={()=>setShowLock(false)}/>}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontWeight:800,fontSize:17,color:"#ECEEF2",display:"flex",alignItems:"center",gap:10}}>⚖️ Balance de situación {year}
            <span style={{display:"inline-flex",alignItems:"center",gap:5,background:"#11452D",color:"#047857",borderRadius:99,padding:"2px 9px",fontSize:9.5,fontWeight:700}}>
              <span style={{width:6,height:6,borderRadius:99,background:"#059669",animation:"bleskPulse 1.8s infinite"}}/> En directo
            </span>
          </div>
          <div style={{fontSize:11,color:"#9AA1AC",marginTop:2}}>Se rellena solo con las facturas, hojas de gasto, el banco y la cuenta de resultados · foto a fin de cada mes · pincha en un mes de la cabecera para ver el balance a esa fecha · clic en una partida con ▸ para ver el detalle</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <select value={year} onChange={e=>setYear(+e.target.value)} style={{border:"1px solid #2E343E",borderRadius:8,padding:"6px 10px",fontSize:11,fontFamily:"inherit",fontWeight:700,background:"#1F232B"}}>
            {(todosYears.length?todosYears:[year]).map(y=><option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={exportar} style={{background:"#262B34",color:"#C3C8D0",border:"1px solid #2E343E",borderRadius:8,padding:"7px 14px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>⬇ Exportar PDF</button>
        </div>
      </div>

      <div style={{fontSize:11,fontWeight:700,color:"#C3C8D0",marginBottom:6}}>📅 A {fechaSel}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:8,marginBottom:14}}>
        {[
          {l:"Total activo",v:eur2(S.activo),c:"#D5D9E0",bg:"#112845"},
          {l:"Patrimonio neto",v:eur2(S.fondos),c:S.fondos>=0?"#059669":"#B91C1C",bg:S.fondos>=0?"#11452D":"#451111"},
          {l:"Pasivo",v:eur2(S.pasivoCorriente),c:"#B45309",bg:"#453B11"},
        ].map(k=>(
          <div key={k.l} style={{background:k.bg,borderRadius:10,padding:"11px 14px"}}>
            <div style={{fontSize:9,color:k.c,fontWeight:700,letterSpacing:"0",marginBottom:3}}>{k.l}</div>
            <div style={{fontSize:k.v.length>14?14:19,fontWeight:800,color:k.c,letterSpacing:"-.5px"}}>{k.v}</div>
            {k.sub&&<div style={{fontSize:9,color:"#9AA1AC",marginTop:3,lineHeight:1.4}}>{k.sub}</div>}
          </div>
        ))}
      </div>

      <Tabla titulo="ACTIVO" filas={ACTIVO}/>
      <Tabla titulo="PATRIMONIO NETO Y PASIVO" filas={PASIVO}/>

      {detalle&&(
        <div style={{marginBottom:12,border:"1px solid #7A681F",borderRadius:12,background:"#453B11",padding:"12px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontWeight:700,fontSize:12,color:"#ECEEF2"}}>{DET[abierta]} a {fechaSel} · {detalle.length} · {eur2(detalle.reduce((s,d)=>s+d.pendiente,0))}</div>
            <button onClick={()=>setAbierta(null)} style={{background:"none",border:"none",color:"#7F8692",cursor:"pointer",fontSize:14}}>✕</button>
          </div>
          {detalle.length===0?<div style={{fontSize:11,color:"#9AA1AC"}}>Nada pendiente a esa fecha 🎉</div>:(
          <div style={{maxHeight:300,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <tbody>
                {[...detalle].sort((a,b)=>a.t-b.t).map((d,i)=>(
                  <tr key={i} style={{borderTop:"1px solid #7A681F"}}>
                    <td style={{padding:"4px 6px",color:"#9AA1AC",whiteSpace:"nowrap",width:80}}>{d.r.fecha}</td>
                    <td style={{padding:"4px 6px",color:"#ECEEF2"}}>{d.kind==="hoja"?`HG · ${d.r.responsable||"Sin responsable"}`:`${d.r.ref||"s/ref"} · ${d.r.descripcion||""}`}</td>
                    <td style={{padding:"4px 6px",color:"#9AA1AC",fontSize:10}}>{d.pago===Infinity?"sin cobrar / pagar":`saldada el ${new Date(d.pago).toLocaleDateString("es-ES")}`}</td>
                    <td style={{padding:"4px 6px",textAlign:"right",fontWeight:700,whiteSpace:"nowrap"}}>{eur2(d.pendiente)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>)}
        </div>
      )}

      <div style={{fontSize:10,color:"#7F8692",lineHeight:1.6}}>
        Cada columna es la foto a fin de mes; 1T–4T y {year} muestran el saldo al cierre del trimestre / del año (o de hoy si es el año en curso).
        Clientes pendientes de cobro = facturas emitidas sin cobrar a esa fecha · Proveedores pendientes de pago = facturas recibidas sin pagar · Hojas de gasto pendientes = hojas sin pagar ·
        Cuenta corriente = saldo del banco · Caja = dinero en mano (doble clic para ponerlo) · Resultado antes de impuestos = cuenta de resultados de {year} hasta esa fecha ·
        Resultado del ejercicio anterior = resultado neto de la cuenta de resultados de {year-1} · IVA pendiente de cobro / de pago = IVA de las facturas recibidas / emitidas del año, menos lo ya liquidado con Hacienda por los trimestres del año (lo revisáis con la asesoría).
      </div>
    </div>
  );
}

// ── FINANZAS TAB ──────────────────────────────────────────────────────────────
function FinanzasTab({ing,setIng,gas,setGas,hojas,setHojas,projects,diamante,setDiamante,sb}){
  const [sub,setSub]=useState("ingresos");
  const [bancoMovs,setBancoMovs]=useState(null);
  const [bancoPend,setBancoPend]=useState(null);
  // Movimientos del banco: se recargan al cambiar de apartado (Banco los carga él mismo y los devuelve por onMovs)
  useEffect(()=>{ if(sub!=="banco") bancoLoad().then(setBancoMovs).catch(()=>setBancoMovs(m=>m||[])); },[sub]);
  function guardarBanco(next){
    setBancoMovs(next);
    bancoSave(next).catch(err=>{ console.error("❌ banco save",err); alert("Error guardando: "+err.message); });
  }
  const otros=otrosDeBanco(bancoMovs||[]);
  // Rectificativas: a qué factura rectifica cada FRC
  const [rect,setRect]=useState({});
  const [rectOk,setRectOk]=useState(false);
  useEffect(()=>{ rectLoad().then(r=>{ setRect(r); setRectOk(true); }).catch(()=>{}); saldadasLoad().then(m=>{ setSaldadas(m); setSaldadasOk(true); }).catch(()=>{}); },[sub]);
  // Cobradas/pagadas a mano (fuera del banco o ya saldadas)
  const [saldadas,setSaldadas]=useState({});
  const [saldadasOk,setSaldadasOk]=useState(false);
  // Cuadre inicial (13/10/2026, una sola vez): todas las facturas de ingreso sin conciliar quedan cobradas,
  // menos la (cliente), que siguen pendientes de cobro.
  // Ajustes puntuales que se hicieron una vez sobre los datos de la empresa original: desactivados en la plantilla
  const CUADRES_PUNTUALES=false;
  const CUADRE_ING="__cuadre_ingresos_2026_10_13";
  const CUADRE_HOJAS="__cuadre_hojas_2026_10_13";
  // Corrección: la excepción era (cliente), no (cliente) (si el primer cuadre ya se había hecho)
  const CUADRE_FIX="__cuadre_ingresos_fix_ocharan";
  useEffect(()=>{
    if(!CUADRES_PUNTUALES) return;
    if(!saldadasOk||!bancoMovs||!(ing||[]).length||!saldadas[CUADRE_ING]||saldadas[CUADRE_FIX]) return;
    const info=conciliacionInfo(bancoMovs,ing,gas,hojas,rect,saldadas);
    const norm=x=>String(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
    const txt=r=>norm(`${r.descripcion||""} ${r.ref||""}`);
    const ultimaExcepcion=[...ing].filter(r=>/(?!)/.test(norm(r.descripcion))).sort((a,b)=>bancoTs(b.fecha)-bancoTs(a.fecha))[0];
    const hoy=new Date().toISOString().slice(0,10);
    setSaldadas(prev=>{
      const m={...prev,[CUADRE_FIX]:{nota:"hecho",fecha:hoy}};
      ing.forEach(r=>{
        const k=`ing:${r.id}`;
        const esCuadre=(m[k]?.nota||"").includes("cuadre 13/10/2026");
        if((/(?!)/.test(txt(r))||r.id===ultimaExcepcion?.id)&&esCuadre) delete m[k];   // (cliente): pendientes
        else if(!m[k]){ const e=estadoPago(info,k,r.fecha,r.pagado); if(e==="no"||e==="fuera") m[k]={nota:"Cobrada (cuadre 13/10/2026)",fecha:hoy}; } // (cliente) y el resto: cobradas
      });
      saldadasSave(m).catch(err=>console.error("❌ corrección cuadre",err));
      return m;
    });
  },[saldadasOk,bancoMovs,ing,saldadas[CUADRE_ING]]);
  const CUADRE_GAS="__cuadre_gastos_2026_10_13";
  const CUADRE_FIX2="__cuadre_fix2_ocharan_isora";
  useEffect(()=>{
    if(!CUADRES_PUNTUALES) return;
    // Después del cuadre del banco, para no pisar sus cambios
    if(sub==="banco"||!saldadasOk||!rectOk||!bancoMovs||!(ing||[]).length||saldadas[CUADRE_FIX2]||!saldadas["__cuadre_banco_2026_10_13"]) return;
    const norm=x=>String(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
    const ocharan=ing.filter(r=>/(?!)/.test(norm(`${r.descripcion||""} ${r.ref||""}`)));
    const ultimaExcepcion=[...ing].filter(r=>/(?!)/.test(norm(r.descripcion))).sort((a,b)=>bancoTs(b.fecha)-bancoTs(a.fecha))[0];
    const pendientes=new Set([...ocharan,...(ultimaExcepcion?[ultimaExcepcion]:[])].map(r=>`ing:${r.id}`));
    const {itemByKey,anuladas}=conciliables(ing,gas,hojas,rect,saldadas);
    const usados=new Set(bancoMovs.flatMap(movKeys));
    let cambios=0;
    const next=bancoMovs.map(m=>{
      const ks=movKeys(m); if(!ks.some(k=>pendientes.has(k))) return m;
      const nuevas=ks.map(k=>{
        if(!pendientes.has(k)) return k;
        const imp=itemByKey[k]?importeBanco(itemByKey[k]):null;
        // la otra factura con el mismo importe que no esté ya conciliada
        const gemela=Object.values(itemByKey).filter(x=>x.kind==="ing"&&!pendientes.has(x.key)&&!usados.has(x.key)&&!anuladas.has(x.key)&&imp!==null&&Math.abs(importeBanco(x)-imp)<0.02)
          .sort((a,b)=>bancoTs(a.r.fecha)-bancoTs(b.r.fecha))[0];
        cambios++;
        if(gemela){ usados.add(gemela.key); return gemela.key; }
        return null;
      }).filter(Boolean);
      return {...m,matches:nuevas,match:undefined,auto:false};
    });
    console.log(`✅ (cliente) pendientes: ${cambios} asociaciones del banco corregidas`);
    if(cambios) guardarBanco(next);
    setSaldadas(prev=>{
      const m={...prev,[CUADRE_FIX2]:{nota:`${cambios} cambios`,fecha:new Date().toISOString().slice(0,10)}};
      pendientes.forEach(k=>{ delete m[k]; });
      saldadasSave(m).catch(()=>{});
      return m;
    });
  },[sub,saldadasOk,rectOk,bancoMovs,ing,!!saldadas["__cuadre_banco_2026_10_13"]]);
  // Las facturas/hojas que el cuadre dio por cobradas/pagadas a mano se enlazan con los ajustes del cuadre del banco
  // (entradas/salidas que se quedaron como "sin factura") cuando los importes casan: así quedan conciliadas como las demás
  // y el ajuste deja de contar otra vez como ingreso/gasto.
  const CUADRE_LINK="__cuadre_link_manuales_v1";
  useEffect(()=>{
    if(!CUADRES_PUNTUALES) return;
    if(sub==="banco"||!saldadasOk||!rectOk||!bancoMovs||!bancoMovs.length||!(ing||[]).length||saldadas[CUADRE_LINK]||!saldadas[CUADRE_FIX2]) return;
    const {itemByKey}=conciliables(ing,gas,hojas,rect,saldadas);
    const conc=new Set(bancoMovs.filter(m=>bancoEstado(m,itemByKey).ok).flatMap(movKeys));
    const libres=Object.keys(saldadas).filter(k=>/cuadre 13\/10\/2026/.test(saldadas[k]?.nota||"")&&itemByKey[k]&&!conc.has(k)).map(k=>itemByKey[k]);
    const usados=new Set();
    const esAjuste=n=>/\(cuadre \d/.test(n||"");
    let enlazadas=0, movsCambiados=0;
    const orden=[...bancoMovs].sort((a,b)=>bancoTs(a.fecha)-bancoTs(b.fecha));
    const porId={};
    orden.forEach(m=>{
      const entero=movOtro(m)&&esAjuste(m.nota);
      const parcial=!movOtro(m)&&m.just&&esAjuste(m.just.nota);
      if(!entero&&!parcial) return;
      const objetivo=entero?m.importe:m.just.importe;
      const tm=bancoTs(m.fecha);
      const cands=libres.filter(i=>!usados.has(i.key)&&Math.sign(importeBanco(i))===Math.sign(objetivo)
        &&bancoTs(i.r.fecha)<=tm+5*864e5&&bancoTs(i.r.fecha)>=tm-150*864e5);
      if(!cands.length) return;
      const idx=buscarCombinacion(objetivo,cands.map(importeBanco),6);
      if(!idx) return;
      const keys=idx.map(i=>cands[i].key);
      keys.forEach(k=>usados.add(k));
      enlazadas+=keys.length; movsCambiados++;
      if(entero){ const {nota,categoria,proyecto,persona,partida,...r}=m; porId[m.id]={...r,otro:false,match:undefined,matches:keys,auto:false}; }
      else { const {just,...r}=m; porId[m.id]={...r,matches:[...movKeys(m),...keys],match:undefined,auto:false}; }
    });
    console.log(`✅ Enlazadas con el banco ${enlazadas} facturas/hojas del cuadre (${movsCambiados} movimientos)`);
    if(movsCambiados) guardarBanco(bancoMovs.map(m=>porId[m.id]||m));
    setSaldadas(prev=>{ const n={...prev,[CUADRE_LINK]:{nota:`${enlazadas} enlazadas en ${movsCambiados} movimientos`,fecha:new Date().toISOString().slice(0,10)}}; saldadasSave(n).catch(()=>{}); return n; });
  },[sub,saldadasOk,rectOk,bancoMovs,ing,!!saldadas[CUADRE_FIX2]]);
  // Movimientos del banco sin conciliar que corresponden a facturas/hojas ya marcadas a mano como cobradas/pagadas
  // (cuadre): se enlazan solos cuando el importe casa, así quedan conciliados y la factura pasa a "conciliada en el banco".
  useEffect(()=>{
    if(sub==="banco"||!saldadasOk||!rectOk||!bancoMovs||!bancoMovs.length||!(ing||[]).length) return;
    const {itemByKey}=conciliables(ing,gas,hojas,rect,saldadas);
    const conc=new Set(bancoMovs.flatMap(movKeys));
    const libres=Object.keys(saldadas).filter(k=>!k.startsWith("__")&&itemByKey[k]&&!conc.has(k)).map(k=>itemByKey[k]);
    if(!libres.length) return;
    const usados=new Set();
    const porId={};
    const numsConcepto=txt=>{ const out=[]; const re=/(\d{1,4})\s*\/\s*(\d{1,4})/g; let x; while((x=re.exec(String(txt||"")))){ out.push(`${x[1]}/${x[2]}`,`${x[2]}/${x[1]}`); } return out; };
    const numRef=r=>{ const x=String(r.ref||"").match(/(\d{4})\/(\d+)$/); return x?`${x[1]}/${parseInt(x[2])}`:null; };
    [...bancoMovs].sort((a,b)=>bancoTs(a.fecha)-bancoTs(b.fecha)).forEach(m=>{
      if(movOtro(m)||movEspera(m)||movKeys(m).length||m.just||bancoEstado(m,itemByKey).ok) return;
      const tm=bancoTs(m.fecha);
      const cands=libres.filter(i=>!usados.has(i.key)&&Math.sign(importeBanco(i))===Math.sign(m.importe)&&bancoTs(i.r.fecha)<=tm+5*864e5);
      if(!cands.length) return;
      const nums=numsConcepto(m.concepto).map(t=>{ const [a,b]=t.split("/"); return `${a}/${parseInt(b)}`; });
      const exactos=cands.filter(i=>Math.abs(importeBanco(i)-m.importe)<0.02)
        .sort((a,b)=>(nums.includes(numRef(b.r))-nums.includes(numRef(a.r)))||(bancoTs(b.r.fecha)-bancoTs(a.r.fecha)));
      let keys=null;
      if(exactos.length) keys=[exactos[0].key];
      else { const idx=buscarCombinacion(m.importe,cands.map(importeBanco),4); if(idx) keys=idx.map(i=>cands[i].key); }
      if(!keys) return;
      keys.forEach(k=>usados.add(k));
      porId[m.id]={...m,matches:keys,match:undefined,auto:true};
    });
    const n=Object.keys(porId).length;
    if(!n) return;
    console.log(`✅ ${n} movimientos del banco enlazados con facturas/hojas ya marcadas como cobradas/pagadas`);
    guardarBanco(bancoMovs.map(m=>porId[m.id]||m));
  },[sub,saldadasOk,rectOk,bancoMovs,ing,gas,hojas,saldadas]);
  // 21/10/2026 (una sola vez): los cobros/pagos del banco que quedan sin conciliar son de facturas ya cobradas/pagadas:
  // se enlazan con la factura marcada a mano si el importe casa; si no, se cierran como "cobro de factura ya contada"
  // (no computa: la factura ya está en la cuenta de resultados)
  const CUADRE_BANCO2="__cuadre_banco_2026_10_21";
  useEffect(()=>{
    if(!CUADRES_PUNTUALES) return;
    if(sub==="banco"||!saldadasOk||!rectOk||!bancoMovs||!bancoMovs.length||!(ing||[]).length||saldadas[CUADRE_BANCO2]||!saldadas[CUADRE_FIX2]) return;
    const {itemByKey}=conciliables(ing,gas,hojas,rect,saldadas);
    const conc=new Set(bancoMovs.flatMap(movKeys));
    const libres=Object.keys(saldadas).filter(k=>!k.startsWith("__")&&itemByKey[k]&&!conc.has(k)).map(k=>itemByKey[k]);
    const usados=new Set();
    let enlazados=0, cerrados=0;
    const next=bancoMovs.map(m=>{
      if(movOtro(m)||movEspera(m)||movKeys(m).length||m.just||bancoEstado(m,itemByKey).ok) return m;
      const ex=libres.find(i=>!usados.has(i.key)&&Math.abs(importeBanco(i)-m.importe)<0.02&&bancoTs(i.r.fecha)<=bancoTs(m.fecha)+5*864e5);
      if(ex){ usados.add(ex.key); enlazados++; return {...m,matches:[ex.key],match:undefined,auto:true}; }
      cerrados++;
      return {...m,otro:true,matches:[],match:undefined,categoria:"yacontado",catManual:true,
        nota:m.importe>0?"Cobro de factura ya marcada como cobrada — cuadre 21/10/2026":"Pago de factura/hoja ya marcada como pagada — cuadre 21/10/2026"};
    });
    console.log(`✅ Cuadre del banco 21/10: ${enlazados} enlazados con su factura, ${cerrados} cerrados como cobro/pago de factura ya contada`);
    if(enlazados||cerrados) guardarBanco(next);
    setSaldadas(prev=>{ const n={...prev,[CUADRE_BANCO2]:{nota:`${enlazados} enlazados, ${cerrados} cerrados`,fecha:new Date().toISOString().slice(0,10)}}; saldadasSave(n).catch(()=>{}); return n; });
  },[sub,saldadasOk,rectOk,bancoMovs,ing,!!saldadas[CUADRE_FIX2]]);
  // 21/10/2026 (una sola vez): lo que sale "antes del extracto" está cobrado/pagado y cuadrado
  // (menos la factura de (cliente) pendiente y la última de (cliente))
  const CUADRE_FUERA="__cuadre_fuera_2026_10_21";
  useEffect(()=>{
    if(!CUADRES_PUNTUALES) return;
    if(!saldadasOk||!bancoMovs||!bancoMovs.length||!(ing||[]).length||saldadas[CUADRE_FUERA]||!saldadas[CUADRE_FIX2]) return;
    const info=conciliacionInfo(bancoMovs,ing,gas,hojas,rect,saldadas);
    const norm=x=>String(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
    const ultima=re=>[...ing].filter(r=>re.test(norm(`${r.descripcion||""} ${r.ref||""}`))).sort((a,b)=>bancoTs(b.fecha)-bancoTs(a.fecha))[0];
    const excluir=new Set([ultima(/(?!)/),ultima(/(?!)/)].filter(Boolean).map(r=>`ing:${r.id}`));
    const hoy=new Date().toISOString().slice(0,10);
    const n={};
    [["ing",ing,"Cobrada"],["gas",gas,"Pagada"],["hoja",hojas,"Pagada"]].forEach(([pref,lista,txt])=>(lista||[]).forEach(r=>{
      const k=`${pref}:${r.id}`;
      if(excluir.has(k)) return;
      if(estadoPago(info,k,r.fecha,r.pagado)==="fuera") n[k]={nota:`${txt} (cuadre 21/10/2026, antes del extracto)`,fecha:hoy};
    }));
    console.log(`✅ Antes del extracto: ${Object.keys(n).length} marcadas como cobradas/pagadas`, Object.keys(n));
    setSaldadas(prev=>{ const m={...n,...prev,[CUADRE_FUERA]:{nota:`${Object.keys(n).length} marcadas`,fecha:hoy}}; saldadasSave(m).catch(err=>console.error("❌ cuadre fuera",err)); return m; });
  },[saldadasOk,bancoMovs,ing,gas,hojas,!!saldadas[CUADRE_FIX2]]);
  const CUADRE_BANCO="__cuadre_banco_2026_10_13";
  useEffect(()=>{
    if(!CUADRES_PUNTUALES) return;
    if(sub==="banco"||!saldadasOk||!rectOk||!bancoMovs||!bancoMovs.length||!(ing||[]).length||saldadas[CUADRE_BANCO]) return;
    const {itemByKey}=conciliables(ing,gas,hojas,rect,saldadas);
    const {plan,next}=planCuadre(bancoMovs,itemByKey);
    console.log(`✅ Cuadre inicial del banco: ${plan.length} movimientos cerrados`, plan.map(p=>p.txt));
    if(plan.length) guardarBanco(next);
    setSaldadas(prev=>{ const m={...prev,[CUADRE_BANCO]:{nota:`${plan.length} movimientos`,fecha:new Date().toISOString().slice(0,10)}}; saldadasSave(m).catch(()=>{}); return m; });
  },[sub,saldadasOk,rectOk,bancoMovs,ing]);
  // Cuadre inicial de facturas de gasto (13/10/2026, una sola vez): todas las que no estén conciliadas quedan pagadas
  useEffect(()=>{
    if(!CUADRES_PUNTUALES) return;
    if(!saldadasOk||!bancoMovs||!(gas||[]).length||saldadas[CUADRE_GAS]) return;
    const info=conciliacionInfo(bancoMovs,ing,gas,hojas,rect,saldadas);
    const hoy=new Date().toISOString().slice(0,10);
    const n={[CUADRE_GAS]:{nota:"cuadre inicial hecho",fecha:hoy}};
    let marcadas=0;
    gas.forEach(r=>{
      const k=`gas:${r.id}`, e=estadoPago(info,k,r.fecha,r.pagado);
      if(e==="no"||e==="fuera"){ n[k]={nota:"Pagada (cuadre 13/10/2026)",fecha:hoy}; marcadas++; }
    });
    console.log(`✅ Cuadre inicial de gastos: ${marcadas} marcadas como pagadas`);
    setSaldadas(prev=>{ const m={...n,...prev,[CUADRE_GAS]:n[CUADRE_GAS]}; saldadasSave(m).catch(err=>console.error("❌ cuadre gastos",err)); return m; });
  },[saldadasOk,bancoMovs,gas]);
  // Cuadre inicial de hojas de gasto (13/10/2026, una sola vez): todas las que no estén conciliadas quedan pagadas
  useEffect(()=>{
    if(!CUADRES_PUNTUALES) return;
    if(!saldadasOk||!bancoMovs||!(hojas||[]).length||saldadas[CUADRE_HOJAS]) return;
    const info=conciliacionInfo(bancoMovs,ing,gas,hojas,rect,saldadas);
    const hoy=new Date().toISOString().slice(0,10);
    const n={...saldadas,[CUADRE_HOJAS]:{nota:"cuadre inicial hecho",fecha:hoy}};
    let marcadas=0;
    hojas.forEach(r=>{
      const k=`hoja:${r.id}`, e=estadoPago(info,k,r.fecha,r.pagado);
      if(e==="no"||e==="fuera"){ n[k]={nota:"Pagada (cuadre 13/10/2026)",fecha:hoy}; marcadas++; }
    });
    console.log(`✅ Cuadre inicial de hojas: ${marcadas} marcadas como pagadas`);
    // Se fusiona con lo último guardado para no pisar el cuadre de ingresos si va a la vez
    setSaldadas(prev=>{ const m={...n,...prev,[CUADRE_HOJAS]:n[CUADRE_HOJAS]}; Object.keys(n).forEach(k=>{ if(!prev[k]) m[k]=n[k]; }); saldadasSave(m).catch(err=>console.error("❌ cuadre hojas",err)); return m; });
  },[saldadasOk,bancoMovs,hojas,saldadas[CUADRE_ING]]);
  useEffect(()=>{
    if(!CUADRES_PUNTUALES) return;
    if(!saldadasOk||!bancoMovs||!(ing||[]).length||saldadas[CUADRE_ING]) return;
    const info=conciliacionInfo(bancoMovs,ing,gas,hojas,rect,saldadas);
    const norm=x=>String(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
    const esPendiente=r=>/(?!)/.test(norm(`${r.descripcion||""} ${r.ref||""}`)); // (cliente)
    const ultimaExcepcion=[...ing].filter(r=>/(?!)/.test(norm(r.descripcion))).sort((a,b)=>bancoTs(b.fecha)-bancoTs(a.fecha))[0];
    const hoy=new Date().toISOString().slice(0,10);
    const n={...saldadas,[CUADRE_ING]:{nota:"cuadre inicial hecho",fecha:hoy}};
    let marcadas=0;
    ing.forEach(r=>{
      const k=`ing:${r.id}`, e=estadoPago(info,k,r.fecha,r.pagado);
      if((e==="no"||e==="fuera")&&!esPendiente(r)&&r.id!==ultimaExcepcion?.id){ n[k]={nota:"Cobrada (cuadre 13/10/2026)",fecha:hoy}; marcadas++; }
    });
    console.log(`✅ Cuadre inicial de ingresos: ${marcadas} marcadas como cobradas`);
    setSaldadas(prev=>{ const m={...n,...prev,[CUADRE_ING]:n[CUADRE_ING]}; Object.keys(n).forEach(k=>{ if(!prev[k]) m[k]=n[k]; }); saldadasSave(m).catch(err=>console.error("❌ cuadre inicial",err)); return m; });
  },[saldadasOk,bancoMovs,ing]);
  const ultimaNota=useRef("");
  function toggleSaldada(key,etiqueta){
    if(saldadas[key]){
      if(!window.confirm(`¿Quitar la marca "saldada a mano" de ${etiqueta}?`)) return;
      setSaldadas(prev=>{ const n={...prev}; delete n[key]; saldadasSave(n).catch(err=>alert("Error guardando: "+err.message)); return n; });
      return;
    }
    const nota=window.prompt(`Marcar ${etiqueta} como saldada a mano.\nMotivo (efectivo, compensada, cobrada antes del extracto…):`,ultimaNota.current||"");
    if(nota===null) return;
    ultimaNota.current=nota;
    setSaldadas(prev=>{ const n={...prev,[key]:{nota:nota.trim(),fecha:new Date().toISOString().slice(0,10)}}; saldadasSave(n).catch(err=>alert("Error guardando: "+err.message)); return n; });
  }
  function enlazarRect(frcId,origId){
    setRect(prev=>{
      const n={...prev};
      if(origId) n[String(frcId)]=String(origId); else delete n[String(frcId)];
      rectSave(n).catch(err=>{ console.error("❌ rect save",err); alert("Error guardando la rectificativa: "+err.message); });
      return n;
    });
  }
  useEffect(()=>{
    if(!bancoMovs) return;
    const {itemByKey}=conciliables(ing,gas,hojas,rect,saldadas);
    setBancoPend(bancoMovs.filter(m=>!bancoEstado(m,itemByKey).ok&&!movEspera(m)).length);
    // El campo "pagado" de la BD sigue a la conciliación (lo usan Libros y otros informes):
    // conciliada → true; sin conciliar dentro del periodo del extracto → false; anterior al extracto → no se toca
    const info=conciliacionInfo(bancoMovs,ing,gas,hojas,rect,saldadas);
    const objetivo=(pref,r)=>{ const e=estadoPago(info,`${pref}:${r.id}`,r.fecha,r.pagado); return e==="fuera"?!!r.pagado:(e==="si"||e==="anulada"||e==="manual"); };
    const sync=(lista,set,pref)=>{ if((lista||[]).some(r=>!!r.pagado!==objetivo(pref,r))) set(l=>l.map(r=>!!r.pagado!==objetivo(pref,r)?{...r,pagado:objetivo(pref,r)}:r)); };
    sync(ing,setIng,"ing"); sync(gas,setGas,"gas"); sync(hojas,setHojas,"hoja");
  },[bancoMovs,ing,gas,hojas,rect,saldadas]);
  const pagoInfo=conciliacionInfo(bancoMovs,ing,gas,hojas,rect,saldadas);
  return(
    <div>
      <div style={{display:"flex",flexWrap:"wrap",gap:0,borderBottom:"1px solid #2E343E",marginBottom:20}}>
        {[
          {id:"ingresos", label:"💰 Ingresos"},
          {id:"gastos",   label:"💸 Gastos"},
          {id:"hojas",    label:"🧾 Hojas Gasto"},
          {id:"otros",    label:"🧾 Otros gastos"},
          {id:"banco",    label:bancoPend?`🏦 Banco (${bancoPend})`:"🏦 Banco"},
          {id:"diamante", label:"💎 Diamante Falkon"},
          {id:"previsiones", label:"📊 Previsiones"},
          {id:"resultados",  label:"📈 Cuenta de Resultados"},
          {id:"balance",     label:"⚖️ Balance"},
        ].map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)} style={{
            background:"transparent",color:sub===t.id?"#D5D9E0":"#9AA1AC",border:"none",
            borderBottom:sub===t.id?"2px solid #1C1C1E":"2px solid transparent",
            padding:"8px 14px",fontSize:11,fontWeight:sub===t.id?700:400,
            cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",
          }}>{t.label}</button>
        ))}
      </div>
      {sub==="ingresos"&&<FacturasTab   facturas={ing} setFacturas={setIng} tipo="ingresos" projects={projects} pagoInfo={pagoInfo} rect={rect} onRect={enlazarRect} onSaldada={toggleSaldada}/>}
      {sub==="gastos"  &&<FacturasTab   facturas={gas} setFacturas={setGas} tipo="gastos"   projects={projects} pagoInfo={pagoInfo} rect={rect} onRect={enlazarRect} onSaldada={toggleSaldada}/>}
      {sub==="hojas"   &&<HojasGastoTab hojas={hojas} setHojas={setHojas} gastos={gas} projects={projects} pagoInfo={pagoInfo} onSaldada={toggleSaldada}/>}
      {sub==="otros"   &&<OtrosGastosTab movs={bancoMovs} guardar={guardarBanco} projects={projects} irBanco={()=>setSub("banco")} ing={ing}/>}
      {sub==="banco"   &&<BancoTab      ing={ing} setIng={setIng} gas={gas} setGas={setGas} hojas={hojas} onPendientes={setBancoPend} onMovs={setBancoMovs} irOtros={()=>setSub("otros")} rect={rect} saldadas={saldadas}/>}
      {sub==="diamante"&&<DiamanteTab   ing={ing} gas={gas} hojas={hojas} projects={projects} diamante={diamante} setDiamante={setDiamante}/>}
      {sub==="previsiones"&&<PrevisionesTab ing={ing} gas={gas} hojas={hojas} projects={projects} sb={sb} otros={otros} banco={bancoMovs}/>}
      {sub==="resultados" &&<CuentaResultadosTab ing={ing} gas={gas} hojas={hojas} otros={otros} projects={projects} irBalance={()=>setSub("balance")}/>}
      {sub==="balance"    &&<BalanceTab ing={ing} gas={gas} hojas={hojas} otros={otros} banco={bancoMovs} rect={rect} saldadas={saldadas}/>}
    </div>
  );
}

// ── AUDITORIA TAB ─────────────────────────────────────────────────────────────
const AUDITORIA_DATA = [
  {id:"s1", title:"I. Ejemplo de bloque", items:[
    {id:"e1", text:"Ejemplo de tarea de la auditoría (cámbialo en el código)", urgent:true},
    {id:"e2", text:"Otra tarea de ejemplo"},
  ]},
];

const AUDITORIA_DIGITAL_DATA = [
  {id:"s1", title:"I. Ejemplo de bloque", items:[
    {id:"e1", text:"Ejemplo de tarea de la auditoría (cámbialo en el código)", urgent:true},
    {id:"e2", text:"Otra tarea de ejemplo"},
  ]},
];

const AUDITORIA_LEGAL_DATA = [
  {id:"s1", title:"I. Ejemplo de bloque", items:[
    {id:"e1", text:"Ejemplo de tarea de la auditoría (cámbialo en el código)", urgent:true},
    {id:"e2", text:"Otra tarea de ejemplo"},
  ]},
];

function AuditoriaChecklist({data, storageKey, label, onUpdate}){
  const [checked, setChecked] = useState({});
  const [assignees, setAssignees] = useState({}); // {itemId: [member1, member2]}
  const [open, setOpen] = useState({[data[0].id]:true});
  const [loaded, setLoaded] = useState(false);
  const assignKey = storageKey+"_assignees";

  // Load from Supabase on mount
  useEffect(()=>{
    Promise.all([
      sb.from("audit_progress").select("val").eq("key",storageKey).maybeSingle(),
      sb.from("audit_progress").select("val").eq("key",assignKey).maybeSingle(),
    ]).then(([{data:row},{data:arow}])=>{
      if(row?.val) setChecked(typeof row.val==="string"?JSON.parse(row.val):row.val);
      if(arow?.val) setAssignees(typeof arow.val==="string"?JSON.parse(arow.val):arow.val);
      setLoaded(true);
    }).catch(()=>setLoaded(true));
  },[storageKey]);

  function toggleAssignee(itemId, member){
    setAssignees(prev=>{
      const cur=prev[itemId]||[];
      const next={...prev,[itemId]:cur.includes(member)?cur.filter(m=>m!==member):[...cur,member]};
      sb.from("audit_progress").upsert({key:assignKey,val:next},{onConflict:"key"}).then();
      return next;
    });
  }

  function toggle(itemId){
    setChecked(prev=>{
      const next={...prev,[itemId]:!prev[itemId]};
      sb.from("audit_progress")
        .upsert({key:storageKey, val:next}, {onConflict:"key"})
        .then(({error})=>{ if(error) console.error("audit save error",storageKey,error); });
      if(onUpdate) onUpdate(storageKey,next);
      return next;
    });
  }

  function reset(){
    if(!window.confirm(`¿Reiniciar todos los tics de ${label}?`)) return;
    setChecked({});
    sb.from("audit_progress").upsert({key:storageKey, val:{}},{onConflict:"key"}).then();
    if(onUpdate) onUpdate(storageKey,{});
  }

  if(!loaded) return <div style={{padding:40,textAlign:"center",color:"#9AA1AC",fontSize:12}}>Cargando...</div>;

  const total=data.reduce((s,sec)=>s+sec.items.length,0);
  const done=data.reduce((s,sec)=>s+sec.items.filter(i=>checked[i.id]).length,0);
  const pct=total?Math.round(done/total*100):0;

  return(
    <div>
      <div style={{background:"#232831",borderRadius:12,border:"1px solid #2E343E",padding:"14px 18px",marginBottom:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <span style={{fontSize:11,fontWeight:600,color:"#ECEEF2"}}>{done} de {total} completados</span>
          <span style={{fontSize:13,fontWeight:700,color:pct===100?"#059669":"#D5D9E0"}}>{pct}%</span>
        </div>
        <div style={{height:6,background:"#1E2B38",borderRadius:99,overflow:"hidden"}}>
          <div style={{height:6,borderRadius:99,background:pct===100?"#059669":"#323844",width:`${pct}%`,transition:"width .4s"}}/>
        </div>
      </div>
      {data.map(sec=>{
        const secDone=sec.items.filter(i=>checked[i.id]).length;
        const isOpen=!!open[sec.id];
        return(
          <div key={sec.id} style={{marginBottom:10,borderRadius:12,overflow:"hidden",border:"1px solid #2E343E"}}>
            <div onClick={()=>setOpen(o=>({...o,[sec.id]:!o[sec.id]}))}
              style={{background:"#15181D",padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
              <span style={{fontWeight:600,fontSize:12,color:"#D5D9E0"}}>{sec.title}</span>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,
                  background:secDone===sec.items.length?"#11452B":"#1E2B38",
                  color:secDone===sec.items.length?"#059669":"#9AA1AC",
                  border:`1px solid ${secDone===sec.items.length?"#1F7A50":"#2E343E"}`
                }}>{secDone}/{sec.items.length}</span>
                <span style={{fontSize:10,color:"#9AA1AC"}}>{isOpen?"▲":"▼"}</span>
              </div>
            </div>
            {isOpen&&(
              <div style={{background:"#1F232B"}}>
                {sec.items.map((item,i)=>{
                  const itemAssignees = assignees[item.id]||[];
                  return(
                  <div key={item.id} style={{borderTop:i>0?"1px solid #635836":"none",background:checked[item.id]?"#232831":"#1F232B"}}>
                    <div onClick={()=>toggle(item.id)}
                      style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 16px",cursor:"pointer"}}>
                      <div style={{width:16,height:16,borderRadius:4,flexShrink:0,marginTop:1,
                        display:"flex",alignItems:"center",justifyContent:"center",
                        background:checked[item.id]?"#323844":"#1F232B",
                        border:`1.5px solid ${checked[item.id]?"#262B34":"#515048"}`,transition:"all .15s"}}>
                        {checked[item.id]&&<span style={{color:"#FFF",fontSize:9,fontWeight:900,lineHeight:1}}>✓</span>}
                      </div>
                      <div style={{flex:1}}>
                        <span style={{fontSize:12,color:checked[item.id]?"#9AA1AC":"#D5D9E0",
                          textDecoration:checked[item.id]?"line-through":"none",lineHeight:1.5}}>{item.text}</span>
                        <span style={{marginLeft:6}}>
                          {item.urgent&&<span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:4,background:"#451111",color:"#EC8383",marginRight:4}}>urgente</span>}
                          {item.key&&<span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:4,background:"#453B11",color:"#F3A97D"}}>clave</span>}
                        </span>
                      </div>
                    </div>
                    {/* Assignees */}
                    <div onClick={e=>e.stopPropagation()} style={{padding:"0 16px 8px 46px",display:"flex",flexWrap:"wrap",gap:4}}>
                      {INIT_MEMBERS.map(m=>{
                        const sel = itemAssignees.includes(m.name);
                        return(
                          <button key={m.name} onClick={()=>toggleAssignee(item.id,m.name)} style={{
                            background:sel?"#323844":"#1E2B38",color:sel?"#FFF":"#9AA1AC",
                            border:"none",borderRadius:99,padding:"2px 8px",fontSize:9,fontWeight:sel?700:400,
                            cursor:"pointer",fontFamily:"inherit",transition:"all .12s",
                          }}>{m.name}</button>
                        );
                      })}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <button onClick={reset} style={{marginTop:12,background:"none",border:"1px solid #2E343E",borderRadius:7,padding:"6px 14px",fontSize:11,color:"#9AA1AC",cursor:"pointer",fontFamily:"inherit"}}>
        Reiniciar todo
      </button>
    </div>
  );
}

function AuditoriaTab(){
  const [auditoria, setAuditoria] = useState("finanzas");
  const [progress, setProgress] = useState({});

  const AUDITORIAS = [
    {id:"finanzas", emoji:"💰", label:"Finanzas",  data:AUDITORIA_DATA,         storageKey:"blesk_audit",         fecha:"", resultado:""},
    {id:"digital",  emoji:"💻", label:"Digital",   data:AUDITORIA_DIGITAL_DATA,  storageKey:"blesk_audit_digital",  fecha:"", resultado:""},
    {id:"legal",    emoji:"⚖️", label:"Legal",     data:AUDITORIA_LEGAL_DATA,    storageKey:"blesk_audit_legal",    fecha:"", resultado:""},
  ];

  // Load all 3 progress states from Supabase
  useEffect(()=>{
    sb.from("audit_progress").select("key,val").in("key",AUDITORIAS.map(a=>a.storageKey))
      .then(({data:rows})=>{
        if(!rows) return;
        const p={};
        rows.forEach(r=>{ p[r.key]=r.val||{}; });
        setProgress(p);
      });
  },[]);

  const sel = AUDITORIAS.find(a=>a.id===auditoria);

  return(
    <div>
      <div style={{marginBottom:20}}>
        <div style={{fontWeight:700,fontSize:20,color:"#ECEEF2",letterSpacing:"-0.4px"}}>Auditorías {EMPRESA}</div>
        <div style={{fontSize:11,color:"#7F8692",marginTop:3}}>Checklists de subsanación — Diciembre 2025</div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:24}}>
        {AUDITORIAS.map(a=>{
          const st = progress[a.storageKey]||{};
          const tot=a.data.reduce((s,sec)=>s+sec.items.length,0);
          const done=a.data.reduce((s,sec)=>s+sec.items.filter(i=>st[i.id]).length,0);
          const pct=tot?Math.round(done/tot*100):0;
          const COLORS={finanzas:{bg:"#452E11",accent:"#F59E0B",text:"#EFA880"},digital:{bg:"#452311",accent:"#E8501C",text:"#9896D9"},legal:{bg:"#114521",accent:"#22C55E",text:"#8CE3AF"}};
          const c=COLORS[a.id]||{bg:"#113145",accent:"#0EA5E9",text:"#7EC7F1"};
          return(
            <div key={a.id} onClick={()=>setAuditoria(a.id)} style={{
              background:auditoria===a.id?c.bg:"#232831",
              borderRadius:14,padding:"16px 18px",cursor:"pointer",
              border:auditoria===a.id?`2px solid ${c.accent}22`:"1.5px solid #2E343E",
              transition:"all .12s",position:"relative",overflow:"hidden",
            }}>
              {auditoria===a.id&&<div style={{position:"absolute",top:0,left:0,right:0,height:3,background:c.accent}}/>}
              <div style={{fontSize:22,fontWeight:500,color:c.accent,marginBottom:8}}>{pct}%</div>
              <div style={{fontWeight:700,fontSize:14,color:c.text,marginBottom:2}}>{a.label}</div>
              <div style={{fontSize:9,color:c.text,opacity:0.5,marginBottom:10}}>{done}/{tot} completados</div>
              <div style={{height:3,background:c.accent+"33",borderRadius:99,overflow:"hidden"}}>
                <div style={{height:3,background:c.accent,width:`${pct}%`,borderRadius:99,transition:"width .4s"}}/>
              </div>
            </div>
          );
        })}
      </div>

      <AuditoriaChecklist key={sel.id} data={sel.data} storageKey={sel.storageKey} label={sel.label}
        onUpdate={(key,val)=>setProgress(p=>({...p,[key]:val}))}/>
    </div>
  );
}

// ── DOCUMENTOS TAB ────────────────────────────────────────────────────────────
const INIT_DOCS = [
  { id:1, nombre:"Contrato de Prestación de Servicios", categoria:"Contratos", descripcion:"Plantilla de contrato para proyectos con clientes", link:"" },
  { id:2, nombre:"Factura Proforma", categoria:"Facturas", descripcion:"Plantilla de factura proforma", link:"" },
  { id:3, nombre:"NDA / Acuerdo de Confidencialidad", categoria:"Contratos", descripcion:"Modelo de acuerdo de confidencialidad", link:"" },
  { id:4, nombre:"Acta de Reunión", categoria:"Internos", descripcion:"Plantilla para actas de reunión de equipo", link:"" },
];

function DocumentosTab(){
  const [docs, setDocs] = useState(INIT_DOCS);
  const [showAdd, setShowAdd] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [showLock, setShowLock] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [newDoc, setNewDoc] = useState({nombre:"",categoria:"Contratos",descripcion:"",link:""});

  function requireUnlock(action){
    if(unlocked){ action(); return; }
    setPendingAction(()=>action);
    setShowLock(true);
  }
  function onUnlock(){ setUnlocked(true); setShowLock(false); if(pendingAction){ pendingAction(); setPendingAction(null); } }

  const categorias = [...new Set(docs.map(d=>d.categoria))];
  const CAT_ICONS = {"Contratos":"📄","Facturas":"🧾","Internos":"📋","Otros":"📎"};

  return(
    <div>
      {showLock&&<EditLockModal onUnlock={onUnlock} onClose={()=>setShowLock(false)}/>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div>
          <div style={{fontWeight:700,fontSize:14,color:"#ECEEF2",letterSpacing:"-0.3px"}}>Documentos del equipo</div>
          <div style={{fontSize:11,color:"#7F8692",marginTop:2}}>Plantillas y documentos disponibles para todos</div>
        </div>
        <button onClick={()=>requireUnlock(()=>setShowAdd(true))}
          style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"8px 16px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
          + Añadir documento
        </button>
      </div>
      {categorias.map(cat=>{
        const catDocs = docs.filter(d=>d.categoria===cat);
        return(
          <div key={cat} style={{marginBottom:20}}>
            <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",letterSpacing:"0",marginBottom:10}}>
              {CAT_ICONS[cat]||"📎"} {cat}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:8}}>
              {catDocs.map(doc=>(
                <div key={doc.id} style={{background:"#232831",borderRadius:12,border:"1px solid #2E343E",padding:"16px",display:"flex",flexDirection:"column",gap:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:12,color:"#D5D9E0",marginBottom:3}}>{doc.nombre}</div>
                      <div style={{fontSize:10,color:"#9AA1AC"}}>{doc.descripcion}</div>
                    </div>
                    {unlocked&&<button onClick={()=>setDocs(d=>d.filter(x=>x.id!==doc.id))}
                      style={{background:"none",border:"none",color:"#9AA1AC",cursor:"pointer",fontSize:14,padding:"0 0 0 8px",fontFamily:"inherit"}}>✕</button>}
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {doc.link?<a href={doc.link} target="_blank" rel="noreferrer"
                      style={{display:"inline-flex",alignItems:"center",gap:5,background:"#323844",color:"#FFF",borderRadius:7,padding:"6px 14px",fontSize:11,fontWeight:600,textDecoration:"none"}}>
                      ⬇ Descargar / Ver</a>
                    :<span style={{fontSize:10,color:"#C0BFBA",fontStyle:"italic"}}>Sin enlace</span>}
                    {unlocked&&<input value={doc.link} onChange={e=>setDocs(d=>d.map(x=>x.id===doc.id?{...x,link:e.target.value}:x))}
                      placeholder="https://drive.google.com/..."
                      style={{flex:1,border:"1px solid #2E343E",borderRadius:6,padding:"5px 8px",fontSize:10,fontFamily:"inherit",outline:"none"}}/>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {docs.length===0&&<div style={{textAlign:"center",padding:60,color:"#9AA1AC"}}>
        <div style={{fontSize:40,marginBottom:12}}>📁</div>
        <div style={{fontWeight:600,fontSize:13}}>Sin documentos todavía</div>
      </div>}
      {showAdd&&(
        <div style={{position:"fixed",inset:0,background:"#0007",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#1F232B",borderRadius:14,padding:24,maxWidth:440,width:"95%",boxShadow:"0 8px 24px rgba(0,0,0,0.12)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:16}}>+ Añadir documento</div>
            {[{label:"Nombre",key:"nombre",placeholder:"Ej: Contrato de servicios"},{label:"Descripción",key:"descripcion",placeholder:"Breve descripción"},{label:"Enlace",key:"link",placeholder:"https://drive.google.com/..."}].map(f=>(
              <div key={f.key} style={{marginBottom:12}}>
                <div style={{fontSize:10,color:"#9AA1AC",fontWeight:600,marginBottom:4,letterSpacing:"0.3px"}}>{f.label}</div>
                <input value={newDoc[f.key]} onChange={e=>setNewDoc(d=>({...d,[f.key]:e.target.value}))} placeholder={f.placeholder}
                  style={{width:"100%",border:"1px solid #2E343E",borderRadius:7,padding:"8px 12px",fontSize:11,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
              </div>
            ))}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:10,color:"#9AA1AC",fontWeight:600,marginBottom:4,letterSpacing:"0.3px"}}>Categoría</div>
              <select value={newDoc.categoria} onChange={e=>setNewDoc(d=>({...d,categoria:e.target.value}))}
                style={{width:"100%",border:"1px solid #2E343E",borderRadius:7,padding:"8px 12px",fontSize:11,fontFamily:"inherit",outline:"none"}}>
                {["Contratos","Facturas","Internos","Otros"].map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>{setShowAdd(false);setNewDoc({nombre:"",categoria:"Contratos",descripcion:"",link:""});}}
                style={{background:"#15181D",color:"#D5D9E0",border:"1px solid #2E343E",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
              <button onClick={()=>{if(!newDoc.nombre.trim())return;setDocs(d=>[...d,{...newDoc,id:Date.now()}]);setShowAdd(false);setNewDoc({nombre:"",categoria:"Contratos",descripcion:"",link:""});}}
                style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Añadir</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── DIAMANTE FALKON TAB ───────────────────────────────────────────────────────
function PentagonChart({values, labels, size=220}){
  const cx=size/2, cy=size/2, r=size*0.38;
  const angles = [-90,-18,54,126,198].map(a=>a*Math.PI/180);
  const outerPts = angles.map(a=>[cx+r*Math.cos(a), cy+r*Math.sin(a)]);
  const dataPts = values.map((v,i)=>{
    const scale=Math.min(parseFloat(v)||0,100)/100;
    return [cx+r*scale*Math.cos(angles[i]), cy+r*scale*Math.sin(angles[i])];
  });
  const toPath = p=>p.map((pt,i)=>`${i===0?'M':'L'}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(' ')+'Z';
  return(
    <svg width={size} height={size} style={{overflow:'visible'}}>
      {[0.25,0.5,0.75,1].map(lvl=>(
        <polygon key={lvl} points={angles.map(a=>`${(cx+r*lvl*Math.cos(a)).toFixed(1)},${(cy+r*lvl*Math.sin(a)).toFixed(1)}`).join(' ')} fill="none" stroke="#2E343E" strokeWidth={1}/>
      ))}
      {outerPts.map((pt,i)=><line key={i} x1={cx} y1={cy} x2={pt[0]} y2={pt[1]} stroke="#2E343E" strokeWidth={1}/>)}
      <path d={toPath(dataPts)} fill="#D5D9E0" fillOpacity={0.1} stroke="#D5D9E0" strokeWidth={1.5}/>
      {dataPts.map((pt,i)=><circle key={i} cx={pt[0]} cy={pt[1]} r={3} fill="#D5D9E0"/>)}
      {outerPts.map((pt,i)=>{
        const lx=cx+(r+20)*Math.cos(angles[i]), ly=cy+(r+20)*Math.sin(angles[i]);
        return <text key={i} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" style={{fontSize:size<150?7:8,fontWeight:700,fill:"#3A414D",fontFamily:"'DM Sans',sans-serif"}}>{labels[i]}</text>;
      })}
    </svg>
  );
}

function DiamanteTab({ing, gas, hojas, projects, diamante, setDiamante}){
  const [selMember, setSelMember] = useState(INIT_MEMBERS[0].name);
  const [proyModal, setProyModal] = useState(false);
  const [finModal,  setFinModal]  = useState(false);
  const [clockHours, setClockHours] = useState({});
  const [horasPers, setHorasPers] = useState({}); // {persona:{total,fact}} horas propias registradas en ⏱ Horas
  const [loadingH, setLoadingH] = useState(false);

  const SMI_HORA = 17; // €/hora con SS incluida (referencia LEINN)

  function getMemberProject(mname){ return diamante[`projmain_${mname}`]||""; }

  async function loadClockifyHours(){
    setLoadingH(true);
    try {
      // Horas registradas en ⏱ Horas en el proyecto principal de cada persona (último año, todo el equipo)
      const entries = await horasLoad();
      const desde = Date.now()-365*864e5;
      const hrs = {};
      for(const m of INIT_MEMBERS){
        const pname = getMemberProject(m.name);
        if(!pname) continue;
        hrs[m.name] = entries.filter(e=>(e.proyecto||"").toLowerCase()===pname.toLowerCase()&&new Date(e.inicio).getTime()>=desde).reduce((s,e)=>s+horasSegs(e),0)/3600;
      }
      setClockHours(hrs);
      const hp={};
      entries.forEach(e=>{ const n=e.persona; if(!n) return; const h=horasSegs(e)/3600; hp[n]=hp[n]||{total:0,fact:0}; hp[n].total+=h; if(e.facturable) hp[n].fact+=h; });
      setHorasPers(hp);
    } catch(e){ console.error("Horas error",e); }
    setLoadingH(false);
  }
  useEffect(()=>{ loadClockifyHours(); },[INIT_MEMBERS.map(m=>getMemberProject(m.name)).join("|")]);

  const totalIng = ing.reduce((s,r)=>s+signedBase(r),0);
  const totalGastos = gas.reduce((s,r)=>s+signedBase(r),0)+hojas.reduce((s,r)=>s+(parseFloat(r.importe)||0),0);
  const totalHoras = Object.values(clockHours).reduce((s,h)=>s+h,0);
  const totalHFact = Object.values(horasPers).reduce((s,h)=>s+h.fact,0);
  const totalHTot = Object.values(horasPers).reduce((s,h)=>s+h.total,0);

  function memberStats(mname){
    const proyName = getMemberProject(mname);

    // Facturación individual = FC + FS + FRP + FRC (NO OI)
    const facturacion=ing.reduce((s,r)=>{
      if((r.ref||"").startsWith("OI")) return s; // OI no cuenta para facturación
      return s+repImporte(r,mname);
    },0);

    // OI individual (subvenciones/premios) — cuenta para beneficio pero NO para facturación
    const ingresoOI=ing.reduce((s,r)=>{
      if(!(r.ref||"").startsWith("OI")) return s;
      return s+repImporte(r,mname);
    },0);

    // Gastos directos individuales (por reparto o responsable)
    const gastosF=gas.reduce((s,r)=>{return s+repImporte(r,mname);},0);
    const gastosH=hojas.reduce((s,r)=>{
      const hasRep=r.reparto?.some(x=>parseFloat(x.importe)>0);
      if(hasRep){return s+repImporte(r,mname);}
      if(r.responsable===mname)return s+(parseFloat(r.importe)||0);
      return s;
    },0);
    const gastosTot=gastosF+gastosH;
    // Margen bruto incluye OI
    const margenBruto=facturacion+ingresoOI-gastosTot;

    // Horas Clockify del proyecto asignado
    const horas=clockHours[mname]||0;

    // ── COSTE/HORA (método LEINN) ──────────────────────────────────────────
    // Ingresos del proyecto asignado
    const proyIng = proyName ? ing.filter(r=>r.proyecto===proyName).reduce((s,r)=>s+signedBase(r),0) : 0;
    // Gastos directos del proyecto asignado (facturas + hojas)
    const proyGasF = proyName ? gas.filter(r=>r.proyecto===proyName).reduce((s,r)=>s+signedBase(r),0) : 0;
    const proyGasH = proyName ? hojas.filter(r=>{
      const prows=r.proyectos&&r.proyectos.length>0?r.proyectos:[{proyecto:r.proyecto||"",importe:r.importe_proyecto||r.importe||""}];
      return prows.some(p=>p.proyecto===proyName);
    }).reduce((s,r)=>{
      const prows=r.proyectos&&r.proyectos.length>0?r.proyectos:[{proyecto:r.proyecto||"",importe:r.importe_proyecto||r.importe||""}];
      const match=prows.find(p=>p.proyecto===proyName);
      return s+(match?parseFloat(match.importe)||0:0);
    },0) : 0;
    const proyBeneficio = proyIng - proyGasF - proyGasH;
    // Coste personal estimado = horas × SMI
    const costePersonal = horas * SMI_HORA;
    // Beneficio tras quitar coste personal
    const beneficioTrasCostPersonal = proyBeneficio - costePersonal;
    // Coste/hora real = beneficio proyecto / horas (para mostrar el valor)
    const costeHoraReal = horas>0 ? proyBeneficio/horas : 0;
    // Validado si beneficio del proyecto cubre el coste de personal (>0)
    const costeHoraValidado = beneficioTrasCostPersonal > 0;

    const financiacion=parseFloat(diamante[`fin_${mname}`]||0);
    const margenPct=facturacion>0?margenBruto/facturacion:0;
    const puntoMuerto=margenPct>0?gastosTot/margenPct:0;

    const hP=horasPers[mname]||{total:0,fact:0};
    return{
      facturacion,margenBruto,gastosTot,
      horasTot:hP.total,horasFact:hP.fact,horasNoFact:Math.max(0,hP.total-hP.fact),
      horas,costePersonal,costeHoraReal,beneficioTrasCostPersonal,costeHoraValidado,
      proyBeneficio,proyIng,proyGasF,proyGasH,
      financiacion,puntoMuerto,proyecto:proyName
    };
  }

  const allStats=INIT_MEMBERS.map(m=>({name:m.name,...memberStats(m.name)}));
  const maxFact=Math.max(...allStats.map(s=>s.facturacion),1);
  const maxMB=Math.max(...allStats.map(s=>Math.max(s.margenBruto,0)),1);
  const maxCH=Math.max(...allStats.map(s=>Math.max(s.costeHoraReal,0)),1);
  const maxFin=Math.max(...allStats.map(s=>s.financiacion),1);
  const maxPM=Math.max(...allStats.map(s=>s.puntoMuerto),1);
  function norm(s){return[
    (s.facturacion/maxFact)*100,
    (Math.max(s.margenBruto,0)/maxMB)*100,
    (Math.max(s.costeHoraReal,0)/maxCH)*100,
    (s.financiacion/maxFin)*100,
    (s.puntoMuerto/maxPM)*100,
  ];}

  const sel=allStats.find(s=>s.name===selMember)||allStats[0];
  const LABELS=["Facturación","Margen Bruto","Coste/hora","Financiación","Pto. Muerto"];

  return(
    <div>
      <div style={{marginBottom:20}}>
        <div style={{fontWeight:700,fontSize:15,color:"#ECEEF2",letterSpacing:"-0.4px"}}>💎 Diamante Falkon</div>
        <div style={{fontSize:11,color:"#7F8692",marginTop:2}}>Indicadores económico-financieros LEINN — 5 elementos</div>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
        <button onClick={()=>setProyModal(true)} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:7,padding:"7px 16px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>🎯 Asignar proyecto principal</button>
        <button onClick={loadClockifyHours} disabled={loadingH} style={{background:"#15181D",color:"#D5D9E0",border:"1px solid #2E343E",borderRadius:7,padding:"7px 16px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
          {loadingH?"Cargando...":"🔄 Actualizar horas"}
        </button>
        <button onClick={()=>setFinModal(true)} style={{background:"#15181D",color:"#D5D9E0",border:"1px solid #2E343E",borderRadius:7,padding:"7px 16px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>💰 Financiación e inversiones</button>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(155px,1fr))",gap:8,marginBottom:24}}>
        {[
          {label:"Facturación total",  val:`${totalIng.toFixed(0)}€`},
          {label:"Gastos totales",     val:`${totalGastos.toFixed(0)}€`},
          {label:"Margen bruto",       val:`${(totalIng-totalGastos).toFixed(0)}€`},
          {label:"Horas facturables",  val:`${totalHFact.toFixed(0)}h`},
          {label:"Horas no facturables",val:`${Math.max(0,totalHTot-totalHFact).toFixed(0)}h`},
          {label:"Ref. SMI/hora",      val:`${SMI_HORA}€/h`},
        ].map(k=>(
          <div key={k.label} style={{background:"#1F232B",borderRadius:10,padding:"12px 14px",border:"1px solid #2E343E"}}>
            <div style={{fontSize:9,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:4}}>{k.label}</div>
            <div style={{fontSize:16,fontWeight:700,color:"#ECEEF2",letterSpacing:"-0.3px"}}>{k.val}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:16,marginBottom:24}}>
        <div style={{background:"#232831",borderRadius:12,border:"1px solid #2E343E",overflow:"hidden"}}>
          <div style={{padding:"10px 14px",borderBottom:"1px solid #635A36",fontSize:9,fontWeight:700,color:"#9AA1AC",letterSpacing:"0.3px"}}>Miembro</div>
          {allStats.map(s=>(
            <button key={s.name} onClick={()=>setSelMember(s.name)} style={{width:"100%",textAlign:"left",background:selMember===s.name?"#15181D":"transparent",border:"none",borderBottom:"1px solid #2E343E",padding:"9px 14px",cursor:"pointer",fontFamily:"inherit"}}>
              <div style={{fontSize:11,fontWeight:selMember===s.name?700:500,color:"#D5D9E0"}}>{s.name}</div>
              <div style={{fontSize:9,color:"#9AA1AC",marginTop:1}}>{s.proyecto||"Sin proyecto"} · {s.horasFact.toFixed(0)}h fact. / {s.horasNoFact.toFixed(0)}h no</div>
            </button>
          ))}
        </div>

        <div style={{background:"#232831",borderRadius:12,border:"1px solid #2E343E",padding:"24px",display:"flex",gap:28,alignItems:"flex-start",flexWrap:"wrap"}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
            <div style={{fontSize:12,fontWeight:700,color:"#ECEEF2"}}>{selMember}</div>
            {sel.proyecto&&<div style={{fontSize:9,color:"#9AA1AC",background:"#15181D",padding:"2px 8px",borderRadius:99}}>{sel.proyecto}</div>}
            <PentagonChart values={norm(sel)} labels={LABELS} size={240}/>
          </div>
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontSize:9,fontWeight:700,color:"#9AA1AC",letterSpacing:"0.3px",marginBottom:12}}>Indicadores</div>
            {[
              {n:"1",label:"Facturación individual",    val:`${sel.facturacion.toFixed(2)}€`,   desc:"FC + FS + FRP + FRC (sin OI)"},
              {n:"2",label:"Margen bruto individual",   val:`${sel.margenBruto.toFixed(2)}€`,   desc:`Facturación + OI (${(sel.ingresoOI||0).toFixed(0)}€) − Gastos (${sel.gastosTot.toFixed(2)}€)`, neg:sel.margenBruto<0},
              {n:"3",label:"Coste por hora de trabajo",
                val:sel.horas>0?(
                  sel.costeHoraValidado
                    ? `✅ ${sel.costeHoraReal.toFixed(2)}€/h`
                    : `❌ ${sel.costeHoraReal.toFixed(2)}€/h`
                ):"— (sin horas)",
                desc:sel.horas>0
                  ? `${sel.horas.toFixed(0)}h × ${SMI_HORA}€ = ${sel.costePersonal.toFixed(0)}€ coste personal · Beneficio proy: ${sel.proyBeneficio.toFixed(0)}€ · Margen tras personal: ${sel.beneficioTrasCostPersonal.toFixed(0)}€`
                  : `Sin horas registradas en ${sel.proyecto||"sin proyecto asignado"}`,
                neg:sel.horas>0&&!sel.costeHoraValidado
              },
              {n:"⏱",label:"Horas de trabajo",val:`${sel.horasTot.toFixed(1)}h`, desc:`${sel.horasFact.toFixed(1)}h facturables · ${sel.horasNoFact.toFixed(1)}h no facturables${sel.horasTot>0?` (${Math.round(sel.horasFact/sel.horasTot*100)}% facturable)`:""}`},
              {n:"4",label:"Financiación e inversiones",val:`${sel.financiacion.toFixed(2)}€`,  desc:"Financiación externa captada"},
              {n:"5",label:"Punto muerto",              val:sel.puntoMuerto>0?`${sel.puntoMuerto.toFixed(2)}€`:"—", desc:"Umbral de rentabilidad"},
            ].map(k=>(
              <div key={k.n} style={{padding:"10px 0",borderBottom:"1px solid #2E343E",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:11,fontWeight:600,color:"#ECEEF2"}}><span style={{color:"#9AA1AC",marginRight:6}}>{k.n}.</span>{k.label}</div>
                  <div style={{fontSize:9,color:"#9AA1AC",marginTop:1}}>{k.desc}</div>
                </div>
                <div style={{fontSize:14,fontWeight:700,color:k.neg?"#EB8484":"#D5D9E0",letterSpacing:"-0.3px",whiteSpace:"nowrap",marginLeft:12}}>{k.val}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{fontSize:9,fontWeight:700,color:"#9AA1AC",letterSpacing:"0.3px",marginBottom:12}}>Todos los miembros</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:10,marginBottom:24}}>
        {allStats.map(s=>(
          <div key={s.name} onClick={()=>setSelMember(s.name)}
            style={{background:"#1F232B",borderRadius:10,border:`1.5px solid ${selMember===s.name?"#262B34":"#2E343E"}`,padding:"14px",cursor:"pointer",transition:"border .12s",textAlign:"center"}}>
            <div style={{fontWeight:700,fontSize:11,color:"#ECEEF2",marginBottom:2}}>{s.name}</div>
            {s.proyecto&&<div style={{fontSize:8,color:"#9AA1AC",marginBottom:6}}>{s.proyecto}</div>}
            <PentagonChart values={norm(s)} labels={["F","MB","CH","Fi","PM"]} size={100}/>
            <div style={{marginTop:8,fontSize:9,color:"#9AA1AC",lineHeight:1.6}}>
              <div>{s.facturacion.toFixed(0)}€ · {s.horasFact.toFixed(0)}h fact. / {s.horasNoFact.toFixed(0)}h no</div>
              <div>Margen: {s.margenBruto.toFixed(0)}€</div>
            </div>
          </div>
        ))}
      </div>

      {/* MODAL: Proyecto principal por miembro */}
      {proyModal&&(
        <div style={{position:"fixed",inset:0,background:"#0006",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#1F232B",borderRadius:14,padding:24,maxWidth:420,width:"95%",maxHeight:"85vh",overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,0.12)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>🎯 Proyecto principal por miembro</div>
            <div style={{fontSize:11,color:"#9AA1AC",marginBottom:16}}>Asigna un proyecto a cada persona. Las horas salen de ⏱ Horas.</div>
            {INIT_MEMBERS.map(m=>(
              <div key={m.name} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #2E343E"}}>
                <span style={{fontSize:11,fontWeight:600,color:"#ECEEF2",width:80}}>{m.name}</span>
                <Sel value={diamante[`projmain_${m.name}`]||""} onChange={v=>setDiamante(`projmain_${m.name}`,v)} options={projects.map(p=>p.name)} placeholder="— Sin proyecto —"/>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"flex-end",marginTop:16}}>
              <button onClick={()=>setProyModal(false)} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"8px 20px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Financiación */}
      {finModal&&(
        <div style={{position:"fixed",inset:0,background:"#0006",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#1F232B",borderRadius:14,padding:24,maxWidth:420,width:"95%",maxHeight:"85vh",overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,0.12)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>💰 Financiación e inversiones</div>
            <div style={{fontSize:11,color:"#9AA1AC",marginBottom:16}}>Financiación externa captada por cada miembro</div>
            {INIT_MEMBERS.map(m=>(
              <div key={m.name} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #2E343E"}}>
                <span style={{fontSize:11,fontWeight:600,color:"#ECEEF2"}}>{m.name}</span>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <Inp value={diamante[`fin_${m.name}`]||""} onChange={v=>setDiamante(`fin_${m.name}`,parseFloat(v)||0)} placeholder="0.00" w="100px"/>
                  <span style={{fontSize:10,color:"#9AA1AC"}}>€</span>
                </div>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"flex-end",marginTop:16}}>
              <button onClick={()=>setFinModal(false)} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"8px 20px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── CALENDARIO TAB ────────────────────────────────────────────────────────────
const PRIORIDAD_COLORS = {"🔴 Alta":"#451111","🟡 Media":"#454111","🟢 Baja":"#11452B"};
const PRIORIDAD_TEXT   = {"🔴 Alta":"#B91C1C","🟡 Media":"#78350F","🟢 Baja":"#14532D"};

// ── CALENDARIO TAB ────────────────────────────────────────────────────────────
const PRIORIDADES = [
  {id:"alta",   label:"🔴 Alta",   color:"#EB8484", light:"#451111"},
  {id:"media",  label:"🟡 Media",  color:"#D97706", light:"#453B11"},
  {id:"baja",   label:"🟢 Baja",   color:"#16A34A", light:"#11452B"},
];
const CAL_ESTADOS = ["Pendiente","En curso","Hecho"];

function CalendarioTab({tareas, setTareas, projects}){
  const [vista, setVista] = useState("kanban"); // kanban | mes
  const [form, setForm] = useState(null); // null | tarea obj
  const [mesRef, setMesRef] = useState(()=>{const d=new Date();return{y:d.getFullYear(),m:d.getMonth()};});

  function openNew(){
    setForm({id:Date.now(), titulo:"", descripcion:"", fecha:new Date().toISOString().slice(0,10),
      prioridad:"media", estado:"Pendiente", proyecto:"", responsable:""});
  }
  function openEdit(t){ setForm({...t}); }
  function save(){
    if(!form.titulo.trim()) return;
    setTareas(t=>{
      const exists=t.find(x=>x.id===form.id);
      return exists ? t.map(x=>x.id===form.id?form:x) : [...t,form];
    });
    setForm(null);
  }
  function del(id){ setTareas(t=>t.filter(x=>x.id!==id)); }
  function moveEstado(id, estado){ setTareas(t=>t.map(x=>x.id===id?{...x,estado}:x)); }

  const pr = (t)=>PRIORIDADES.find(p=>p.id===t.prioridad)||PRIORIDADES[1];

  // ── KANBAN VIEW ──
  function renderKanbanView(){
    return(
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
        {CAL_ESTADOS.map(estado=>{
          const col = estado==="Pendiente"?"#D5D9E0":estado==="En curso"?"#D97706":"#16A34A";
          const colLight = estado==="Pendiente"?"#112845":estado==="En curso"?"#453B11":"#11452B";
          const items = tareas.filter(t=>t.estado===estado).sort((a,b)=>a.fecha>b.fecha?1:-1);
          return(
            <div key={estado}>
              <div style={{background:col,color:"#FFF",borderRadius:"10px 10px 0 0",padding:"10px 14px",
                display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontWeight:700,fontSize:12}}>{estado}</span>
                <span style={{background:"#FFFFFF33",borderRadius:99,padding:"1px 8px",fontSize:11,fontWeight:700}}>{items.length}</span>
              </div>
              <div style={{background:colLight,borderRadius:"0 0 10px 10px",padding:8,minHeight:200,display:"flex",flexDirection:"column",gap:6}}>
                {items.map(t=>{
                  const p=pr(t);
                  const proj=projects.find(x=>x.name===t.proyecto);
                  const vencido=t.fecha&&t.fecha<new Date().toISOString().slice(0,10)&&t.estado!=="Hecho";
                  return(
                    <div key={t.id} style={{background:"#1F232B",borderRadius:9,padding:"10px 12px",
                      boxShadow:"0 1px 3px rgba(0,0,0,0.08)",borderLeft:`3px solid ${p.color}`,cursor:"pointer"}}
                      onClick={()=>openEdit(t)}>
                      <div style={{fontWeight:700,fontSize:12,color:"#ECEEF2",marginBottom:4}}>{t.titulo}</div>
                      {t.descripcion&&<div style={{fontSize:10,color:"#9AA1AC",marginBottom:5,lineHeight:1.4}}>{t.descripcion}</div>}
                      <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
                        {t.fecha&&<span style={{fontSize:9,fontWeight:700,color:vencido?"#EB8484":"#9AA1AC",
                          background:vencido?"#451111":"#262B34",padding:"1px 6px",borderRadius:99}}>
                          {vencido?"⚠ ":""}{t.fecha}
                        </span>}
                        {proj&&<span style={{fontSize:9,fontWeight:700,color:proj.color,background:proj.light,padding:"1px 6px",borderRadius:99}}>{proj.name}</span>}
                        <span style={{fontSize:9,fontWeight:700,color:p.color,background:p.light,padding:"1px 6px",borderRadius:99}}>{p.label}</span>
                      </div>
                      <div style={{display:"flex",gap:4,marginTop:6}}>
                        {CAL_ESTADOS.filter(e=>e!==estado).map(e=>(
                          <button key={e} onClick={ev=>{ev.stopPropagation();moveEstado(t.id,e);}}
                            style={{fontSize:9,padding:"2px 7px",border:"1px solid #2E343E",borderRadius:99,
                              background:"#232831",cursor:"pointer",fontFamily:"inherit",color:"#B4BAC4",fontWeight:600}}>
                            → {e}
                          </button>
                        ))}
                        <button onClick={ev=>{ev.stopPropagation();del(t.id);}}
                          style={{fontSize:9,padding:"2px 7px",border:"1px solid #7A1F1F",borderRadius:99,
                            background:"#451111",cursor:"pointer",fontFamily:"inherit",color:"#EB8484",fontWeight:700,marginLeft:"auto"}}>
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
                <button onClick={openNew} style={{background:"#FFFFFF0D",border:"1px dashed #3A414D",borderRadius:8,
                  padding:"8px",fontSize:11,color:"#7F8692",cursor:"pointer",fontFamily:"inherit",marginTop:2}}>
                  + Añadir tarea
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── MES VIEW ──
  function renderMesView(){
    const {y,m} = mesRef;
    const primerDia = new Date(y,m,1).getDay(); // 0=dom
    const offset = primerDia===0?6:primerDia-1; // lunes=0
    const diasMes = new Date(y,m+1,0).getDate();
    const celdas = offset + diasMes;
    const hoy = new Date().toISOString().slice(0,10);
    const meses=["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

    return(
      <div>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
          <button onClick={()=>setMesRef(({y,m})=>m===0?{y:y-1,m:11}:{y,m:m-1})}
            style={{background:"#262B34",border:"none",borderRadius:7,padding:"6px 12px",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>‹</button>
          <span style={{fontWeight:700,fontSize:14,color:"#ECEEF2"}}>{meses[m]} {y}</span>
          <button onClick={()=>setMesRef(({y,m})=>m===11?{y:y+1,m:0}:{y,m:m+1})}
            style={{background:"#262B34",border:"none",borderRadius:7,padding:"6px 12px",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>›</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2}}>
          {["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"].map(d=>(
            <div key={d} style={{textAlign:"center",fontSize:10,fontWeight:700,color:"#7F8692",padding:"6px 0"}}>{d}</div>
          ))}
          {Array.from({length:Math.ceil(celdas/7)*7}).map((_,i)=>{
            const dia = i-offset+1;
            const valido = dia>=1&&dia<=diasMes;
            const fecha = valido?`${y}-${String(m+1).padStart(2,"0")}-${String(dia).padStart(2,"0")}`:"";
            const tareasDelDia = valido?tareas.filter(t=>t.fecha===fecha):[];
            const esHoy = fecha===hoy;
            return(
              <div key={i} style={{minHeight:80,background:esHoy?"#112845":valido?"#1F232B":"#232831",
                borderRadius:8,border:`1px solid ${esHoy?"#93C5FD":"#2E343E"}`,padding:"4px",
                opacity:valido?1:0.3}}>
                {valido&&<div style={{fontSize:10,fontWeight:esHoy?800:600,color:esHoy?"#819EEE":"#B4BAC4",marginBottom:3}}>{dia}</div>}
                {tareasDelDia.slice(0,3).map(t=>{
                  const p=pr(t);
                  return(
                    <div key={t.id} onClick={()=>openEdit(t)}
                      style={{fontSize:9,fontWeight:700,background:p.light,color:p.color,
                        borderRadius:4,padding:"1px 5px",marginBottom:2,cursor:"pointer",
                        whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                      {t.titulo}
                    </div>
                  );
                })}
                {tareasDelDia.length>3&&<div style={{fontSize:9,color:"#7F8692"}}>+{tareasDelDia.length-3} más</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <div style={{fontWeight:700,fontSize:15,color:"#ECEEF2"}}>📅 Calendario de tareas</div>
          <div style={{fontSize:11,color:"#9AA1AC",marginTop:2}}>
            {tareas.filter(t=>t.estado!=="Hecho").length} pendientes · {tareas.filter(t=>t.estado==="Hecho").length} hechas
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <div style={{display:"flex",background:"#262B34",borderRadius:8,padding:2}}>
            {[{id:"kanban",label:"⬛ Kanban"},{id:"mes",label:"📆 Mes"}].map(v=>(
              <button key={v.id} onClick={()=>setVista(v.id)}
                style={{background:vista===v.id?"#1F232B":"transparent",border:"none",borderRadius:7,
                  padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",
                  color:vista===v.id?"#D5D9E0":"#7F8692",boxShadow:vista===v.id?"0 1px 3px #0001":"none"}}>
                {v.label}
              </button>
            ))}
          </div>
          <button onClick={openNew} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:9,
            padding:"8px 18px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            + Nueva tarea
          </button>
        </div>
      </div>

      {vista==="kanban" ? renderKanbanView() : renderMesView()}

      {/* Modal nueva/editar tarea */}
      {form&&(
        <div style={{position:"fixed",inset:0,background:"#0008",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#1F232B",borderRadius:14,padding:24,maxWidth:460,width:"95%",boxShadow:"0 8px 40px #0004"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:16}}>{form.id&&tareas.find(t=>t.id===form.id)?"✏️ Editar tarea":"✨ Nueva tarea"}</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:4}}>Título *</div>
                <input value={form.titulo} onChange={e=>setForm(f=>({...f,titulo:e.target.value}))}
                  placeholder="¿Qué hay que hacer?" autoFocus
                  style={{width:"100%",border:"1px solid #2E343E",borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:"inherit",boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:4}}>Descripción</div>
                <textarea value={form.descripcion||""} onChange={e=>setForm(f=>({...f,descripcion:e.target.value}))}
                  placeholder="Detalles opcionales..."
                  style={{width:"100%",border:"1px solid #2E343E",borderRadius:8,padding:"8px 10px",fontSize:12,
                    fontFamily:"inherit",resize:"vertical",minHeight:60,boxSizing:"border-box"}}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div>
                  <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:4}}>Fecha límite</div>
                  <input type="date" value={form.fecha||""} onChange={e=>setForm(f=>({...f,fecha:e.target.value}))}
                    style={{width:"100%",border:"1px solid #2E343E",borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:"inherit",boxSizing:"border-box"}}/>
                </div>
                <div>
                  <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:4}}>Prioridad</div>
                  <select value={form.prioridad||"media"} onChange={e=>setForm(f=>({...f,prioridad:e.target.value}))}
                    style={{width:"100%",border:"1px solid #2E343E",borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:"inherit",boxSizing:"border-box"}}>
                    {PRIORIDADES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:4}}>Proyecto</div>
                  <select value={form.proyecto||""} onChange={e=>setForm(f=>({...f,proyecto:e.target.value}))}
                    style={{width:"100%",border:"1px solid #2E343E",borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:"inherit",boxSizing:"border-box"}}>
                    <option value="">— Sin proyecto</option>
                    {projects.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:4}}>Responsable</div>
                  <select value={form.responsable||""} onChange={e=>setForm(f=>({...f,responsable:e.target.value}))}
                    style={{width:"100%",border:"1px solid #2E343E",borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:"inherit",boxSizing:"border-box"}}>
                    <option value="">— Sin asignar</option>
                    {INIT_MEMBERS.map(m=><option key={m.name} value={m.name}>{m.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:4}}>Estado</div>
                <div style={{display:"flex",gap:6}}>
                  {CAL_ESTADOS.map(e=>(
                    <button key={e} onClick={()=>setForm(f=>({...f,estado:e}))}
                      style={{flex:1,padding:"6px",border:`2px solid ${form.estado===e?"#262B34":"#2E343E"}`,
                        borderRadius:8,background:form.estado===e?"#323844":"#1F232B",
                        color:form.estado===e?"#FFF":"#B4BAC4",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:18}}>
              {tareas.find(t=>t.id===form.id)&&(
                <button onClick={()=>{del(form.id);setForm(null);}}
                  style={{background:"#451111",color:"#EB8484",border:"none",borderRadius:8,padding:"8px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                  🗑️ Eliminar
                </button>
              )}
              <button onClick={()=>setForm(null)}
                style={{background:"#262B34",color:"#B4BAC4",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                Cancelar
              </button>
              <button onClick={save}
                style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MTA MODEL TAB ─────────────────────────────────────────────────────────────
const MTA_PROCESOS = [
  {
    id:"personal_cultivation", label:"Personal Cultivation II", emoji:"🌱",
    materia:"2.4 · Liderazgo, aprendizaje autogestionado y desarrollo personal II",
    color:"#8CE3AF", light:"#11452B",
    indicadores:[
      "Rutinas diarias de bienestar (mental, físico, emocional, espiritual) integradas en la TC",
      "Leído 'Teaching Critical Thinking' (bell hooks) + training session sobre comunicación horizontal",
      "Reflexión escrita sobre propósito de vida, valores y proyectos alineados",
      "Elegida Wellbeing Ambassador y conectada con comunidad y red MTA",
    ]
  },
  {
    id:"self_driven", label:"Self Driven Learning II", emoji:"🧭",
    materia:"2.4 · Liderazgo, aprendizaje autogestionado y desarrollo personal II",
    color:"#D5D9E0", light:"#112845",
    indicadores:[
      "Learning Contract/Compass revisado regularmente con progreso medible",
      "80 learning points — ensayos que cristalizan conocimiento aplicado a proyectos",
      "Portfolio de aprendizaje diseñado con experiencias y proyectos significativos",
    ]
  },
  {
    id:"cooperative_leadership", label:"Cooperative Leadership II", emoji:"👑",
    materia:"2.4 · Liderazgo, aprendizaje autogestionado y desarrollo personal II",
    color:"#ED9D82", light:"#451111",
    indicadores:[
      "Comprometida con el proyecto común, valores de la TC, transparencia y honestidad",
      "Equipo de líderes funciona como motor; disposición a asumir puestos de liderazgo",
      "Evaluación de habilidades de liderazgo individual; estrategias y objetivos definidos y medidos",
    ]
  },
  {
    id:"empathy_diversity", label:"Empathy & Diversity II", emoji:"🌍",
    materia:"4.2 · Creación y desarrollo de equipos y comunidades II",
    color:"#BC88E8", light:"#2A1145",
    indicadores:[
      "Training session con 'Empathy & Diversity Workbook'; espacios seguros en TC y proyectos",
      "Proyectos que responden a retos sociales del ecosistema local",
      "Proyectos en cooperación con personas de otras culturas desde igualdad y respeto",
      "Manifiesto de Empatía & Diversidad aplicado a relaciones, comunidad y proyectos",
    ]
  },
  {
    id:"team_community", label:"Team Community Learning II", emoji:"🏘️",
    materia:"4.2 · Creación y desarrollo de equipos y comunidades II",
    color:"#8ACCE5", light:"#114145",
    indicadores:[
      "Training session como espacio seguro; cultura de confianza, colaboración y creatividad",
      "Superada fase del equipo falso; ensayo de reflexión individual + sesión de diálogo",
      "Birth Givings y al menos 1 Hackathon; conocimiento de Nonaka & Takeuchi (1995)",
      "40 community points por persona; intercambio con lab y otras TCs (cross-fertilization)",
    ]
  },
  {
    id:"leading_thoughts", label:"Leading Thoughts II", emoji:"💡",
    materia:"4.2 · Creación y desarrollo de equipos y comunidades II",
    color:"#EFA880", light:"#453B11",
    indicadores:[
      "Todo el equipo interiorizado y consecuente con los Leading Thoughts de la TC",
      "Misión, visión y valores rediseñados; planes estratégicos alineados con propósito",
    ]
  },
  {
    id:"team_lj", label:"Team Learning Journeys II", emoji:"✈️",
    materia:"5.2 · Estancias Internacionales II",
    color:"#E986AE", light:"#45112F",
    indicadores:[
      "Actitud de respeto y aportación al bienestar del equipo durante el LJ",
      "Team Learning Contract creado proactivamente, integrado en propósito personal",
      "Bases de economía social y cooperativismo comprendidas; plan de acción de proyectos",
      "Integración en ecosistema local; mínimo de CVs, business events y community events cumplido",
      "Al menos 2 proyectos orientados a resolver problemáticas locales",
      "Participación activa en actividades MTA; team report realizado y compartido",
    ]
  },
  {
    id:"digital_tech", label:"Digital & Exponential Tech Skill II", emoji:"💻",
    materia:"1.6 · Tecnologías emergentes II",
    color:"#97D8BC", light:"#11452B",
    indicadores:[
      "Mínimo 2 evidencias individuales aptas por miembro; identidad digital profesional",
      "Páginas web de proyectos diseñadas desde investigación de usuario",
      "KPIs y OKRs implementados; decisiones basadas en datos visualizados",
      "Prototipos físicos y digitales creados; cultura de prototipado activa",
      "Conocimiento de IoT, Big Data, IA, Robótica; protocolo ético de uso de IA redactado",
      "Auditoría tecnológica superada",
    ]
  },
  {
    id:"financial_tech", label:"Financial Tech Skill II", emoji:"💰",
    materia:"1.4 · Finanzas para emprendedores II",
    color:"#EBB584", light:"#454111",
    indicadores:[
      "Panel Modelo de Medición de Valor Financiero MTA creado con 5 indicadores",
      "Análisis de viabilidad y proyección a 3 años de proyectos/formas jurídicas",
      "Fuentes de financiación identificadas y seleccionadas con criterio",
      "Métodos de análisis de inversión y métodos de pago evaluados",
      "Auditoría financiera superada",
    ]
  },
  {
    id:"legal_tech", label:"Legal Tech Skill II", emoji:"⚖️",
    materia:"1.2 · Creación y organización de empresa II",
    color:"#9A96D9", light:"#1B1145",
    indicadores:[
      "Mínimo 2 evidencias individuales aptas; conocimiento compartido en equipo",
      "Identificación de necesidades de protección intelectual e industrial en proyectos",
      "Análisis de formas jurídicas para crear empresa; debate de equipo alineado",
      "Auditoría legal superada",
    ]
  },
  {
    id:"changemaking", label:"Changemaking Experiments II", emoji:"🔬",
    materia:"2.2 · Herramientas para la gestión financiera, legal y digital II",
    color:"#C3C8D0", light:"#262B34",
    indicadores:[
      "Proyectos con creciente trayectoria, complejidad e impacto; equilibrio facturación/experimentación/impacto",
      "Cultura de trabajo conectada a retos locales y globales; conexión con problemáticas abordadas",
      "Relación de confianza con coaches y asesoras; proyectos gestionados de forma autónoma y proactiva",
      "Conocimiento de ODS; medición de impacto social y medioambiental de proyectos",
    ]
  },
  {
    id:"teampreneurship", label:"Teampreneurship & Customer Co-creation II", emoji:"🤝",
    materia:"3.2 · Gestión de clientes, marketing y ventas II",
    color:"#83B3EC", light:"#112845",
    indicadores:[
      "100 CVs acumuladas desde el inicio; propuesta de valor mejorada",
      "Plan de clientes estratégicos con herramientas y referencias teóricas (funnel de ventas...)",
      "~15 nuevos proyectos con clientes; metodología de oferta consolidada",
      "Plan de marketing por proyecto (4Ps, canales, campañas, imagen...)",
      "Facturación resultado de actividad de la TC (no individual); herramientas financieras usadas",
    ]
  },
  {
    id:"design_thinking", label:"Design Thinking I", emoji:"🎨",
    materia:"6.1 · Pensamiento de diseño y generación de modelos de negocio I",
    color:"#ED82AD", light:"#45112F",
    indicadores:[
      "Programa de pre-incubación MTA completado con dossier de investigación",
      "Metodología de diseño aprendida aplicada; resultados en proyectos",
      "Problem-solution fit validado con clientes reales",
    ]
  },
  {
    id:"business_model", label:"Business Model Creation I", emoji:"🏗️",
    materia:"6.1 · Pensamiento de diseño y generación de modelos de negocio I",
    color:"#7BF4D2", light:"#11452B",
    indicadores:[
      "3 conceptos innovadores ideados en pre-incubación; 1 en fase prototipo/validación con cliente",
      "Cada miembro en al menos 1 proyecto a medio/largo plazo que cumple criterios MTA",
    ]
  },
  {
    id:"innovation_strategy", label:"Innovation Strategy I", emoji:"🚀",
    materia:"6.3 · Estrategia e innovación abierta I",
    color:"#D5D9E0", light:"#112845",
    indicadores:[
      "Equipo capacitado para liderar procesos de innovación; fases y factores clave entendidos",
      "Recursos internos (tiempo, dinero) destinados a innovación; resultados medidos",
    ]
  },
  {
    id:"branding", label:"Branding & Communication I", emoji:"📣",
    materia:"6.3 · Estrategia e innovación abierta I",
    color:"#7C3AED", light:"#1B1145",
    indicadores:[
      "Storytelling y pitch dominados; exposición a terceros medida y mejorada",
      "Presencia activa en redes y medios; estrategia de comunicación por proyecto",
      "Marcas y branding creados y gestionados; co-branding aplicado con criterio",
    ]
  },
];

const MTA_ESTADO_OPTS = ["⬜ Sin empezar","🟡 En progreso","🟢 Completado","🔴 Bloqueado"];
const MTA_ESTADO_COLORS = {"⬜ Sin empezar":"#969CA6","🟡 En progreso":"#F59E0B","🟢 Completado":"#22C55E","🔴 Bloqueado":"#EF4444"};

function MTAModelTab({mta, setMta}){
  const [open, setOpen] = useState(null);

  const total = MTA_PROCESOS.reduce((s,p)=>s+p.indicadores.length,0);
  const done  = MTA_PROCESOS.reduce((s,p)=>s+p.indicadores.filter((_,i)=>mta[`${p.id}_ind_${i}`]==="🟢 Completado").length,0);
  const pct   = total>0?Math.round(done/total*100):0;

  const materias = [...new Set(MTA_PROCESOS.map(p=>p.materia))];

  return(
    <div>
      <div style={{background:"#1F232B",borderRadius:12,padding:"16px 20px",marginBottom:16,border:"1px solid #2E343E"}}>
        <div style={{fontWeight:700,fontSize:15,color:"#ECEEF2",marginBottom:2}}>📐 MTA Model — Seguimiento 2º año LEINN</div>
        <div style={{fontSize:11,color:"#9AA1AC",marginBottom:10}}>Plan de evaluación 2025/2026 · {MTA_PROCESOS.length} procesos · {total} indicadores</div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{flex:1,height:12,background:"#262B34",borderRadius:99,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${pct}%`,background:"#22C55E",borderRadius:99,transition:"width .4s"}}/>
          </div>
          <span style={{fontWeight:900,fontSize:16,color:"#22C55E",minWidth:45}}>{pct}%</span>
          <span style={{fontSize:11,color:"#7F8692"}}>{done}/{total}</span>
        </div>
        <div style={{display:"flex",gap:12,marginTop:12,flexWrap:"wrap"}}>
          {MTA_ESTADO_OPTS.map(e=>{
            const cnt=MTA_PROCESOS.reduce((s,p)=>s+p.indicadores.filter((_,i)=>mta[`${p.id}_ind_${i}`]===e).length,0);
            const noEstado = e==="⬜ Sin empezar" ? total - MTA_PROCESOS.reduce((s,p)=>s+p.indicadores.filter((_,i)=>!!mta[`${p.id}_ind_${i}`]&&mta[`${p.id}_ind_${i}`]!=="⬜ Sin empezar").length,0) : cnt;
            return <div key={e} style={{fontSize:11,color:MTA_ESTADO_COLORS[e],fontWeight:700}}>{e} <span style={{color:"#9AA1AC"}}>{e==="⬜ Sin empezar"?total-done-MTA_PROCESOS.reduce((s,p)=>s+p.indicadores.filter((_,i)=>mta[`${p.id}_ind_${i}`]==="🟡 En progreso"||mta[`${p.id}_ind_${i}`]==="🔴 Bloqueado").length,0):cnt}</span></div>;
          })}
        </div>
      </div>

      {materias.map(mat=>{
        const procs = MTA_PROCESOS.filter(p=>p.materia===mat);
        return(
          <div key={mat} style={{marginBottom:20}}>
            <div style={{fontSize:10,fontWeight:700,color:"#7F8692",letterSpacing:1,marginBottom:8,paddingLeft:2}}>{mat}</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {procs.map(proc=>{
                const isOpen = open===proc.id;
                const procDone = proc.indicadores.filter((_,i)=>mta[`${proc.id}_ind_${i}`]==="🟢 Completado").length;
                const procPct  = Math.round(procDone/proc.indicadores.length*100);
                const procNotes = mta[`${proc.id}_notas`]||"";
                return(
                  <div key={proc.id} style={{background:"#232831",borderRadius:12,border:"1px solid #2E343E",overflow:"hidden"}}>
                    <div onClick={()=>setOpen(isOpen?null:proc.id)}
                      style={{padding:"12px 16px",display:"flex",alignItems:"center",gap:12,cursor:"pointer",
                        background:isOpen?proc.light:"#1F232B"}}>
                      <div style={{width:36,height:36,borderRadius:9,background:proc.light,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{proc.emoji}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:700,fontSize:13,color:"#ECEEF2"}}>{proc.label}</div>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
                          <div style={{width:80,height:5,background:"#262B34",borderRadius:99,overflow:"hidden"}}>
                            <div style={{height:"100%",width:`${procPct}%`,background:proc.color,borderRadius:99}}/>
                          </div>
                          <span style={{fontSize:10,color:"#7F8692"}}>{procDone}/{proc.indicadores.length}</span>
                          {procDone===proc.indicadores.length&&<span style={{fontSize:9,fontWeight:700,color:"#22C55E",background:"#11452B",padding:"1px 7px",borderRadius:99}}>✓ COMPLETADO</span>}
                        </div>
                      </div>
                      <span style={{color:"#5C6370",fontSize:13,transform:isOpen?"rotate(180deg)":"none",transition:"transform .2s"}}>▼</span>
                    </div>
                    {isOpen&&(
                      <div style={{padding:"0 16px 16px",borderTop:`2px solid ${proc.light}`}}>
                        <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:12}}>
                          {proc.indicadores.map((ind,i)=>{
                            const key=`${proc.id}_ind_${i}`;
                            const estado=mta[key]||"⬜ Sin empezar";
                            const bg = estado==="🟢 Completado"?"#11452D":estado==="🟡 En progreso"?"#453B11":estado==="🔴 Bloqueado"?"#451115":"#232831";
                            const border = estado==="🟢 Completado"?"#11452D":estado==="🟡 En progreso"?"#453B11":estado==="🔴 Bloqueado"?"#FECDD3":"#2E343E";
                            return(
                              <div key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"8px 12px",background:bg,borderRadius:8,border:`1px solid ${border}`}}>
                                <div style={{flex:1,fontSize:11,color:"#ECEEF2",lineHeight:1.6,paddingTop:2}}>{ind}</div>
                                <select value={estado} onChange={e=>setMta(key,e.target.value)}
                                  style={{border:"1px solid #2E343E",borderRadius:6,padding:"3px 6px",fontSize:10,
                                    fontFamily:"inherit",background:"#1F232B",cursor:"pointer",
                                    color:MTA_ESTADO_COLORS[estado],fontWeight:700,flexShrink:0}}>
                                  {MTA_ESTADO_OPTS.map(o=><option key={o} value={o}>{o}</option>)}
                                </select>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{marginTop:10}}>
                          <div style={{fontSize:10,fontWeight:700,color:"#7F8692",marginBottom:4}}>📝 Notas del equipo</div>
                          <textarea value={procNotes} onChange={e=>setMta(`${proc.id}_notas`,e.target.value)}
                            placeholder="Reflexiones, evidencias, próximos pasos..."
                            style={{width:"100%",border:"1px solid #2E343E",borderRadius:8,padding:"8px 10px",
                              fontSize:11,fontFamily:"inherit",resize:"vertical",minHeight:60,
                              boxSizing:"border-box",color:"#ECEEF2"}}/>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── ACTAS DE REUNIÓN ──────────────────────────────────────────────────────────
const TIPOS_REUNION = ["Reunión de equipo","Reunión de proyecto","Checkpoint","Reunión con cliente","Formación","Otro"];

function ActasTab({actas, setActas, projects}){
  const [open, setOpen] = useState(null); // id of expanded acta
  const [newTarea, setNewTarea] = useState({});
  const [newDecision, setNewDecision] = useState({});

  function addActa(){
    const id = Date.now();
    setActas(a=>[{
      id, fecha: new Date().toISOString().slice(0,10),
      asistentes: [...INIT_MEMBERS.map(m=>m.name)],
      proyectos: [], decisiones: [], tareas: [], titulo: ""
    }, ...a]);
    setOpen(id);
  }

  function upd(id, field, val){
    setActas(a=>a.map(r=>r.id===id?{...r,[field]:val}:r));
  }

  function del(id){ setActas(a=>a.filter(r=>r.id!==id)); }

  function addDecision(id){
    const txt = newDecision[id]?.trim();
    if(!txt) return;
    setActas(a=>a.map(r=>r.id===id?{...r,decisiones:[...r.decisiones,{id:Date.now(),texto:txt}]}:r));
    setNewDecision(d=>({...d,[id]:""}));
  }

  function delDecision(actaId, decId){
    setActas(a=>a.map(r=>r.id===actaId?{...r,decisiones:r.decisiones.filter(d=>d.id!==decId)}:r));
  }

  function addTarea(id){
    const txt = newTarea[id]?.trim();
    if(!txt) return;
    setActas(a=>a.map(r=>r.id===id?{...r,tareas:[...r.tareas,{id:Date.now(),texto:txt,responsable:"",done:false}]}:r));
    setNewTarea(t=>({...t,[id]:""}));
  }

  function updTarea(actaId, tareaId, field, val){
    setActas(a=>a.map(r=>r.id===actaId?{...r,tareas:r.tareas.map(t=>t.id===tareaId?{...t,[field]:val}:t)}:r));
  }

  function delTarea(actaId, tareaId){
    setActas(a=>a.map(r=>r.id===actaId?{...r,tareas:r.tareas.filter(t=>t.id!==tareaId)}:r));
  }

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <div style={{fontWeight:700,fontSize:15,color:"#ECEEF2"}}>📋 Actas de reunión</div>
          <div style={{fontSize:11,color:"#9AA1AC",marginTop:2}}>{actas.length} actas registradas</div>
        </div>
        <button onClick={addActa} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:9,padding:"9px 20px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
          + Nueva acta
        </button>
      </div>

      {actas.length===0&&(
        <div style={{background:"#1F232B",borderRadius:12,padding:"48px",textAlign:"center",border:"1px solid #2E343E"}}>
          <div style={{fontSize:36,marginBottom:10}}>📋</div>
          <div style={{fontSize:13,fontWeight:700,color:"#ECEEF2",marginBottom:4}}>Sin actas todavía</div>
          <div style={{fontSize:11,color:"#7F8692"}}>Pulsa "+ Nueva acta" para registrar vuestra primera reunión</div>
        </div>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {actas.map(acta=>{
          const isOpen = open===acta.id;
          const pendientes = acta.tareas.filter(t=>!t.done).length;
          const hechas = acta.tareas.filter(t=>t.done).length;
          return(
            <div key={acta.id} style={{background:"#232831",borderRadius:12,border:"1px solid #2E343E",overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
              {/* Acta header — always visible */}
              <div style={{padding:"14px 18px",display:"flex",alignItems:"center",gap:12,cursor:"pointer",
                background:isOpen?"#232831":"#1F232B"}} onClick={()=>setOpen(isOpen?null:acta.id)}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                    <span style={{fontWeight:700,fontSize:13,color:"#ECEEF2"}}>
                      {acta.titulo||"Reunión sin título"}
                    </span>
                    <span style={{fontSize:11,color:"#7F8692"}}>{acta.fecha}</span>
                    {pendientes>0&&<span style={{background:"#453B11",color:"#F3A97D",fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99}}>⏳ {pendientes} pendiente{pendientes>1?"s":""}</span>}
                    {hechas>0&&pendientes===0&&<span style={{background:"#11452B",color:"#059669",fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99}}>✅ Todo hecho</span>}
                  </div>
                  <div style={{display:"flex",gap:6,marginTop:5,flexWrap:"wrap"}}>
                    {acta.asistentes.slice(0,6).map(name=>{
                      const m=INIT_MEMBERS.find(x=>x.name===name);
                      return <span key={name} style={{background:m?.light||"#262B34",color:m?.color||"#B4BAC4",fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:99}}>{name}</span>;
                    })}
                    {acta.proyectos.map(p=>{
                      const proj=projects.find(x=>x.name===p);
                      return <span key={p} style={{background:proj?.light||"#262B34",color:proj?.color||"#B4BAC4",fontSize:9,fontWeight:600,padding:"2px 7px",borderRadius:99}}>🏷 {p}</span>;
                    })}
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <DelBtn onClick={()=>del(acta.id)}/>
                  <span style={{color:"#7F8692",fontSize:14,transform:isOpen?"rotate(180deg)":"none",transition:"transform .2s"}}>▼</span>
                </div>
              </div>

              {/* Acta body — expanded */}
              {isOpen&&(
                <div style={{padding:"0 18px 18px",borderTop:"1px solid #2E343E"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:14}}>
                    {/* Titulo y fecha */}
                    <div>
                      <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:5}}>📝 Título</div>
                      <input value={acta.titulo} onChange={e=>upd(acta.id,"titulo",e.target.value)}
                        placeholder="Ej: Weekly del equipo · Sprint review..."
                        style={{width:"100%",border:"1px solid #2E343E",borderRadius:7,padding:"7px 10px",fontSize:12,fontFamily:"inherit",boxSizing:"border-box"}}/>
                    </div>
                    <div>
                      <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:5}}>📅 Fecha</div>
                      <input type="date" value={acta.fecha} onChange={e=>upd(acta.id,"fecha",e.target.value)}
                        style={{width:"100%",border:"1px solid #2E343E",borderRadius:7,padding:"7px 10px",fontSize:12,fontFamily:"inherit",boxSizing:"border-box"}}/>
                    </div>
                  </div>

                  {/* Asistentes */}
                  <div style={{marginTop:14}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:7}}>👥 Asistentes</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                      {INIT_MEMBERS.map(m=>{
                        const sel=acta.asistentes.includes(m.name);
                        return(
                          <button key={m.name} onClick={()=>{
                            const next=sel?acta.asistentes.filter(x=>x!==m.name):[...acta.asistentes,m.name];
                            upd(acta.id,"asistentes",next);
                          }} style={{background:sel?m.color:m.light,color:sel?"#FFF":m.color,
                            border:`1.5px solid ${m.color}44`,borderRadius:99,padding:"4px 12px",
                            fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                            {m.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Proyectos tratados */}
                  <div style={{marginTop:14}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:7}}>🏷 Proyectos tratados</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                      {projects.map(p=>{
                        const sel=acta.proyectos.includes(p.name);
                        return(
                          <button key={p.name} onClick={()=>{
                            const next=sel?acta.proyectos.filter(x=>x!==p.name):[...acta.proyectos,p.name];
                            upd(acta.id,"proyectos",next);
                          }} style={{background:sel?p.color:p.light,color:sel?"#FFF":p.color,
                            border:`1.5px solid ${p.color}44`,borderRadius:99,padding:"4px 12px",
                            fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                            {p.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginTop:16}}>
                    {/* Decisiones */}
                    <div>
                      <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:7}}>✅ Decisiones tomadas</div>
                      <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:8}}>
                        {acta.decisiones.map((d,i)=>(
                          <div key={d.id} style={{display:"flex",alignItems:"flex-start",gap:6,background:"#232831",borderRadius:7,padding:"6px 10px"}}>
                            <span style={{color:"#059669",fontWeight:700,fontSize:11,marginTop:1}}>✓</span>
                            <span style={{flex:1,fontSize:11,color:"#ECEEF2",lineHeight:1.5}}>{d.texto}</span>
                            <button onClick={()=>delDecision(acta.id,d.id)}
                              style={{background:"none",border:"none",color:"#5C6370",cursor:"pointer",fontSize:12,padding:"0 2px"}}>✕</button>
                          </div>
                        ))}
                      </div>
                      <div style={{display:"flex",gap:5}}>
                        <input value={newDecision[acta.id]||""} onChange={e=>setNewDecision(d=>({...d,[acta.id]:e.target.value}))}
                          onKeyDown={e=>e.key==="Enter"&&addDecision(acta.id)}
                          placeholder="Añadir decisión..." 
                          style={{flex:1,border:"1px solid #2E343E",borderRadius:7,padding:"6px 9px",fontSize:11,fontFamily:"inherit"}}/>
                        <button onClick={()=>addDecision(acta.id)}
                          style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:7,padding:"6px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+</button>
                      </div>
                    </div>

                    {/* Tareas / próximos pasos */}
                    <div>
                      <div style={{fontSize:10,fontWeight:700,color:"#9AA1AC",marginBottom:7}}>⏭ Próximos pasos</div>
                      <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:8}}>
                        {acta.tareas.map(t=>{
                          const resp=INIT_MEMBERS.find(m=>m.name===t.responsable);
                          return(
                            <div key={t.id} style={{display:"flex",alignItems:"center",gap:6,background:t.done?"#11452D":"#232831",borderRadius:7,padding:"5px 8px"}}>
                              <input type="checkbox" checked={t.done} onChange={e=>updTarea(acta.id,t.id,"done",e.target.checked)}
                                style={{cursor:"pointer",width:14,height:14,accentColor:"#059669"}}/>
                              <span style={{flex:1,fontSize:11,color:t.done?"#7F8692":"#D5D9E0",textDecoration:t.done?"line-through":"none",lineHeight:1.4}}>{t.texto}</span>
                              <select value={t.responsable||""} onChange={e=>updTarea(acta.id,t.id,"responsable",e.target.value)}
                                style={{border:"1px solid #2E343E",borderRadius:5,padding:"2px 4px",fontSize:9,fontFamily:"inherit",background:resp?resp.light:"#1F232B",color:resp?resp.color:"#7F8692",fontWeight:700}}>
                                <option value="">—</option>
                                {INIT_MEMBERS.map(m=><option key={m.name} value={m.name}>{m.name}</option>)}
                              </select>
                              <button onClick={()=>delTarea(acta.id,t.id)}
                                style={{background:"none",border:"none",color:"#5C6370",cursor:"pointer",fontSize:12,padding:"0 2px"}}>✕</button>
                            </div>
                          );
                        })}
                      </div>
                      <div style={{display:"flex",gap:5}}>
                        <input value={newTarea[acta.id]||""} onChange={e=>setNewTarea(t=>({...t,[acta.id]:e.target.value}))}
                          onKeyDown={e=>e.key==="Enter"&&addTarea(acta.id)}
                          placeholder="Añadir tarea..." 
                          style={{flex:1,border:"1px solid #2E343E",borderRadius:7,padding:"6px 9px",fontSize:11,fontFamily:"inherit"}}/>
                        <button onClick={()=>addTarea(acta.id)}
                          style={{background:"#059669",color:"#FFF",border:"none",borderRadius:7,padding:"6px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+</button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CRMTab({data,setData,projects}){
  const addRow=(proj,grp)=>setData(d=>({
    ...d,[proj]:{...d[proj],[grp]:{
      ...d[proj]?.[grp],
      rows:[...(d[proj]?.[grp]?.rows||[]),{id:Date.now(),cliente:"",ubicacion:"",tlf:"",email:"",estado:"",comentarios:""}]
    }}
  }));
  const updRow=(proj,grp,id,f,v)=>setData(d=>({
    ...d,[proj]:{...d[proj],[grp]:{
      ...d[proj][grp],
      rows:(d[proj][grp]?.rows||[]).map(r=>r.id===id?{...r,[f]:v}:r)
    }}
  }));
  const delRow=(proj,grp,id)=>setData(d=>({
    ...d,[proj]:{...d[proj],[grp]:{
      ...d[proj][grp],
      rows:(d[proj][grp]?.rows||[]).filter(r=>r.id!==id)
    }}
  }));
  const renameGrp=(proj,grp,name)=>setData(d=>({
    ...d,[proj]:{...d[proj],[grp]:{...d[proj]?.[grp],name}}
  }));

  return projects.map(p=>{
    const g1=data[p.name]?.g1||{name:"GRUPO 1",rows:[]};
    const g2=data[p.name]?.g2||{name:"GRUPO 2",rows:[]};
    const all=[...(g1.rows||[]),...(g2.rows||[])];
    const f={
      cont:all.filter(r=>r.estado).length,
      prop:all.filter(r=>["Propuesta","CV cerrada","Venta cerrada"].includes(r.estado)).length,
      cvc: all.filter(r=>["CV cerrada","Venta cerrada"].includes(r.estado)).length,
      vent:all.filter(r=>r.estado==="Venta cerrada").length,
    };
    const pct=f.cont>0?Math.round(f.vent/f.cont*100):0;

    return(
      <Block key={p.name} name={p.name} color={p.color} light={p.light} badge={`${f.cont} contactos · ${f.vent} ventas · ${pct}% conv.`}>
        {/* Funnel */}
        <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
          {[{l:"Contactados",v:f.cont,bg:"#112845",c:"#D5D9E0"},{l:"Propuesta",v:f.prop,bg:"#454111",c:"#78350F"},
            {l:"CV cerrada",v:f.cvc,bg:"#452F11",c:"#7C2D12"},{l:"Venta cerrada",v:f.vent,bg:"#11452B",c:"#14532D"},
            {l:"Conversión",v:`${pct}%`,bg:"#262B34",c:"#059669"}
          ].map(s=>(
            <div key={s.l} style={{background:s.bg,borderRadius:8,padding:"6px 12px",textAlign:"center",minWidth:70}}>
              <div style={{fontSize:17,fontWeight:900,color:s.c}}>{s.v}</div>
              <div style={{fontSize:9,fontWeight:600,color:s.c,opacity:.7}}>{s.l}</div>
            </div>
          ))}
        </div>

        {/* Groups with editable names */}
        {[["g1",g1],["g2",g2]].map(([grpKey,grp])=>(
          <div key={grpKey} style={{marginBottom:14}}>
            {/* Editable group name */}
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
              <input
                value={grp.name||""}
                onChange={e=>renameGrp(p.name,grpKey,e.target.value)}
                style={{fontSize:11,fontWeight:700,color:p.color,background:"transparent",
                  border:"none",borderBottom:`2px solid ${p.color}44`,outline:"none",
                  padding:"2px 4px",width:"auto",minWidth:80,fontFamily:"inherit",
                  letterSpacing:"0"}}
                placeholder="Nombre del grupo"
              />
              <span style={{fontSize:9,color:"#7F8692"}}>({(grp.rows||[]).length} contactos)</span>
            </div>

            {(grp.rows||[]).length>0&&(
              <div style={{overflowX:"auto",marginBottom:6}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <THead cols={["Cliente","Ubicación","TLF","Email","Estado","Comentarios",""]} color={p.color}/>
                  <tbody>
                    {(grp.rows||[]).map((r,i)=>(
                      <tr key={r.id} style={{background:i%2===0?"#FFFFFF88":"transparent"}}>
                        <td style={{padding:"3px 5px"}}><Inp value={r.cliente}      onChange={v=>updRow(p.name,grpKey,r.id,"cliente",v)}      placeholder="Empresa"/></td>
                        <td style={{padding:"3px 5px"}}><Inp value={r.ubicacion}    onChange={v=>updRow(p.name,grpKey,r.id,"ubicacion",v)}    placeholder="Ciudad" w="80px"/></td>
                        <td style={{padding:"3px 5px"}}><Inp value={r.tlf}          onChange={v=>updRow(p.name,grpKey,r.id,"tlf",v)}          placeholder="TLF" w="90px"/></td>
                        <td style={{padding:"3px 5px"}}><Inp value={r.email}        onChange={v=>updRow(p.name,grpKey,r.id,"email",v)}        placeholder="Email"/></td>
                        <td style={{padding:"3px 5px"}}>
                          <div style={{display:"flex",flexDirection:"column",gap:2}}>
                            <Sel value={r.estado} onChange={v=>updRow(p.name,grpKey,r.id,"estado",v)} options={ESTADOS}/>
                            {r.estado&&<Badge label={r.estado} colors={MTA_ESTADO_COLORS[r.estado]}/>}
                          </div>
                        </td>
                        <td style={{padding:"3px 5px"}}><Inp value={r.comentarios}  onChange={v=>updRow(p.name,grpKey,r.id,"comentarios",v)}  placeholder="Notas"/></td>
                        <td style={{padding:"3px 5px"}}><DelBtn onClick={()=>delRow(p.name,grpKey,r.id)}/></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <AddBtn onClick={()=>addRow(p.name,grpKey)}/>
          </div>
        ))}
      </Block>
    );
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────


// ── INICIO TAB ────────────────────────────────────────────────────────────────
function InicioTab({bp,cv,ing,gas,hojas,projects,tareas,setTareas}){
  const [objetivo,setObjetivoRaw] = useState("");
  const [editObj,setEditObj] = useState(false);
  const [objTmp,setObjTmp] = useState("");
  const [now,setNow] = useState(new Date());

  // Load objetivo from Supabase
  useEffect(()=>{
    sb.from("mta_progress").select("val").eq("key","objetivo_mes").maybeSingle()
      .then(({data})=>{ if(data?.val) setObjetivoRaw(data.val); });
    const iv=setInterval(()=>setNow(new Date()),1000);
    return()=>clearInterval(iv);
  },[]);

  function saveObjetivo(){
    sb.from("mta_progress").upsert({key:"objetivo_mes",val:objTmp}).then();
    setObjetivoRaw(objTmp);
    setEditObj(false);
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalIng=ing.reduce((s,r)=>s+signedBase(r),0);
  const totalGas=gas.reduce((s,r)=>s+signedBase(r),0)+hojas.reduce((s,r)=>s+(parseFloat(r.importe)||0),0);
  const neto=totalIng-totalGas;
  const totBP=Object.values(bp).flat().reduce((s,r)=>s+(parseFloat(r.puntos)||0),0);
  const totCV=Object.values(cv).flat().filter(r=>r.cat==="CV"&&!r.linkedFrom).length;
  const pendientes=ing.filter(r=>!r.pagado).length;

  // ── Cuenta atrás evaluación ────────────────────────────────────────────────
  // Siempre apunta al próximo 31 de mayo (9:00). Pasado ese día, salta al año siguiente.
  const evalYear = now > new Date(now.getFullYear(),4,31,23,59,59) ? now.getFullYear()+1 : now.getFullYear();
  const evalDate = new Date(evalYear,4,31,9,0,0);
  const diff = evalDate - now;
  const dias  = Math.max(0,Math.floor(diff/86400000));
  const horas = Math.max(0,Math.floor((diff%86400000)/3600000));
  const mins  = Math.max(0,Math.floor((diff%3600000)/60000));
  const segs  = Math.max(0,Math.floor((diff%60000)/1000));

  // ── Cuenta atrás viaje a Berlín (24 de enero de 2027) ─────────────────────
  const berlinDate = new Date(2027,0,24,0,0,0);
  const diffB = berlinDate - now;
  const diasB  = Math.max(0,Math.floor(diffB/86400000));
  const horasB = Math.max(0,Math.floor((diffB%86400000)/3600000));
  const minsB  = Math.max(0,Math.floor((diffB%3600000)/60000));
  const segsB  = Math.max(0,Math.floor((diffB%60000)/1000));

  // ── Próximas TS ────────────────────────────────────────────────────────────
  const todayStr = `${String(now.getDate()).padStart(2,"0")}/${String(now.getMonth()+1).padStart(2,"0")}/${now.getFullYear()}`;
  const parseDate = f=>{if(!f)return 0;const[d,m,y]=f.split("/");return new Date(y,m-1,d).getTime();};
  const proxTS = tareas
    .filter(t=>t.titulo&&t.titulo.includes("Training")&&parseDate(t.fecha)>=now.setHours(0,0,0,0))
    .sort((a,b)=>parseDate(a.fecha)-parseDate(b.fecha))
    .slice(0,3);

  // ── Últimas actualizaciones ────────────────────────────────────────────────
  const updates = [];
  // Últimas facturas
  const lastFact = [...ing].sort((a,b)=>b.id-a.id).slice(0,2);
  lastFact.forEach(f=>{ if(f.ref) updates.push({icon:"💰",text:`${f.ref} añadida — ${parseFloat(f.base||0).toFixed(0)}€ base`,color:"#059669",bg:"#11452D"}); });
  // Últimos bookpoints
  const allBP = Object.entries(bp).filter(([m])=>!MIEMBROS_OCULTOS.includes(m)).flatMap(([m,rows])=>rows.map(r=>({...r,member:m}))).sort((a,b)=>b.id-a.id).slice(0,2);
  allBP.forEach(r=>{ if(r.libro) updates.push({icon:"📚",text:`${r.member} — ${r.puntos} pts — ${r.libro}`,color:"#E8501C",bg:"#452311"}); });
  // Últimas CVs
  const allCV = Object.entries(cv).filter(([m])=>!MIEMBROS_OCULTOS.includes(m)).flatMap(([m,rows])=>rows.filter(r=>!r.linkedFrom&&r.cat==="CV").map(r=>({...r,member:m}))).sort((a,b)=>b.id-a.id).slice(0,2);
  allCV.forEach(r=>{ if(r.cliente) updates.push({icon:"🤝",text:`${r.member} cerró CV con ${r.cliente}${r.proyecto?" ("+r.proyecto+")":""}`,color:"#0EA5E9",bg:"#113145"}); });
  // Último gasto
  const lastGas = [...gas].sort((a,b)=>b.id-a.id)[0];
  if(lastGas?.descripcion) updates.push({icon:"💸",text:`Gasto registrado — ${lastGas.descripcion} — ${parseFloat(lastGas.base||0).toFixed(0)}€`,color:"#EC8383",bg:"#451111"});
  // Sort updates by most recent (facturas first, then BP, CV, gastos)

  // ── Mini gráfico mes actual ────────────────────────────────────────────────
  const currMonth=`${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,"0")}`;
  const parseM=f=>{if(!f)return null;const p=f.split("/");return p.length===3?`${p[2]}/${p[1].padStart(2,"0")}`:null;};
  const ingMes=ing.filter(r=>parseM(r.fecha)===currMonth).reduce((s,r)=>s+signedBase(r),0);
  const gasMes=(gas.filter(r=>parseM(r.fecha)===currMonth).reduce((s,r)=>s+signedBase(r),0)+hojas.filter(r=>parseM(r.fecha)===currMonth).reduce((s,r)=>s+(parseFloat(r.importe)||0),0));

  // ── Top 3 ─────────────────────────────────────────────────────────────────
  const memberStats=MIEMBROS_VISIBLES.map(m=>{
    const mBP=Object.values(bp).flat().filter(r=>r.member===m.name||bp[m.name]);
    const pts=(bp[m.name]||[]).reduce((s,r)=>s+(parseFloat(r.puntos)||0),0);
    const cvC=(cv[m.name]||[]).filter(r=>r.cat==="CV").length;
    const fact=ing.reduce((s,r)=>{
      if((r.ref||"").startsWith("OI")) return s;
      return s+repImporte(r,m.name);
    },0);
    return{name:m.name,color:m.color,pts,cvC,fact};
  });
  const top3BP=[...memberStats].sort((a,b)=>b.pts-a.pts)[0];
  const top3CV=[...memberStats].sort((a,b)=>b.cvC-a.cvC)[0];
  const top3Fact=[...memberStats].sort((a,b)=>b.fact-a.fact)[0];

  // ── Estado auditorías ─────────────────────────────────────────────────────
  const [auditProg,setAuditProg]=useState({});
  useEffect(()=>{
    sb.from("audit_progress").select("key,val").in("key",["blesk_audit","blesk_audit_digital","blesk_audit_legal"])
      .then(({data:rows})=>{ if(!rows)return; const p={}; rows.forEach(r=>{p[r.key]=r.val||{};}); setAuditProg(p); });
  },[]);
  const auditItems=[
    {key:"blesk_audit",label:"💰 Finanzas",total:25},
    {key:"blesk_audit_digital",label:"💻 Digital",total:33},
    {key:"blesk_audit_legal",label:"⚖️ Legal",total:36},
  ];

  // ── Proyecto más activo (Clockify horas) ──────────────────────────────────
  // Use projStats from ing data as proxy
  const projActive=[...projects].map(p=>({
    name:p.name,color:p.color,
    ing:ing.filter(r=>r.proyecto===p.name).reduce((s,r)=>s+signedBase(r),0),
    cv:Object.values(cv).flat().filter(r=>r.proyecto===p.name&&!r.linkedFrom).length,
  })).filter(p=>p.ing>0||p.cv>0).sort((a,b)=>b.cv-a.cv)[0];

  return(
    <div>
      <div style={{marginBottom:24,display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontWeight:500,fontSize:22,color:"#ECEEF2",letterSpacing:"-0.5px"}}>Bienvenidos, {EMPRESA}</div>
          <div style={{fontSize:11,color:"#7F8692",marginTop:3,letterSpacing:"0.1px"}}>{now.toLocaleDateString("es-ES",{weekday:"long",day:"2-digit",month:"long",year:"numeric"})}</div>
        </div>
      </div>

      {/* ── KPIs principales ── */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10,marginBottom:24}}>
        {[
          {label:"Facturación",val:totalIng.toFixed(0)+"€",color:"#7BF4D2",bg:"#11452D",accent:"#059669"},
          {label:"Neto",val:(neto>=0?"+":"")+neto.toFixed(0)+"€",color:neto>=0?"#7BF4D2":"#E48B8B",bg:neto>=0?"#11452D":"#451111",accent:neto>=0?"#059669":"#EF4444"},
          {label:"Bookpoints",val:String(totBP),color:"#9896D9",bg:"#452311",accent:"#E8501C"},
          {label:"CV totales",val:String(totCV),color:"#7EC7F1",bg:"#113145",accent:"#0EA5E9"},
          {label:"Proyectos",val:String(projects.length),color:"#EFA880",bg:"#452E11",accent:"#F59E0B"},
          {label:"Fact. pendientes",val:String(pendientes),color:pendientes>0?"#E48B8B":"#7BF4D2",bg:pendientes>0?"#451111":"#11452D",accent:pendientes>0?"#EF4444":"#059669"},
        ].map(k=>(
          <div key={k.label} style={{background:k.bg,borderRadius:14,padding:"16px 18px",border:"none",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:k.accent,borderRadius:"14px 14px 0 0"}}/>
            <div style={{fontSize:26,fontWeight:500,color:k.color,letterSpacing:"-1.5px",lineHeight:1,marginBottom:6}}>{k.val}</div>
            <div style={{fontSize:10,color:k.accent,fontWeight:600,letterSpacing:"0"}}>{k.label}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}} className="blesk-grid-2">

        {/* ── Cuenta atrás evaluación ── */}
        <div style={{background:"#312E81",borderRadius:14,padding:"20px 22px"}}>
          <div style={{fontSize:10,color:"#A5B4FC",fontWeight:600,letterSpacing:"0",marginBottom:4}}>Evaluación LEINN</div>
          <div style={{fontSize:11,color:"#C7D2FE",marginBottom:16,opacity:0.7}}>31 de mayo de {evalYear}</div>
          {diff>0?(
            <div style={{display:"flex",gap:8,marginBottom:16}}>
              {[{v:dias,l:"días"},{v:horas,l:"horas"},{v:mins,l:"min"},{v:segs,l:"seg"}].map(u=>(
                <div key={u.l} style={{background:"#3730A3",borderRadius:10,padding:"10px 12px",textAlign:"center",flex:1}}>
                  <div style={{fontSize:24,fontWeight:500,letterSpacing:"-1px",lineHeight:1,color:"#E0E7FF"}}>{String(u.v).padStart(2,"0")}</div>
                  <div style={{fontSize:8,color:"#818CF8",marginTop:4,letterSpacing:"0"}}>{u.l}</div>
                </div>
              ))}
            </div>
          ):(
            <div style={{fontSize:16,fontWeight:500,color:"#34D399",marginBottom:16}}>Ya es el día</div>
          )}
          {proxTS.length>0&&(
            <div style={{borderTop:"1px solid #3730A3",paddingTop:12}}>
              <div style={{fontSize:9,color:"#818CF8",fontWeight:600,marginBottom:8,letterSpacing:"0"}}>Próximas TS</div>
              {proxTS.map(t=>(
                <div key={t.id} style={{fontSize:11,color:"#C7D2FE",marginBottom:4,opacity:0.8}}>{t.fecha} — {t.titulo}</div>
              ))}
            </div>
          )}
        </div>

        {/* ── Cuenta atrás viaje a Berlín ── */}
        <div style={{background:"#312E81",borderRadius:14,padding:"20px 22px"}}>
          <div style={{fontSize:10,color:"#A5B4FC",fontWeight:600,letterSpacing:"0",marginBottom:4}}>Viaje a Berlín ✈️</div>
          <div style={{fontSize:11,color:"#C7D2FE",marginBottom:16,opacity:0.7}}>24 de enero de 2027</div>
          {diffB>0?(
            <div style={{display:"flex",gap:8,marginBottom:16}}>
              {[{v:diasB,l:"días"},{v:horasB,l:"horas"},{v:minsB,l:"min"},{v:segsB,l:"seg"}].map(u=>(
                <div key={u.l} style={{background:"#3730A3",borderRadius:10,padding:"10px 12px",textAlign:"center",flex:1}}>
                  <div style={{fontSize:24,fontWeight:500,letterSpacing:"-1px",lineHeight:1,color:"#E0E7FF"}}>{String(u.v).padStart(2,"0")}</div>
                  <div style={{fontSize:8,color:"#818CF8",marginTop:4,letterSpacing:"0"}}>{u.l}</div>
                </div>
              ))}
            </div>
          ):(
            <div style={{fontSize:16,fontWeight:500,color:"#34D399",marginBottom:16}}>Ya es el día</div>
          )}
        </div>

        {/* ── Top proyectos por ingresos ── */}
        {(()=>{
          const topProj=[...projects].map(p=>({
            name:p.name,color:p.color,
            ing:ing.filter(r=>r.proyecto===p.name).reduce((s,r)=>s+signedBase(r),0),
          })).filter(p=>p.ing>0).sort((a,b)=>b.ing-a.ing).slice(0,5);
          const maxIng=Math.max(...topProj.map(p=>p.ing),1);
          return topProj.length>0?(
            <div style={{background:"#113145",borderRadius:14,padding:"16px 18px",gridColumn:"1 / -1"}}>
              <div style={{fontSize:10,color:"#7EC7F1",fontWeight:600,letterSpacing:"0",marginBottom:14}}>Top proyectos</div>
              {topProj.map(p=>(
                <div key={p.name} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                    <span style={{fontSize:11,color:"#7EC7F1",fontWeight:500}}>{p.name}</span>
                    <span style={{fontSize:13,fontWeight:500,color:p.color||"#0EA5E9"}}>{p.ing.toFixed(0)}€</span>
                  </div>
                  <div style={{height:4,background:"#113445",borderRadius:99,overflow:"hidden"}}>
                    <div style={{height:4,background:p.color||"#0EA5E9",width:`${Math.round(p.ing/maxIng*100)}%`,borderRadius:99}}/>
                  </div>
                </div>
              ))}
            </div>
          ):null;
        })()}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}} className="blesk-grid-2">

        {/* ── Últimas actualizaciones ── */}
        <div style={{background:"#232831",borderRadius:14,border:"1px solid #2E343E",padding:"18px 20px"}}>
          <div style={{fontSize:11,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:12}}>🔔 Últimas actualizaciones</div>
          {updates.slice(0,6).map((u,i)=>(
            <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"7px 0",borderBottom:i<5?"1px solid #635836":"none"}}>
              <div style={{width:26,height:26,borderRadius:6,background:u.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>{u.icon}</div>
              <div style={{fontSize:11,color:"#ECEEF2",lineHeight:1.4,flex:1}}>{u.text}</div>
            </div>
          ))}
          {updates.length===0&&<div style={{fontSize:11,color:"#9AA1AC",fontStyle:"italic"}}>Sin actualizaciones todavía</div>}
        </div>

        {/* ── Mini gráfico mes + Top 3 + Auditorías ── */}
        <div style={{display:"flex",flexDirection:"column",gap:10}}>

          {/* Gráfico últimos 6 meses */}
          {(()=>{
            const months=[];
            for(let i=5;i>=0;i--){
              const d=new Date(now.getFullYear(),now.getMonth()-i,1);
              const mm=String(d.getMonth()+1).padStart(2,"0");
              const yy=String(d.getFullYear()).slice(-2);
              const label=d.toLocaleDateString("es-ES",{month:"short"});
              const matchMonth=fecha=>{if(!fecha)return false;const[dd,mm,yy]=fecha.split('/');return parseInt(mm)-1===d.getMonth()&&parseInt(yy)===d.getFullYear();};
              const ingV=ing.filter(r=>matchMonth(r.fecha)).reduce((s,r)=>s+signedBase(r),0);
              const gasV=gas.filter(r=>matchMonth(r.fecha)).reduce((s,r)=>s+signedBase(r),0)+hojas.filter(r=>matchMonth(r.fecha)).reduce((s,r)=>s+(parseFloat(r.importe)||0),0);
              months.push({label,ingV,gasV,neto:ingV-gasV,isCurrent:i===0});
            }
            const maxV=Math.max(...months.map(m=>Math.max(m.ingV,m.gasV)),1);
            const curMonth=months[months.length-1];
            return(
              <div style={{background:"#11452D",borderRadius:14,padding:"16px 18px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:14}}>
                  <div style={{fontSize:10,color:"#7BF4D2",fontWeight:600,letterSpacing:"0"}}>{curMonth.label} {now.getFullYear()}</div>
                  <div style={{fontSize:18,fontWeight:500,color:curMonth.neto>=0?"#059669":"#EB8484"}}>{curMonth.neto>=0?"+":""}{curMonth.neto.toFixed(0)}€ <span style={{fontSize:10,opacity:0.6}}>neto</span></div>
                </div>
                <div style={{display:"flex",gap:4,alignItems:"flex-end",height:60,marginBottom:8}}>
                  {months.map((m,i)=>{
                    const hi=Math.max(4,Math.round((m.ingV/maxV)*56));
                    const hg=Math.max(4,Math.round((m.gasV/maxV)*56));
                    return(
                      <div key={i} style={{flex:1,display:"flex",gap:1,alignItems:"flex-end",height:60}}>
                        <div style={{flex:1,height:hi,background:m.isCurrent?"#059669":"#11452D",borderRadius:"2px 2px 0 0"}}/>
                        <div style={{flex:1,height:hg,background:m.isCurrent?"#EF4444":"#451111",borderRadius:"2px 2px 0 0"}}/>
                      </div>
                    );
                  })}
                </div>
                <div style={{display:"flex",gap:4}}>
                  {months.map((m,i)=>(
                    <div key={i} style={{flex:1,textAlign:"center",fontSize:8,color:"#7BF4D2",opacity:m.isCurrent?1:0.5,fontWeight:m.isCurrent?600:400}}>{m.label}</div>
                  ))}
                </div>
                <div style={{display:"flex",gap:12,marginTop:10}}>
                  <div style={{fontSize:11,color:"#7BF4D2"}}><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:"#059669",marginRight:4}}/>Ingresos {curMonth.ingV.toFixed(0)}€</div>
                  <div style={{fontSize:11,color:"#7BF4D2"}}><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:"#EF4444",marginRight:4}}/>Gastos {curMonth.gasV.toFixed(0)}€</div>
                </div>
              </div>
            );
          })()}

          {/* Top 3 */}
          <div style={{background:"#452E11",borderRadius:14,padding:"16px 18px"}}>
            <div style={{fontSize:10,color:"#F3A97D",fontWeight:600,letterSpacing:"0",marginBottom:14}}>Top del equipo</div>
            {[
              {label:"Bookpoints",m:top3BP,val:(top3BP?.pts||0)+" pts",bg:"#453B11",color:"#F3A97D",accent:"#F59E0B"},
              {label:"CV",m:top3CV,val:(top3CV?.cvC||0)+" CV",bg:"#112845",color:"#859DEA",accent:"#3B82F6"},
              {label:"Facturación",m:top3Fact,val:(top3Fact?.fact?.toFixed(0)||0)+"€",bg:"#114523",color:"#8AE5AD",accent:"#22C55E"},
            ].map(t=>(
              <div key={t.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,padding:"10px 12px",background:t.bg,borderRadius:10}}>
                <div>
                  <div style={{fontSize:9,color:t.color,opacity:0.7,letterSpacing:"0",marginBottom:2}}>{t.label}</div>
                  <div style={{fontSize:13,fontWeight:500,color:t.color}}>{t.m?.name||"—"}</div>
                </div>
                <div style={{fontSize:16,fontWeight:500,color:t.accent}}>{t.val}</div>
              </div>
            ))}
          </div>

          {/* Estado auditorías */}
          <div style={{background:"#452311",borderRadius:14,padding:"16px 18px"}}>
            <div style={{fontSize:10,color:"#9896D9",fontWeight:600,letterSpacing:"0",marginBottom:14}}>Estado auditorías</div>
            {auditItems.map(a=>{
              const st=auditProg[a.key]||{};
              const done=Object.values(st).filter(Boolean).length;
              const pct=Math.round(done/a.total*100);
              return(
                <div key={a.key} style={{marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5,alignItems:"baseline"}}>
                    <span style={{fontSize:12,color:"#9896D9",fontWeight:500}}>{a.label.replace(/[^\w\s.]/g,"").trim()}</span>
                    <span style={{fontSize:18,fontWeight:500,color:"#948EE1"}}>{pct}%</span>
                  </div>
                  <div style={{height:4,background:"#111C45",borderRadius:99,overflow:"hidden"}}>
                    <div style={{height:4,background:pct===100?"#059669":"#E8501C",width:`${pct}%`,borderRadius:99,transition:"width .4s"}}/>
                  </div>
                </div>
              );
            })}
          </div>

        </div>
      </div>

      {/* Proyecto más activo */}
      {projActive&&(
        <div style={{background:projActive.color+"18",borderRadius:14,padding:"16px 20px",display:"flex",alignItems:"center",gap:16}}>
          <div style={{width:44,height:44,borderRadius:12,background:projActive.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:"#FFF",fontWeight:500,flexShrink:0}}>
            {projActive.name[0]}
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:9,color:projActive.color,fontWeight:600,letterSpacing:"0",opacity:0.7}}>Proyecto más activo</div>
            <div style={{fontSize:15,fontWeight:500,color:projActive.color,marginTop:2}}>{projActive.name}</div>
            <div style={{fontSize:10,color:projActive.color,opacity:0.6,marginTop:1}}>{projActive.cv} CV cerradas · {projActive.ing.toFixed(0)}€ facturados</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── RENDIMIENTO TAB ───────────────────────────────────────────────────────────
function RendimientoTab({bp,cv,ing,gas,hojas,projects}){
  const [periodo,setPeriodo]   = useState("week");
  const [dateFrom,setDateFrom] = useState("");
  const [dateTo,setDateTo]     = useState("");
  const [selectedM,setSelectedM] = useState(INIT_MEMBERS[0].name);
  // Horas registradas en ⏱ Horas (antes Clockify)
  const [horasEntries,,recargarHoras] = useHoras();
  const horasLoaded = horasEntries!==null;

  const PERIODO_LABELS = {week:"Esta semana",month:"Este mes",custom:"Personalizado"};

  function getRange(){
    const now = new Date();
    const pad = n=>String(n).padStart(2,"0");
    const fs = d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T00:00:00.000Z`;
    const fe = d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59:59.999Z`;
    if(periodo==="week"){
      const dow=now.getDay()===0?7:now.getDay();
      const mon=new Date(now); mon.setDate(now.getDate()-(dow-1));
      const sun=new Date(mon); sun.setDate(mon.getDate()+6);
      return [fs(mon),fe(sun)];
    }
    if(periodo==="month"){
      return [fs(new Date(now.getFullYear(),now.getMonth(),1)), fe(new Date(now.getFullYear(),now.getMonth()+1,0))];
    }
    return [dateFrom+"T00:00:00.000Z", dateTo+"T23:59:59.999Z"];
  }

  const fmtH = s=>{ const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h+"h"+(m>0?" "+m+"m":""); };

  // ── Filter data to period ─────────────────────────────────────────────────
  function inPeriod(fecha){
    if(!fecha) return false;
    const [dd,mm,yyyy]=fecha.split("/");
    if(!dd||!mm||!yyyy) return false;
    const d=new Date(yyyy,mm-1,dd);
    const now=new Date();
    if(periodo==="week"){
      const dow=now.getDay()===0?7:now.getDay();
      const mon=new Date(now); mon.setDate(now.getDate()-(dow-1)); mon.setHours(0,0,0,0);
      const sun=new Date(mon); sun.setDate(mon.getDate()+6); sun.setHours(23,59,59,999);
      return d>=mon&&d<=sun;
    }
    if(periodo==="month"){
      return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth();
    }
    if(periodo==="custom"&&dateFrom&&dateTo){
      const [fy,fm,fd]=dateFrom.split("-"); const [ty,tm,td]=dateTo.split("-");
      return d>=new Date(fy,fm-1,fd)&&d<=new Date(ty,tm-1,td);
    }
    return false;
  }

  const m = INIT_MEMBERS.find(x=>x.name===selectedM);

  // Bookpoints del período
  const mBP = (bp[selectedM]||[]).filter(r=>inPeriod(r.fecha));
  const totalBP = mBP.reduce((s,r)=>s+(parseFloat(r.puntos)||0),0);

  // CV/LV del período
  const mCV = (cv[selectedM]||[]).filter(r=>!r.linkedFrom&&inPeriod(r.fecha));
  const totalCV = mCV.filter(r=>r.cat==="CV").length;
  const totalLV = mCV.filter(r=>r.cat==="LV").length;

  // Facturación del período (por reparto)
  const mFact = ing.filter(r=>!((r.ref||"").startsWith("OI"))&&inPeriod(r.fecha)&&r.reparto?.some(x=>x.member===selectedM));
  const totalFact = mFact.reduce((s,r)=>{ return s+repImporte(r,selectedM); },0);

  // OI del período
  const mOI = ing.filter(r=>(r.ref||"").startsWith("OI")&&inPeriod(r.fecha)&&r.reparto?.some(x=>x.member===selectedM));
  const totalOI = mOI.reduce((s,r)=>{ return s+repImporte(r,selectedM); },0);

  // Gastos del período
  const mGas = gas.filter(r=>inPeriod(r.fecha)&&r.reparto?.some(x=>x.member===selectedM));
  const totalGas = mGas.reduce((s,r)=>{ return s+repImporte(r,selectedM); },0);
  const mHojas = hojas.filter(r=>inPeriod(r.fecha)&&(r.reparto?.some(x=>x.member===selectedM)||r.responsable===selectedM));
  const totalHojas = mHojas.reduce((s,r)=>{ const rep=r.reparto?.find(x=>x.member===selectedM); return rep?s+(parseFloat(rep.importe)||0):s+(parseFloat(r.importe)||0); },0);
  const totalGasTot = totalGas+totalHojas;

  // Beneficio período
  const beneficio = totalFact+totalOI-totalGasTot;

  // Horas del período (registradas en ⏱ Horas)
  const [hDesde,hHasta] = rangoPeriodo(periodo,dateFrom,dateTo);
  const clockEntry = horasMatriz(horasEntries||[],hDesde,hHasta)[selectedM]||{};
  const totalSecs = Object.values(clockEntry).reduce((s,v)=>s+v,0);
  const proyHoras = Object.entries(clockEntry).sort((a,b)=>b[1]-a[1]);

  // Coste/hora
  const costeSMI = totalSecs>0 ? (totalSecs/3600)*17 : 0;
  const euroHora = totalSecs>0 ? beneficio/(totalSecs/3600) : null;

  // Proyectos activos (donde ha facturado o CV)
  const proyActivos=[...new Set([
    ...mFact.map(r=>r.proyecto).filter(Boolean),
    ...mCV.map(r=>r.proyecto).filter(Boolean),
  ])];

  // Ratio de efectividad CV/LV
  const efectividad = (totalCV+totalLV)>0 ? Math.round(totalCV/(totalCV+totalLV)*100) : null;

  const KPI = ({label,val,sub,color,bg})=>(
    <div style={{background:bg||"#232831",borderRadius:14,padding:"14px 16px",position:"relative",overflow:"hidden",border:"none"}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:color,borderRadius:"14px 14px 0 0"}}/>
      <div style={{fontSize:22,fontWeight:500,color:color,letterSpacing:"-0.8px",lineHeight:1,marginBottom:4}}>{val}</div>
      {sub&&<div style={{fontSize:9,color:color,opacity:0.6,marginBottom:3}}>{sub}</div>}
      <div style={{fontSize:9,color:color,fontWeight:600,letterSpacing:"0",opacity:0.7}}>{label}</div>
    </div>
  );

  return(
    <div>
      {/* Header */}
      <div style={{marginBottom:20}}>
        <div style={{fontWeight:700,fontSize:20,color:"#ECEEF2",letterSpacing:"-0.4px"}}>Rendimiento individual</div>
        <div style={{fontSize:11,color:"#7F8692",marginTop:3}}>Análisis detallado por persona y período</div>
      </div>

      {/* Controls */}
      <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end",marginBottom:20}}>
        {/* Member selector */}
        <div>
          <div style={{fontSize:9,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:4}}>Persona</div>
          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
            {INIT_MEMBERS.map(mem=>(
              <button key={mem.name} onClick={()=>setSelectedM(mem.name)} style={{
                background:selectedM===mem.name?mem.color+"22":"#232831",
                color:selectedM===mem.name?mem.color:"#C3C8D0",
                border:`1.5px solid ${selectedM===mem.name?mem.color+"44":"#2E343E"}`,
                borderRadius:99,padding:"5px 12px",fontSize:11,fontWeight:selectedM===mem.name?700:400,
                cursor:"pointer",fontFamily:"inherit",transition:"all .12s",
              }}>{mem.name}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end",marginBottom:20}}>
        {/* Period */}
        <div>
          <div style={{fontSize:9,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:4}}>Período</div>
          <div style={{display:"flex",border:"1px solid #2E343E",borderRadius:8,overflow:"hidden"}}>
            {["week","month","custom"].map(p=>(
              <button key={p} onClick={()=>setPeriodo(p)} style={{
                background:periodo===p?"#3A414D":"#232831",color:periodo===p?"#FFF":"#9AA1AC",
                border:"none",padding:"7px 14px",fontSize:11,fontWeight:periodo===p?700:400,
                cursor:"pointer",fontFamily:"inherit",
              }}>{PERIODO_LABELS[p]}</button>
            ))}
          </div>
        </div>
        {periodo==="custom"&&(<>
          <div>
            <div style={{fontSize:9,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:4}}>Desde</div>
            <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{border:"1px solid #2E343E",borderRadius:7,padding:"7px 10px",fontSize:11,fontFamily:"inherit",outline:"none"}}/>
          </div>
          <div>
            <div style={{fontSize:9,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:4}}>Hasta</div>
            <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{border:"1px solid #2E343E",borderRadius:7,padding:"7px 10px",fontSize:11,fontFamily:"inherit",outline:"none"}}/>
          </div>
        </>)}
        <button onClick={recargarHoras} style={{
          background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,
          padding:"8px 20px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",
          boxShadow:"0 2px 8px rgba(30,58,95,0.3)",
        }}>🔄 Actualizar horas</button>
      </div>

      {/* Member header card */}
      <div style={{background:(m?.color||"#323844")+"18",borderRadius:16,padding:"20px 24px",marginBottom:20,display:"flex",alignItems:"center",gap:16}}>
        <div style={{width:52,height:52,borderRadius:14,background:m?.color||"#323844",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:500,color:"#FFF",flexShrink:0}}>
          {selectedM[0]}
        </div>
        <div style={{flex:1}}>
          <div style={{fontSize:18,fontWeight:500,color:m?.color||"#D5D9E0",letterSpacing:"-0.4px"}}>{selectedM}</div>
          <div style={{fontSize:11,color:m?.color||"#D5D9E0",opacity:0.6,marginTop:2}}>
            {PERIODO_LABELS[periodo]} · {proyActivos.length>0?`${proyActivos.length} proyecto${proyActivos.length!==1?"s":""} activo${proyActivos.length!==1?"s":""}`:"-"}
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:26,fontWeight:500,letterSpacing:"-1px",color:beneficio>=0?"#059669":"#EB8484"}}>{beneficio>=0?"+":""}{beneficio.toFixed(0)}€</div>
          <div style={{fontSize:10,color:m?.color||"#D5D9E0",opacity:0.5}}>Beneficio del período</div>
        </div>
      </div>

      {/* KPI grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10,marginBottom:20}}>
        <KPI label="Bookpoints" val={totalBP} sub={`${mBP.length} lecturas`} color="#E8501C" bg="#452311"/>
        <KPI label="CV cerradas" val={totalCV} sub={`${totalLV} LV`} color="#0EA5E9" bg="#113145"/>
        <KPI label="Facturación" val={totalFact.toFixed(0)+"€"} sub={totalOI>0?`+${totalOI.toFixed(0)}€ OI`:""} color="#059669" bg="#11452D"/>
        <KPI label="Gastos" val={totalGasTot.toFixed(0)+"€"} sub={`${mGas.length+mHojas.length} reg.`} color="#DC2626" bg="#451111"/>
        <KPI label="Horas" val={horasLoaded?fmtH(totalSecs):"—"} sub={horasLoaded?`${proyHoras.length} proyectos`:""} color="#7C3AED" bg="#1A1145"/>
        <KPI label="€/hora real" val={euroHora!==null&&horasLoaded?euroHora.toFixed(2)+"€":"—"} sub={costeSMI>0?`SMI: ${costeSMI.toFixed(0)}€`:""} color={euroHora!==null&&euroHora>=17?"#059669":"#DC2626"} bg={euroHora!==null&&euroHora>=17?"#11452D":"#451111"}/>
        {efectividad!==null&&<KPI label="Efectividad CV" val={`${efectividad}%`} sub={`${totalCV}/${totalCV+totalLV}`} color="#F59E0B" bg="#453B11"/>}
        <KPI label="Proyectos activos" val={String(proyActivos.length||0)} sub={proyActivos.slice(0,2).join(", ")||"-"} color="#C3C8D0" bg="#232831"/>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}} className="blesk-grid-2">

        {/* Horas por proyecto */}
        {horasLoaded&&(
          <div style={{background:"#232831",borderRadius:14,border:"1px solid #2E343E",padding:"16px 18px",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
            <div style={{fontSize:11,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:14}}>⏱ Horas por proyecto</div>
            {proyHoras.length>0?proyHoras.map(([pname,secs],i)=>{
              const pct=Math.round(secs/totalSecs*100);
              const col=PROJ_COLORS[i%PROJ_COLORS.length];
              return(
                <div key={pname} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:8,height:8,borderRadius:99,background:col,flexShrink:0}}/>
                      <span style={{fontSize:12,color:"#C3C8D0",fontWeight:500}}>{pname}</span>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      <span style={{fontSize:10,color:"#9AA1AC"}}>{pct}%</span>
                      <span style={{fontSize:12,fontWeight:700,color:"#ECEEF2"}}>{fmtH(secs)}</span>
                    </div>
                  </div>
                  <div style={{height:5,background:"#1E2B38",borderRadius:99,overflow:"hidden"}}>
                    <div style={{height:5,background:col,width:`${pct}%`,borderRadius:99,transition:"width .4s"}}/>
                  </div>
                </div>
              );
            }):<div style={{fontSize:11,color:"#9AA1AC",fontStyle:"italic"}}>Sin horas registradas este período</div>}
            {totalSecs>0&&(
              <div style={{marginTop:12,paddingTop:10,borderTop:"1px solid #364D63",display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:11,color:"#9AA1AC"}}>Total</span>
                <span style={{fontSize:13,fontWeight:700,color:"#D5D9E0"}}>{fmtH(totalSecs)}</span>
              </div>
            )}
          </div>
        )}

        {/* Bookpoints del período */}
        <div style={{background:"#232831",borderRadius:14,border:"1px solid #2E343E",padding:"16px 18px",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{fontSize:11,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:14}}>📚 Bookpoints del período</div>
          {mBP.length>0?mBP.sort((a,b)=>b.puntos-a.puntos).map((r,i)=>(
            <div key={r.id} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"6px 0",borderBottom:i<mBP.length-1?"1px solid #364863":"none"}}>
              <div style={{flex:1}}>
                <div style={{fontSize:12,color:"#ECEEF2",fontWeight:600,lineHeight:1.3}}>{r.libro||"Sin título"}</div>
                {r.autor&&<div style={{fontSize:10,color:"#9AA1AC"}}>{r.autor}</div>}
                {r.fecha&&<div style={{fontSize:9,color:"#7F8692"}}>{r.fecha}</div>}
              </div>
              <div style={{fontSize:15,fontWeight:700,color:"#E8501C",marginLeft:10,flexShrink:0}}>+{r.puntos}</div>
            </div>
          )):<div style={{fontSize:11,color:"#9AA1AC",fontStyle:"italic"}}>Sin bookpoints este período</div>}
        </div>

        {/* Customers del período */}
        <div style={{background:"#232831",borderRadius:14,border:"1px solid #2E343E",padding:"16px 18px",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{fontSize:11,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px",marginBottom:14}}>🤝 Visitas del período</div>
          {mCV.length>0?[...mCV].sort((a,b)=>{
            const pd=f=>{if(!f)return 0;const[d,m,y]=f.split("/");return new Date(y,m-1,d).getTime();};
            return pd(b.fecha)-pd(a.fecha);
          }).map((r,i)=>{
            const isCV=r.cat==="CV";
            return(
            <div key={r.id} style={{display:"flex",gap:10,padding:"7px 0",borderBottom:i<mCV.length-1?"1px solid #364863":"none",alignItems:"center"}}>
              <div style={{width:32,height:32,borderRadius:8,background:isCV?"#11452D":"#452311",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:isCV?"#059669":"#E8501C",flexShrink:0,border:`1.5px solid ${isCV?"#1F7A50":"#1F317A"}`}}>{r.cat||"CV"}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,color:"#ECEEF2",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.cliente||"Sin cliente"}</div>
                <div style={{fontSize:10,color:"#9AA1AC",display:"flex",gap:6,flexWrap:"wrap"}}>
                  {r.proyecto&&<span>📁 {r.proyecto}</span>}
                  {r.fecha&&<span>📅 {r.fecha}</span>}
                  {r.motorola&&<span style={{color:"#E8501C"}}>📝 Motorola</span>}
                </div>
              </div>
            </div>
          )}):<div style={{fontSize:11,color:"#9AA1AC",fontStyle:"italic"}}>Sin visitas este período</div>}
        </div>

        {/* Facturas del período — desglose de dónde viene cada euro */}
        <div style={{background:"#232831",borderRadius:14,border:"1px solid #2E343E",padding:"16px 18px",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <div style={{fontSize:11,color:"#9AA1AC",fontWeight:600,letterSpacing:"0.3px"}}>💰 De dónde viene el dinero</div>
            {mFact.length>0&&<div style={{fontSize:12,fontWeight:800,color:"#059669"}}>{totalFact.toFixed(0)}€ total</div>}
          </div>
          {mFact.length>0?(()=>{
            const sorted = mFact.sort((a,b)=>{
              const ra=a.reparto?.find(x=>x.member===selectedM);
              const rb=b.reparto?.find(x=>x.member===selectedM);
              return (parseFloat(rb?.importe)||0)-(parseFloat(ra?.importe)||0);
            });
            return sorted.map((r,i)=>{
              const rep=r.reparto?.find(x=>x.member===selectedM);
              const importe=repImporte(r,selectedM);
              const pct=totalFact>0?((Math.abs(importe)/totalFact)*100).toFixed(0):0;
              const proj=projects?.find(p=>p.name===r.proyecto);
              return(
                <div key={r.id} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <span style={{fontSize:12,fontWeight:700,color:"#ECEEF2"}}>{r.ref||"—"}</span>
                        {r.proyecto&&<span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:99,background:proj?.light||"#262B34",color:proj?.color||"#C3C8D0"}}>{r.proyecto}</span>}
                      </div>
                      <div style={{fontSize:10,color:"#9AA1AC",marginTop:1}}>
                        {r.descripcion&&<span>{r.descripcion}</span>}
                        {r.fecha&&<span> · {r.fecha}</span>}
                        {rep?.pct&&<span style={{color:"#7F8692"}}> · {rep.pct}% de {parseFloat(r.base||0).toFixed(0)}€</span>}
                      </div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0,marginLeft:10}}>
                      <div style={{fontSize:14,fontWeight:800,color:importe<0?"#EC8383":"#059669"}}>{importe<0?"−":"+"}{Math.abs(importe).toFixed(0)}€</div>
                      <div style={{fontSize:9,color:"#7F8692"}}>{pct}% de tus ingresos</div>
                    </div>
                  </div>
                  <div style={{height:5,background:"#2E343E",borderRadius:99,overflow:"hidden"}}>
                    <div style={{height:5,background:proj?.color||"#059669",width:`${pct}%`,borderRadius:99,transition:"width .5s"}}/>
                  </div>
                </div>
              );
            });
          })():<div style={{fontSize:11,color:"#9AA1AC",fontStyle:"italic"}}>Sin facturas este período</div>}
          {totalOI>0&&(
            <div style={{marginTop:12,paddingTop:10,borderTop:"1px solid #2E343E"}}>
              <div style={{fontSize:10,color:"#9AA1AC",fontWeight:600,letterSpacing:".3px",marginBottom:8}}>+ Otros ingresos (OI)</div>
              {mOI.map((r,i)=>{
                const rep=r.reparto?.find(x=>x.member===selectedM);
                const importe=parseFloat(rep?.importe||0);
                return(
                  <div key={r.id} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:i<mOI.length-1?"1px solid #364863":"none",fontSize:11}}>
                    <div>
                      <span style={{fontWeight:600,color:"#ECEEF2"}}>{r.ref||"OI"}</span>
                      {r.descripcion&&<span style={{color:"#9AA1AC"}}> · {r.descripcion}</span>}
                    </div>
                    <span style={{fontWeight:700,color:"#E8501C"}}>+{importe.toFixed(0)}€</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function DesgloseMovimientos({items, total, color, titulo, emptyMsg}){
  const [verTodas, setVerTodas] = useState(false);
  if(!items.length) return null;
  const visible = verTodas ? items : items.slice(0,8);
  return(
    <div style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <div style={{fontSize:10,color:"#7F8692",fontWeight:600,letterSpacing:"0"}}>{titulo}</div>
        <div style={{fontSize:13,fontWeight:800,color}}>{total.toFixed(0)}€</div>
      </div>
      {visible.map((item,i)=>(
        <div key={item.id} style={{marginBottom:8}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                <span style={{fontSize:11,fontWeight:600,color:"#ECEEF2"}}>{item.ref||"—"}</span>
                {item.proyBadge}
              </div>
              {item.descripcion&&<div style={{fontSize:9,color:"#7F8692",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.descripcion}</div>}
            </div>
            <div style={{textAlign:"right",flexShrink:0,marginLeft:8}}>
              <div style={{fontSize:12,fontWeight:700,color}}>{item.signo}{item.importe.toFixed(0)}€</div>
              <div style={{fontSize:8,color:"#7F8692"}}>{item.pct}%</div>
            </div>
          </div>
          <div style={{height:4,background:"#2E343E",borderRadius:99,overflow:"hidden"}}>
            <div style={{height:4,background:item.barColor||color,width:`${item.pct}%`,borderRadius:99}}/>
          </div>
        </div>
      ))}
      {items.length>8&&(
        <button onClick={()=>setVerTodas(v=>!v)}
          style={{width:"100%",background:"#262B34",border:"1px solid #2E343E",borderRadius:8,padding:"7px",fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:"#C3C8D0",marginTop:4}}>
          {verTodas?`▲ Ver menos`:`▼ Ver todas (${items.length})`}
        </button>
      )}
    </div>
  );
}
function DesgloseFacturas({ing, gas, hojas, projects, memberName}){
  // Ingresos
  const mIng = (ing||[]).filter(r=>r.reparto?.some(x=>x.member===memberName&&parseFloat(x.importe)>0));
  const totalIng = mIng.reduce((s,r)=>{return s+repImporte(r,memberName);},0);
  const sortedIng = [...mIng].sort((a,b)=>{
    const ra=a.reparto?.find(x=>x.member===memberName);
    const rb=b.reparto?.find(x=>x.member===memberName);
    return (parseFloat(rb?.importe)||0)-(parseFloat(ra?.importe)||0);
  }).map(r=>{
    const signed=repImporte(r,memberName);
    const importe=Math.abs(signed);
    const pct=totalIng>0?Math.round((importe/totalIng)*100):0;
    const proj=projects?.find(p=>p.name===r.proyecto);
    return {id:r.id,ref:r.ref,descripcion:r.descripcion,importe,pct,signo:signed<0?"-":"+",
      barColor:proj?.color||"#059669",
      proyBadge:r.proyecto?<span style={{fontSize:8,fontWeight:700,padding:"1px 5px",borderRadius:99,background:proj?.light||"#262B34",color:proj?.color||"#C3C8D0"}}>{r.proyecto}</span>:null};
  });
  // Gastos facturas
  const mGas = (gas||[]).filter(r=>r.reparto?.some(x=>x.member===memberName&&parseFloat(x.importe)>0));
  // Gastos hojas
  const mHojas = (hojas||[]).filter(r=>r.reparto?.some(x=>x.member===memberName&&parseFloat(x.importe)>0)||r.responsable===memberName);
  const totalGas = mGas.reduce((s,r)=>{return s+repImporte(r,memberName);},0)
    + mHojas.reduce((s,r)=>{const rep=r.reparto?.find(x=>x.member===memberName);return rep?s+(parseFloat(rep.importe)||0):s+(parseFloat(r.importe)||0);},0);
  const sortedGas = [...mGas].sort((a,b)=>{
    const ra=a.reparto?.find(x=>x.member===memberName);
    const rb=b.reparto?.find(x=>x.member===memberName);
    return (parseFloat(rb?.importe)||0)-(parseFloat(ra?.importe)||0);
  }).map(r=>{
    const signed=repImporte(r,memberName);
    const importe=Math.abs(signed);
    const pct=totalGas>0?Math.round((importe/totalGas)*100):0;
    const proj=projects?.find(p=>p.name===r.proyecto);
    return {id:r.id,ref:r.ref,descripcion:r.descripcion,importe,pct,signo:signed<0?"+":"-",
      barColor:proj?.color||"#DC2626",
      proyBadge:r.proyecto?<span style={{fontSize:8,fontWeight:700,padding:"1px 5px",borderRadius:99,background:proj?.light||"#262B34",color:proj?.color||"#C3C8D0"}}>{r.proyecto}</span>:null};
  });
  const sortedHojas = [...mHojas].map(r=>{
    const rep=r.reparto?.find(x=>x.member===memberName);
    const importe=rep?parseFloat(rep.importe)||0:parseFloat(r.importe)||0;
    const pct=totalGas>0?Math.round((importe/totalGas)*100):0;
    const proj=projects?.find(p=>p.name===r.proyecto);
    return {id:"h"+r.id,ref:"HG",descripcion:r.concepto||r.descripcion,importe,pct,signo:"-",
      barColor:proj?.color||"#DC2626",
      proyBadge:r.proyecto?<span style={{fontSize:8,fontWeight:700,padding:"1px 5px",borderRadius:99,background:proj?.light||"#262B34",color:proj?.color||"#C3C8D0"}}>{r.proyecto}</span>:null};
  });
  const allGas = [...sortedGas,...sortedHojas].sort((a,b)=>b.importe-a.importe);
  if(!sortedIng.length&&!allGas.length) return null;
  return(
    <div>
      <DesgloseMovimientos items={sortedIng} total={totalIng} color="#059669" titulo="💰 De dónde viene el dinero"/>
      {allGas.length>0&&<DesgloseMovimientos items={allGas} total={totalGas} color="#DC2626" titulo="💸 En qué se ha gastado"/>}
    </div>
  );
}

// ── EQUIPO TAB ────────────────────────────────────────────────────────────────
function MiniBar({val,max,color}){
  const pct=max>0?Math.min(val/max*100,100):0;
  return(
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <div style={{flex:1,background:"#2E343E",borderRadius:99,height:6,overflow:"hidden"}}>
        <div style={{width:`${pct}%`,height:"100%",background:color,borderRadius:99,transition:"width .5s"}}/>
      </div>
      <span style={{fontSize:9,color:"#9AA1AC",minWidth:28,textAlign:"right"}}>{Math.round(pct)}%</span>
    </div>
  );
}

function EquipoTab({bp,cv,ing,gas,hojas,projects}){
  const [selectedMember,setSelectedMember] = useState(null);
  const [verTodasFacturas,setVerTodasFacturas] = useState(false);
  const [memberColors,setMemberColors] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("blesk_member_colors")||"{}"); }catch{ return {}; }
  });
  const [colorEditModal,setColorEditModal] = useState(null); // member name
  const [tmpColor,setTmpColor] = useState("");
  const PALETTE_OPTIONS = ["#D5D9E0","#7C3AED","#059669","#DC2626","#D97706","#0891B2","#DB2777","#65A30D","#9333EA","#EA580C","#C3C8D0","#0F4C75","#1A1A2E","#2D6A4F","#4A1942","#7B2D00","#E8501C","#8B5CF6","#EC4899","#EF4444","#F97316","#EAB308","#22C55E","#14B8A6"];

  function getMemberColor(name){
    return (memberColors[name]&&aClaro(memberColors[name])) || INIT_MEMBERS.find(m=>m.name===name)?.color || "#C3C8D0";
  }
  function saveMemberColor(name, color){
    const next = {...memberColors,[name]:color};
    setMemberColors(next);
    try{ localStorage.setItem("blesk_member_colors",JSON.stringify(next)); }catch{}
    // Also save to Supabase
    sb.from("member_colors").upsert({name,color},{onConflict:"name"}).then(()=>{});
  }

  // Todos (para que los totales del equipo cuadren) y visibles (sin los que ya no están en LEINN)
  const [otrosEq,setOtrosEq]=useState([]);
  useEffect(()=>{ bancoLoad().then(m=>setOtrosEq(otrosDeBanco(m))).catch(()=>{}); },[]);
  const statsTodos = INIT_MEMBERS.map(m=>({...m,...statsMiembro(m.name,{bp,cv,ing,gas,hojas,otros:otrosEq}),color:getMemberColor(m.name)}));
  const stats = statsTodos.filter(m=>!MIEMBROS_OCULTOS.includes(m.name));

  const maxPts=Math.max(...stats.map(s=>s.pts),1);
  const maxCV=Math.max(...stats.map(s=>s.cvCount),1);
  const maxNeto=Math.max(...stats.map(s=>Math.abs(s.neto)),1);
  const maxFact=Math.max(...stats.map(s=>s.totIng),1);

  // Rankings
  const rankBP=[...stats].sort((a,b)=>b.pts-a.pts);
  const rankCV=[...stats].sort((a,b)=>b.cvCount-a.cvCount);
  const rankNeto=[...stats].sort((a,b)=>b.neto-a.neto);
  const rankFact=[...stats].sort((a,b)=>b.totIng-a.totIng);

  // Team totals
  const teamPts=statsTodos.reduce((s,m)=>s+m.pts,0);
  const teamCV=statsTodos.reduce((s,m)=>s+m.cvCount,0);
  const teamLV=statsTodos.reduce((s,m)=>s+m.lvCount,0);
  const teamIng=statsTodos.reduce((s,m)=>s+m.totIng,0);
  const teamGas=statsTodos.reduce((s,m)=>s+m.totGas,0);
  const teamNeto=teamIng-teamGas;

  return(
    <>
    <div>
      {/* Team KPIs */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10,marginBottom:24}}>
        {[
          {label:"Bookpoints",val:String(teamPts),color:"#9896D9",bg:"#452311",accent:"#E8501C",sub:"Meta: "+(INIT_MEMBERS.length*META_BP)},
          {label:"CV totales",val:String(teamCV),color:"#7EC7F1",bg:"#113145",accent:"#0EA5E9"},
          {label:"LV totales",val:String(teamLV),color:"#8CE3AF",bg:"#11452D",accent:"#10B981"},
          {label:"Ingresos",val:teamIng.toFixed(0)+"€",color:"#7BF4D2",bg:"#11452B",accent:"#059669"},
          {label:"Gastos",val:teamGas.toFixed(0)+"€",color:"#E48B8B",bg:"#451115",accent:"#EF4444"},
          {label:"Neto equipo",val:(teamNeto>=0?"+":"")+teamNeto.toFixed(0)+"€",color:teamNeto>=0?"#7BF4D2":"#E48B8B",bg:teamNeto>=0?"#11452B":"#451111",accent:teamNeto>=0?"#059669":"#EF4444"},
        ].map(k=>(
          <div key={k.label} style={{background:k.bg,borderRadius:14,padding:"16px 18px",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:k.accent,borderRadius:"14px 14px 0 0"}}/>
            <div style={{fontSize:26,fontWeight:500,color:k.color,letterSpacing:"-1.5px",lineHeight:1,marginBottom:6}}>{k.val}</div>
            <div style={{fontSize:10,color:k.accent,fontWeight:600,letterSpacing:"0"}}>{k.label}</div>
            {k.sub&&<div style={{fontSize:9,color:k.color,opacity:0.5,marginTop:2}}>{k.sub}</div>}
          </div>
        ))}
      </div>

      {/* Color edit modal */}
      {colorEditModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#1F232B",borderRadius:16,padding:"28px 32px",minWidth:360,boxShadow:"0 20px 60px rgba(0,0,0,0.15)"}}>
            <div style={{fontWeight:600,fontSize:15,color:"#ECEEF2",marginBottom:2,letterSpacing:"-0.3px"}}>Color de {colorEditModal}</div>
            <div style={{fontSize:11,color:"#7F8692",marginBottom:20}}>Elige un color para identificar al miembro</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
              {PALETTE_OPTIONS.map(c=>(
                <button key={c} onClick={()=>setTmpColor(c)}
                  style={{width:28,height:28,borderRadius:7,background:c,border:tmpColor===c?"3px solid #111":"2px solid #2E343E",cursor:"pointer",transition:"transform .1s",transform:tmpColor===c?"scale(1.15)":"scale(1)"}}/>
              ))}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:20}}>
              <div style={{fontSize:10,color:"#7F8692"}}>Personalizado:</div>
              <input type="color" value={tmpColor} onChange={e=>setTmpColor(e.target.value)}
                style={{width:32,height:26,border:"1.5px solid #2E343E",borderRadius:6,padding:2,cursor:"pointer",background:"none"}}/>
              <div style={{width:50,height:26,borderRadius:6,background:tmpColor,border:"1px solid #2E343E"}}/>
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>setColorEditModal(null)} style={{background:"#262B34",color:"#C3C8D0",border:"none",borderRadius:8,padding:"9px 18px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
              <button onClick={()=>{saveMemberColor(colorEditModal,tmpColor);setColorEditModal(null);}} style={{background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"9px 20px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Member cards grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12,marginBottom:18}}>
        {stats.map((m,i)=>{
          const rankPos_bp=rankBP.findIndex(x=>x.name===m.name)+1;
          const rankPos_cv=rankCV.findIndex(x=>x.name===m.name)+1;
          const bg=m.color+"18";
          return(
            <div key={m.name} style={{background:bg,borderRadius:16,padding:"18px 20px",position:"relative",cursor:"pointer",transition:"transform .15s"}} onMouseEnter={e=>e.currentTarget.style.transform="translateY(-2px)"} onMouseLeave={e=>e.currentTarget.style.transform="translateY(0)"} onClick={()=>{setSelectedMember(m.name);setVerTodasFacturas(false);}}>
              {/* Color edit button */}
              <button onClick={e=>{e.stopPropagation();setTmpColor(m.color);setColorEditModal(m.name);}}
                style={{position:"absolute",top:12,right:12,background:"rgba(255,255,255,0.6)",border:"none",borderRadius:6,width:24,height:24,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:m.color}}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              </button>
              {/* Header */}
              <div style={{marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                  <div style={{background:m.color,width:36,height:36,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:600,color:"#FFF",fontSize:14,flexShrink:0}}>
                    {m.name[0]}
                  </div>
                  <div>
                    <div style={{fontSize:14,fontWeight:600,color:m.color,letterSpacing:"-0.3px"}}>{m.name}</div>
                    <div style={{display:"flex",gap:4,marginTop:2}}>
                      {rankPos_bp<=3&&<span style={{background:m.color+"33",color:m.color,fontSize:9,fontWeight:600,padding:"1px 6px",borderRadius:99}}>#{rankPos_bp} BP</span>}
                      {rankPos_cv<=3&&<span style={{background:m.color+"33",color:m.color,fontSize:9,fontWeight:600,padding:"1px 6px",borderRadius:99}}>#{rankPos_cv} CV</span>}
                    </div>
                  </div>
                </div>
                <div style={{fontSize:26,fontWeight:500,color:m.color,letterSpacing:"-1.5px",lineHeight:1}}>{m.neto>=0?"+":""}{m.neto.toFixed(0)}€</div>
                <div style={{fontSize:11,color:m.color,opacity:0.6,marginTop:3}}>Beneficio neto</div>
              </div>
              {/* Stats */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
                {[
                  {label:"Bookpoints",val:m.pts},
                  {label:"CV",val:m.cvCount},
                  {label:"LV",val:m.lvCount},
                ].map(k=>(
                  <div key={k.label} style={{textAlign:"center"}}>
                    <div style={{fontSize:16,fontWeight:600,color:m.color}}>{k.val}</div>
                    <div style={{fontSize:9,color:m.color,opacity:0.55,letterSpacing:"0.3px"}}>{k.label}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:6}}>
                <div style={{flex:1,background:"rgba(255,255,255,0.5)",borderRadius:8,padding:"5px 8px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:m.color,opacity:0.6}}>Ingresos</div>
                  <div style={{fontSize:12,fontWeight:600,color:m.color}}>{m.totIng.toFixed(0)}€</div>
                </div>
                <div style={{flex:1,background:"rgba(255,255,255,0.5)",borderRadius:8,padding:"5px 8px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:m.color,opacity:0.6}}>Gastos</div>
                  <div style={{fontSize:12,fontWeight:600,color:m.color}}>{m.totGas.toFixed(0)}€</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Rankings + Gráfico */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr) 1.4fr",gap:10,marginBottom:10}} className="blesk-rankings">
        {[
          {title:"🏆 Ranking Bookpoints",rank:rankBP,val:s=>`${s.pts} pts`,bar:s=>s.pts,max:maxPts,color:"#E8501C",bg:"#452311"},
          {title:"🤝 Ranking Customers",rank:rankCV,val:s=>`${s.cvCount} CV`,bar:s=>s.cvCount,max:maxCV,color:"#0EA5E9",bg:"#113145"},
          {title:"💶 Ranking Beneficio",rank:rankNeto,val:s=>`${s.neto>=0?"+":""}${s.neto.toFixed(0)}€`,bar:s=>Math.max(s.neto,0),max:maxNeto,color:"#10B981",bg:"#11452D"},
          {title:"💰 Ranking Facturación",rank:rankFact,val:s=>`${s.totIng.toFixed(0)}€`,bar:s=>s.totIng,max:maxFact,color:"#F59E0B",bg:"#453B11"},
        ].map(r=>(
          <div key={r.title} style={{background:"#1F232B",borderRadius:12,overflow:"hidden",border:"1px solid #2E343E",boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
            <div style={{background:r.color,padding:"10px 14px"}}>
              <span style={{color:"#FFF",fontWeight:700,fontSize:12}}>{r.title}</span>
            </div>
            <div style={{padding:"10px 14px"}}>
              {r.rank.map((m,i)=>(
                <div key={m.name} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <div style={{width:20,height:20,borderRadius:99,background:i===0?"#453D11":i===1?"#C0C0C0":i===2?"#CD7F32":r.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:900,color:i<3?"#FFF":r.color,flexShrink:0}}>
                    {i+1}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <span style={{fontSize:11,fontWeight:700,color:m.color}}>{m.name}</span>
                      <span style={{fontSize:10,fontWeight:700,color:r.color}}>{r.val(m)}</span>
                    </div>
                    <MiniBar val={r.bar(m)} max={r.max} color={r.color}/>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {/* Gráfico Ingresos vs Gastos en el tiempo */}
        {(()=>{
          // Build monthly data from ing + gas + hojas
          const parseM = f => { if(!f) return null; const p=f.split('/'); return p.length===3?`${p[2]}/${p[1].padStart(2,'0')}`:null; };
          const months = {};
          ing.forEach(r=>{ const m=parseM(r.fecha); if(m){ if(!months[m]) months[m]={m,ing:0,gas:0}; months[m].ing+=signedBase(r); }});
          gas.forEach(r=>{ const m=parseM(r.fecha); if(m){ if(!months[m]) months[m]={m,ing:0,gas:0}; months[m].gas+=signedBase(r); }});
          hojas.forEach(r=>{ const m=parseM(r.fecha); if(m){ if(!months[m]) months[m]={m,ing:0,gas:0}; months[m].gas+=(parseFloat(r.importe)||0); }});
          const data = Object.values(months).sort((a,b)=>a.m.localeCompare(b.m));
          if(data.length===0) return(
            <div style={{background:"#232831",borderRadius:12,border:"1px solid #2E343E",padding:20,display:"flex",alignItems:"center",justifyContent:"center",color:"#9AA1AC",fontSize:11}}>
              Sin datos para el gráfico
            </div>
          );
          const maxVal = Math.max(...data.map(d=>Math.max(d.ing,d.gas)),1);
          const W=100/data.length;
          const H=160;
          const toY = v => H - (v/maxVal)*H*0.85;
          const ingPts = data.map((d,i)=>`${i*W+W/2},${toY(d.ing)}`).join(' ');
          const gasPts = data.map((d,i)=>`${i*W+W/2},${toY(d.gas)}`).join(' ');
          const ingArea = `0,${H} ${ingPts} ${(data.length-1)*W+W/2},${H}`;
          const gasArea = `0,${H} ${gasPts} ${(data.length-1)*W+W/2},${H}`;
          return(
            <div style={{background:"#232831",borderRadius:12,border:"1px solid #2E343E",overflow:"hidden"}}>
              <div style={{padding:"10px 14px",borderBottom:"1px solid #635A36",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontWeight:700,fontSize:12,color:"#D5D9E0"}}>📈 Ingresos vs Gastos</span>
                <div style={{display:"flex",gap:10,fontSize:9,color:"#9AA1AC"}}>
                  <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:10,height:3,background:"#059669",borderRadius:99,display:"inline-block"}}/>Ingresos</span>
                  <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:10,height:3,background:"#DC2626",borderRadius:99,display:"inline-block"}}/>Gastos</span>
                </div>
              </div>
              <div style={{padding:"12px 14px"}}>
                <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" style={{width:"100%",height:H,display:"block"}}>
                  <defs>
                    <linearGradient id="gIng" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#059669" stopOpacity="0.15"/><stop offset="100%" stopColor="#059669" stopOpacity="0"/></linearGradient>
                    <linearGradient id="gGas" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#DC2626" stopOpacity="0.15"/><stop offset="100%" stopColor="#DC2626" stopOpacity="0"/></linearGradient>
                  </defs>
                  {/* Grid lines */}
                  {[0.25,0.5,0.75,1].map(l=>(
                    <line key={l} x1="0" y1={toY(maxVal*l)} x2="100" y2={toY(maxVal*l)} stroke="#1E2B38" strokeWidth="0.3"/>
                  ))}
                  {/* Areas */}
                  <polygon points={ingArea} fill="url(#gIng)"/>
                  <polygon points={gasArea} fill="url(#gGas)"/>
                  {/* Lines */}
                  <polyline points={ingPts} fill="none" stroke="#059669" strokeWidth="0.8" strokeLinejoin="round"/>
                  <polyline points={gasPts} fill="none" stroke="#DC2626" strokeWidth="0.8" strokeLinejoin="round"/>
                  {/* Dots */}
                  {data.map((d,i)=>(
                    <g key={i}>
                      <circle cx={i*W+W/2} cy={toY(d.ing)} r="1.2" fill="#059669"/>
                      <circle cx={i*W+W/2} cy={toY(d.gas)} r="1.2" fill="#DC2626"/>
                    </g>
                  ))}
                </svg>
                {/* X axis labels */}
                <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                  {data.filter((_,i)=>i===0||i===Math.floor(data.length/2)||i===data.length-1).map(d=>(
                    <span key={d.m} style={{fontSize:8,color:"#9AA1AC"}}>{d.m.split('/').reverse().join('/')}</span>
                  ))}
                </div>
                {/* Summary */}
                <div style={{display:"flex",gap:8,marginTop:8}}>
                  {[
                    {label:"Total ing.",val:`${ing.reduce((s,r)=>s+signedBase(r),0).toFixed(0)}€`,color:"#059669"},
                    {label:"Total gas.",val:`${(gas.reduce((s,r)=>s+signedBase(r),0)+hojas.reduce((s,r)=>s+(parseFloat(r.importe)||0),0)).toFixed(0)}€`,color:"#EB8484"},
                  ].map(k=>(
                    <div key={k.label} style={{flex:1,background:"#15181D",borderRadius:7,padding:"6px 8px"}}>
                      <div style={{fontSize:8,color:"#9AA1AC"}}>{k.label}</div>
                      <div style={{fontSize:12,fontWeight:700,color:k.color}}>{k.val}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Member detail modal */}
      {selectedMember&&(()=>{
        const m=stats.find(x=>x.name===selectedMember);
        if(!m) return null;
        const mCV=(cv[m.name]||[]).filter(r=>r.cat==="CV");
        const mLV=(cv[m.name]||[]).filter(r=>r.cat==="LV");
        const mBP=(bp[m.name]||[]);
        const bg=m.color+"18";
        return(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setSelectedMember(null)}>
            <div style={{background:"#1F232B",borderRadius:20,maxWidth:480,width:"90%",maxHeight:"85vh",overflowY:"auto",boxShadow:"0 24px 64px rgba(0,0,0,0.2)"}} onClick={e=>e.stopPropagation()}>
              {/* Header */}
              <div style={{background:bg,borderRadius:"20px 20px 0 0",padding:"24px 28px",position:"relative"}}>
                <button onClick={()=>setSelectedMember(null)} style={{position:"absolute",top:16,right:16,background:"rgba(255,255,255,0.6)",border:"none",borderRadius:8,width:28,height:28,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:m.color}}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
                  <div style={{background:m.color,width:48,height:48,borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,color:"#FFF",fontWeight:500}}>{m.name[0]}</div>
                  <div>
                    <div style={{fontSize:20,fontWeight:500,color:m.color,letterSpacing:"-0.5px"}}>{m.name}</div>
                    <div style={{fontSize:11,color:m.color,opacity:0.6}}>{EMPRESA}</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10}}>
                  {[
                    {label:"Bookpoints",val:m.pts},
                    {label:"CV",val:m.cvCount},
                    {label:"LV",val:m.lvCount},
                    {label:"Neto",val:(m.neto>=0?"+":"")+m.neto.toFixed(0)+"€"},
                  ].map(k=>(
                    <div key={k.label} style={{background:"rgba(255,255,255,0.5)",borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
                      <div style={{fontSize:18,fontWeight:500,color:m.color}}>{k.val}</div>
                      <div style={{fontSize:9,color:m.color,opacity:0.6,letterSpacing:"0.3px"}}>{k.label}</div>
                    </div>
                  ))}
                </div>
              </div>
              {/* Body */}
              <div style={{padding:"20px 28px"}}>
                {/* Finanzas */}
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:10,color:"#7F8692",fontWeight:600,letterSpacing:"0",marginBottom:10}}>Finanzas</div>
                  <div style={{display:"flex",gap:8}}>
                    {[
                      {label:"Ingresos",val:m.totIng.toFixed(0)+"€",bg:"#11452D",color:"#7BF4D2"},
                      {label:"Gastos",val:m.totGas.toFixed(0)+"€",bg:"#451111",color:"#E48B8B"},
                      {label:"OI",val:m.totOI.toFixed(0)+"€",bg:"#452311",color:"#9896D9"},
                    ].map(k=>(
                      <div key={k.label} style={{flex:1,background:k.bg,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
                        <div style={{fontSize:16,fontWeight:500,color:k.color}}>{k.val}</div>
                        <div style={{fontSize:9,color:k.color,opacity:0.6,letterSpacing:"0.3px"}}>{k.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Últimas CV */}
                {mCV.length>0&&(
                  <div style={{marginBottom:16}}>
                    <div style={{fontSize:10,color:"#7F8692",fontWeight:600,letterSpacing:"0",marginBottom:8}}>Últimas CV ({mCV.length})</div>
                    {mCV.slice(-4).reverse().map((r,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #2E343E",fontSize:12}}>
                        <span style={{color:"#C3C8D0"}}>{r.empresa||r.ref||"—"}</span>
                        <span style={{color:"#7F8692",fontSize:11}}>{r.fecha||""}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Últimos BP */}
                {mBP.length>0&&(
                  <div style={{marginBottom:16}}>
                    <div style={{fontSize:10,color:"#7F8692",fontWeight:600,letterSpacing:"0",marginBottom:8}}>Últimos Bookpoints ({mBP.length})</div>
                    {mBP.slice(-4).reverse().map((r,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #2E343E",fontSize:12}}>
                        <span style={{color:"#C3C8D0"}}>{r.titulo||r.libro||"—"}</span>
                        <span style={{color:"#E8501C",fontWeight:500}}>{r.puntos||0} pts</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* De dónde viene el dinero */}
                <DesgloseFacturas ing={ing} gas={gas} hojas={hojas} projects={projects} memberName={selectedMember}/>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
    </>
  );
}

// ── EVALUACIONES TAB ──────────────────────────────────────────────────────────
const EVAL_ROLES = ['Capitán 🛳️','Chef 👨‍🍳','Pasajero 🧳','Médico 🩺','Jefe de máquinas 🔧'];
const EVAL_ISLANDS = [
  { id:1, emoji:'🏝️', label:'Isla 1 — Liderazgo', color:'#1a6b4a', subjects:['Cooperative Leadership','Personal Cultivation','Self Driven Learning'] },
  { id:2, emoji:'🌴', label:'Isla 2 — Innovación', color:'#F4B97B', subjects:['Change Making Experiments 1','Change Making Experiments 2','Teampreneurship & Customer Co-Creation 1','Teampreneurship & Customer Co-Creation 2'] },
  { id:3, emoji:'🐚', label:'Isla 3 — Comunidad',  color:'#8CAEE3', subjects:['Empathy and Diversity','Team Community Learning','Leading Thoughts'] },
  { id:4, emoji:'💎', label:'Isla 4 — Legal/Fin',  color:'#C597D8', subjects:['Legal','Financial'] },
  { id:5, emoji:'🗺️', label:'Isla 5 — Estrategia', color:'#F47B7B', subjects:['Innovation Strategy','Branding & Communication','Design Thinking','Business Model Creation','Digital & Exponential Technologies'] },
  { id:6, emoji:'🔭', label:'Isla 6 — Feedback',   color:'#95DAC3', subjects:['Feedback 360º'] },
];
const EVAL_COLORS = [
  {id:'verde',    label:'Verde',    hex:'#22c55e'},
  {id:'amarillo', label:'Amarillo', hex:'#eab308'},
  {id:'naranja',  label:'Naranja',  hex:'#f97316'},
  {id:'rojo',     label:'Rojo',     hex:'#ef4444'},
];

function EvaluacionesTab() {
  const [unlocked,    setUnlocked]    = useState(false);
  const [showLock,    setShowLock]    = useState(false);
  const [step,        setStep]        = useState(0); // 0=embarque, 1-6=islas, 7=resumen
  const [members,     setMembers]     = useState(Array.from({length:10},()=>({name:'',role:''})));
  const [scores,      setScores]      = useState({});
  const [saving,      setSaving]      = useState(false);

  // Cargar datos guardados de Supabase al montar
  useEffect(()=>{
    async function load(){
      try {
        const {data:dm} = await sb.from("evaluaciones_members").select("*").order("idx");
        if(dm&&dm.length) setMembers(prev=>{ const m=[...prev]; dm.forEach(r=>{ if(r.idx<10) m[r.idx]={name:r.name||'',role:r.role||''}; }); return m; });
        const {data:ds} = await sb.from("evaluaciones_scores").select("*");
        if(ds&&ds.length){ const map={}; ds.forEach(r=>{ map[r.key]={teamScore:r.team_score||'',color:r.color||'',comment:r.comment||'',memberScores:r.member_scores||Array.from({length:10},()=>({score:''}))}; }); setScores(map); }
      } catch(e){ console.log("evaluaciones load",e); }
    }
    load();
  },[]);

  async function saveMember(idx, field, val){
    setSaving(true);
    try { await sb.from("evaluaciones_members").upsert({idx, name:field==='name'?val:members[idx].name, role:field==='role'?val:members[idx].role},{onConflict:"idx"}); }
    catch(e){ console.error(e); }
    setSaving(false);
  }

  async function saveScore(key, sc){
    setSaving(true);
    try { await sb.from("evaluaciones_scores").upsert({key, team_score:sc.teamScore, color:sc.color, comment:sc.comment, member_scores:sc.memberScores},{onConflict:"key"}); }
    catch(e){ console.error(e); }
    setSaving(false);
  }

  function skKey(ii,si){ return `i${ii}_s${si}`; }
  function initScore(key){
    if(!scores[key]) setScores(prev=>({...prev,[key]:{teamScore:'',color:'',comment:'',memberScores:Array.from({length:10},()=>({score:''}))}}));
  }
  function setTeamScore(key,val){ setScores(prev=>{ const sc={...(prev[key]||{teamScore:'',color:'',comment:'',memberScores:Array.from({length:10},()=>({score:''}))}),teamScore:val}; saveScore(key,sc); return {...prev,[key]:sc}; }); }
  function setColor(key,col){     setScores(prev=>{ const sc={...(prev[key]||{teamScore:'',color:'',comment:'',memberScores:Array.from({length:10},()=>({score:''}))}),color:col}; saveScore(key,sc); return {...prev,[key]:sc}; }); }
  function setComment(key,val){   setScores(prev=>{ const sc={...(prev[key]||{teamScore:'',color:'',comment:'',memberScores:Array.from({length:10},()=>({score:''}))}),comment:val}; saveScore(key,sc); return {...prev,[key]:sc}; }); }
  function setMemberScore(key,mi,val){
    setScores(prev=>{
      const sc = prev[key]||{teamScore:'',color:'',comment:'',memberScores:Array.from({length:10},()=>({score:''}))};
      const ms = [...sc.memberScores];
      ms[mi]={score:val};
      return {...prev,[key]:{...sc,memberScores:ms}};
    });
  }

  function requireUnlock(action){ if(unlocked){action();return;} setShowLock(true); }

  // ── Embarque ──
  function renderEmbarque(){
    // Posiciones en el barco por rol
    const ROL_POS = {
      'Capitán 🛳️':        { x: 295, y: 148, color: '#7c3aed', border: '#a78bfa', label: 'Puente de mando' },
      'Chef 👨‍🍳':           { x: 128, y: 250, color: '#b45309', border: '#fbbf24', label: 'Cocina' },
      'Jefe de máquinas 🔧':{ x: 128, y: 325, color: '#8AA2E5', border: '#93c5fd', label: 'Sala de máquinas' },
      'Pasajero 🧳':        { x: 458, y: 250, color: '#EF80AE', border: '#f9a8d4', label: 'Cubierta pasajeros' },
      'Médico 🩺':          { x: 458, y: 325, color: '#7BF4D2', border: '#1F7A56', label: 'Enfermería' },
    };
    const ROL_EMOJI = {
      'Capitán 🛳️':'🛳️','Chef 👨‍🍳':'👨‍🍳','Jefe de máquinas 🔧':'🔧','Pasajero 🧳':'🧳','Médico 🩺':'🩺',
    };
    // Agrupar personas por rol
    const porRol = {};
    members.forEach((m,i)=>{ if(m.role&&m.name.trim()){ if(!porRol[m.role]) porRol[m.role]=[]; porRol[m.role].push(m.name); } });

    return(
      <div>
        {/* Barco con zonas superpuestas */}
        <div style={{position:'relative',background:'#0a1628',borderRadius:14,marginBottom:20,overflow:'hidden'}}>
          {/* SVG del barco — solo estructura, sin cajas de rol */}
          <svg width="100%" viewBox="0 0 680 420" style={{display:'block'}}>
            <ellipse cx="340" cy="385" rx="340" ry="32" fill="#0d2240"/>
            <path d="M40 378 Q100 370 160 378 Q220 386 280 378 Q340 370 400 378 Q460 386 520 378 Q580 370 640 378" stroke="#1a4a7a" strokeWidth="1.5" fill="none" opacity="0.6"/>
            <path d="M120 285 Q132 375 188 392 L492 392 Q548 375 560 285 Z" fill="#1a3a5c"/>
            <path d="M138 320 Q142 368 188 378 L492 378 Q538 368 542 320 Z" fill="#142d4a"/>
            <rect x="108" y="268" width="464" height="24" rx="4" fill="#1e4a7a"/>
            <rect x="108" y="268" width="464" height="5" rx="2" fill="#2a5aab"/>
            <rect x="238" y="188" width="204" height="84" rx="6" fill="#1a3a6b"/>
            <rect x="238" y="188" width="204" height="6" rx="3" fill="#2a5aab"/>
            <rect x="253" y="206" width="32" height="22" rx="3" fill="#0a1628" stroke="#3a7adb" strokeWidth="1"/>
            <rect x="296" y="206" width="32" height="22" rx="3" fill="#0a1628" stroke="#3a7adb" strokeWidth="1"/>
            <rect x="340" y="206" width="32" height="22" rx="3" fill="#0a1628" stroke="#3a7adb" strokeWidth="1"/>
            <rect x="384" y="206" width="32" height="22" rx="3" fill="#0a1628" stroke="#3a7adb" strokeWidth="1"/>
            <rect x="312" y="118" width="56" height="74" rx="4" fill="#142d4a"/>
            <rect x="312" y="118" width="56" height="8" rx="3" fill="#1a3a6b"/>
            <line x1="340" y1="55" x2="340" y2="188" stroke="#2a5a9a" strokeWidth="2.5"/>
            <line x1="282" y1="105" x2="398" y2="105" stroke="#2a5a9a" strokeWidth="1.5"/>
            <path d="M340 57 L372 70 L340 83 Z" fill="#e63946"/>
            {[148,198,448,498].map(x=><line key={x} x1={x} y1="268" x2={x} y2="282" stroke="#3a6aaa" strokeWidth="1.2"/>)}
            <path d="M108 278 L72 305 L108 300 Z" fill="#1a3a6b"/>
            <path d="M572 278 L608 305 L572 300 Z" fill="#1a3a6b"/>
            <text x="524" y="355" textAnchor="middle" fontSize="20" fill="#2a5a8c">⚓</text>
            {[[55,35],[130,18],[490,25],[590,45],[640,20],[75,70],[610,70]].map(([x,y],i)=>(
              <circle key={i} cx={x} cy={y} r="1.5" fill="white" opacity="0.7"/>
            ))}
            <circle cx="618" cy="42" r="16" fill="#1a3a6b"/>
            <circle cx="627" cy="36" r="14" fill="#0a1628"/>
          </svg>

          {/* Zonas de rol superpuestas con div absolutos — altura dinámica */}
          {Object.entries(ROL_POS).map(([rol, pos])=>{
            const personas = porRol[rol]||[];
            const emoji = ROL_EMOJI[rol]||'⚓';
            const filled = personas.length>0;
            // Convertir coordenadas SVG (viewBox 680x420) a % para position absolute
            const left = `${(pos.x/680)*100}%`;
            const top  = `${(pos.y/420)*100}%`;
            return(
              <div key={rol} style={{
                position:'absolute',
                left, top,
                width:'15.6%', // 106/680
                background: filled?pos.color:'#97B8D8',
                border:`${filled?1.5:1}px solid ${filled?pos.border:'#2a4a6a'}`,
                borderRadius:7,
                padding:'5px 6px',
                opacity: filled?1:0.7,
                minWidth:0,
              }}>
                <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:3}}>
                  <span style={{fontSize:12}}>{emoji}</span>
                  <span style={{fontSize:8,fontWeight:700,color:filled?'white':'#4a6a8a',textTransform:'uppercase',letterSpacing:'.03em',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {rol.split(' ')[0]}
                  </span>
                </div>
                {filled
                  ? personas.map((nombre,ni)=>(
                      <div key={ni} style={{fontSize:9,color:pos.border,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',lineHeight:'1.4'}}>
                        {nombre}
                      </div>
                    ))
                  : <div style={{fontSize:9,color:'#97B8D8'}}>Sin asignar</div>
                }
              </div>
            );
          })}
        </div>

        {/* Formulario de tripulantes */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:10}}>
          {members.map((m,i)=>{
            const pos = m.role ? ROL_POS[m.role] : null;
            return(
              <div key={i} style={{border:`1.5px solid ${pos?pos.border:'#2E343E'}`,borderRadius:12,padding:12,background:pos?`${pos.color}18`:'#232831',transition:'all .2s'}}>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
                  <span style={{fontSize:16}}>{pos?ROL_EMOJI[m.role]:'⚓'}</span>
                  <span style={{fontSize:11,fontWeight:700,color:pos?pos.border:'#5C6370',textTransform:'uppercase',letterSpacing:'.05em'}}>
                    {m.name||`Tripulante ${i+1}`}
                  </span>
                </div>
                <input value={m.name} onChange={e=>{ if(!unlocked){setShowLock(true);return;} const nm=[...members]; nm[i]={...nm[i],name:e.target.value}; setMembers(nm); saveMember(i,'name',e.target.value); }}
                  placeholder="Nombre"
                  style={{width:'100%',border:'1px solid #3A414D',borderRadius:8,padding:'6px 9px',fontSize:12,fontFamily:'inherit',marginBottom:7,boxSizing:'border-box',background:'white'}}/>
                <select value={m.role} onChange={e=>{ if(!unlocked){setShowLock(true);return;} const nm=[...members]; nm[i]={...nm[i],role:e.target.value}; setMembers(nm); saveMember(i,'role',e.target.value); }}
                  style={{width:'100%',border:'1px solid #3A414D',borderRadius:8,padding:'6px 9px',fontSize:12,fontFamily:'inherit',background:'white'}}>
                  <option value="">— Rol —</option>
                  {EVAL_ROLES.map(r=><option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Isla ──
  function renderIsla(islandIdx){
    const island = EVAL_ISLANDS[islandIdx];
    return(
      <div>
        <div style={{background:island.color,borderRadius:12,padding:'14px 18px',marginBottom:20,display:'flex',alignItems:'center',gap:12}}>
          <span style={{fontSize:28}}>{island.emoji}</span>
          <div style={{color:'white'}}>
            <div style={{fontWeight:700,fontSize:15}}>{island.label}</div>
            <div style={{fontSize:11,opacity:.85}}>{island.subjects.join(' · ')}</div>
          </div>
        </div>
        {island.subjects.map((subj,si)=>{
          const key=skKey(islandIdx,si);
          if(!scores[key]) initScore(key);
          const sc=scores[key]||{teamScore:'',color:'',comment:'',memberScores:Array.from({length:10},()=>({score:''}))};
          const activeM=members.map((m,i)=>({...m,idx:i})).filter(m=>m.name.trim());
          const dotCol=EVAL_COLORS.find(c=>c.id===sc.color);
          return(
            <div key={key} style={{border:'1.5px solid #2E343E',borderRadius:12,marginBottom:16,overflow:'hidden'}}>
              <div style={{background:'#232831',padding:'11px 18px',fontWeight:600,fontSize:13,color:'#83B8EC',borderBottom:'1px solid #2E343E',display:'flex',alignItems:'center',gap:8}}>
                📚 {subj}
                {dotCol&&<span style={{width:10,height:10,borderRadius:'50%',background:dotCol.hex,display:'inline-block',marginLeft:'auto'}}/>}
              </div>
              <div style={{padding:'18px 18px 20px'}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
                  {/* Nota equipo + color */}
                  <div style={{background:'#232831',border:'1.5px solid #2E343E',borderRadius:10,padding:'13px 14px'}}>
                    <div style={{fontSize:10,fontWeight:600,color:'#9AA1AC',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:10}}>Evaluación de equipo</div>
                    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                      <input type="number" min="1" max="10" value={sc.teamScore}
                        onChange={e=>{ if(!unlocked){setShowLock(true);return;} setTeamScore(key,e.target.value); }}
                        placeholder="—"
                        style={{width:60,border:'2px solid #3A414D',borderRadius:10,padding:'6px 8px',fontSize:20,fontWeight:700,textAlign:'center',fontFamily:'inherit',color:'#83B8EC',outline:'none'}}/>
                      <span style={{fontSize:11,color:'#9AA1AC'}}>Nota equipo<br/>(1–10)</span>
                    </div>
                    <div style={{fontSize:10,fontWeight:600,color:'#9AA1AC',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:8}}>Semáforo</div>
                    <div style={{display:'flex',gap:7,alignItems:'center'}}>
                      {EVAL_COLORS.map(col=>(
                        <button key={col.id} onClick={()=>{ if(!unlocked){setShowLock(true);return;} setColor(key,col.id); }}
                          title={col.label}
                          style={{width:30,height:30,borderRadius:'50%',background:col.hex,border:sc.color===col.id?'3px solid #0a2540':'3px solid transparent',cursor:'pointer',transition:'transform .15s',transform:sc.color===col.id?'scale(1.15)':'none'}}/>
                      ))}
                      <span style={{fontSize:11,color:'#9AA1AC',marginLeft:4}}>{dotCol?.label||'Sin selección'}</span>
                    </div>
                  </div>
                  {/* Comentario */}
                  <div style={{background:'#232831',border:'1.5px solid #2E343E',borderRadius:10,padding:'13px 14px'}}>
                    <div style={{fontSize:10,fontWeight:600,color:'#9AA1AC',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:8}}>Comentario del equipo</div>
                    <textarea value={sc.comment}
                      onChange={e=>{ if(!unlocked){setShowLock(true);return;} setComment(key,e.target.value); }}
                      placeholder="Reflexión colectiva..."
                      style={{width:'100%',border:'1px solid #3A414D',borderRadius:8,padding:'8px 12px',fontSize:13,fontFamily:'inherit',resize:'vertical',minHeight:80,outline:'none',boxSizing:'border-box'}}/>
                  </div>
                </div>
                {/* Notas individuales */}
                <div style={{fontSize:10,fontWeight:600,color:'#9AA1AC',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:8}}>Nota individual por tripulante</div>
                {activeM.length===0
                  ? <div style={{fontSize:12,color:'#7F8692'}}>Registra primero los nombres en el embarque.</div>
                  : <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))',gap:8}}>
                      {activeM.map(m=>(
                        <div key={m.idx} style={{background:'#232831',border:'1px solid #2E343E',borderRadius:9,padding:'9px 12px',display:'flex',alignItems:'center',gap:8}}>
                          <span style={{fontSize:12,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'#83B8EC',fontWeight:500}}>👤 {m.name}</span>
                          <input type="number" min="1" max="10" value={sc.memberScores[m.idx]?.score||''}
                            onChange={e=>{ if(!unlocked){setShowLock(true);return;} setMemberScore(key,m.idx,e.target.value); }}
                            placeholder="—"
                            style={{width:48,border:'1.5px solid #3A414D',borderRadius:7,padding:'4px 5px',fontSize:14,fontWeight:700,textAlign:'center',fontFamily:'inherit',color:'#83B8EC',outline:'none'}}/>
                        </div>
                      ))}
                    </div>
                }
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Resumen ──
  function renderResumen(){
    const activeM=members.map((m,i)=>({...m,idx:i})).filter(m=>m.name.trim());
    return(
      <div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(270px,1fr))',gap:14,marginBottom:20}}>
          {EVAL_ISLANDS.map((island,ii)=>(
            <div key={ii} style={{border:'1.5px solid #2E343E',borderRadius:12,overflow:'hidden'}}>
              <div style={{background:island.color,padding:'10px 14px',color:'white',fontWeight:600,fontSize:13}}>{island.emoji} {island.label}</div>
              <div style={{padding:'10px 14px'}}>
                {island.subjects.map((subj,si)=>{
                  const sc=scores[skKey(ii,si)];
                  const col=EVAL_COLORS.find(c=>c.id===sc?.color);
                  return(
                    <div key={si} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:'1px solid #514848',fontSize:12,gap:8}}>
                      {col&&<span style={{width:9,height:9,borderRadius:'50%',background:col.hex,flexShrink:0,display:'inline-block'}}/>}
                      <span style={{flex:1,color:'#C3C8D0'}}>{subj}</span>
                      <span style={{fontWeight:700,color:'#83B8EC',fontSize:14}}>{sc?.teamScore||'—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {activeM.length>0&&(
          <div style={{border:'1.5px solid #2E343E',borderRadius:12,overflow:'hidden'}}>
            <div style={{background:'#232831',padding:'11px 16px',fontWeight:600,fontSize:13,color:'#83B8EC',borderBottom:'1px solid #2E343E'}}>
              📊 Media individual por tripulante
            </div>
            <div style={{padding:'14px 16px',display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:10}}>
              {activeM.map(m=>{
                const all=[];
                EVAL_ISLANDS.forEach((isl,ii)=>isl.subjects.forEach((_,si)=>{
                  const v=scores[skKey(ii,si)]?.memberScores[m.idx]?.score;
                  if(v&&v!=='') all.push(+v);
                }));
                const avg=all.length?(all.reduce((a,b)=>a+b,0)/all.length).toFixed(1):'—';
                return(
                  <div key={m.idx} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',background:'#232831',border:'1px solid #2E343E',borderRadius:9}}>
                    <span style={{fontSize:15}}>{m.role?m.role.split(' ').pop():'⚓'}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:500,color:'#83B8EC',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{m.name}</div>
                      <div style={{fontSize:10,color:'#9AA1AC'}}>{m.role||'Sin rol'}</div>
                    </div>
                    <div style={{fontSize:20,fontWeight:700,color:'#83B8EC'}}>{avg}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  const stepLabels=[
    '⚓ Embarque',
    ...EVAL_ISLANDS.map((isl,i)=>`${isl.emoji} Isla ${i+1}`),
    '🏆 Resumen',
  ];

  function renderStep(){
    if(step===0) return renderEmbarque();
    if(step>=1&&step<=6) return renderIsla(step-1);
    if(step===7) return renderResumen();
    return null;
  }

  return(
    <div>
      {showLock&&<EditLockModal onUnlock={()=>{setUnlocked(true);setShowLock(false);}} onClose={()=>setShowLock(false)}/>}

      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16,flexWrap:'wrap',gap:8}}>
        <div>
          <div style={{fontWeight:800,fontSize:17,color:'#ECEEF2'}}>🚢 Team Journey — Evaluación en Alta Mar</div>
          <div style={{fontSize:11,color:'#9AA1AC',marginTop:2}}>6 islas · 10 exploradores · 1 destino</div>
        </div>
        <button onClick={()=>unlocked?setUnlocked(false):setShowLock(true)}
          style={{background:unlocked?'#114523':'#262B34',color:unlocked?'#8AE5AD':'#C3C8D0',border:'none',borderRadius:8,padding:'6px 14px',fontSize:11,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>
          {unlocked?'🔓 Editando':'🔒 Editar'}
        </button>
        {saving&&<span style={{fontSize:10,color:'#F59E0B',fontWeight:600}}>💾 Guardando...</span>}
      </div>

      {/* Barra de progreso */}
      <div style={{background:'#15181D',borderRadius:99,height:5,marginBottom:16,overflow:'hidden'}}>
        <div style={{width:`${(step/7)*100}%`,background:'linear-gradient(90deg,#1e8bc3,#d4a843)',height:'100%',borderRadius:99,transition:'width .4s'}}/>
      </div>

      {/* Navegación de islas */}
      <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:20,overflowX:'auto',paddingBottom:4}}>
        {stepLabels.map((label,i)=>(
          <button key={i} onClick={()=>setStep(i)}
            style={{background:step===i?'#0a2540':i<step?'#1a6b4a':'#262B34',color:step===i||i<step?'#FFF':'#C3C8D0',
              border:'none',borderRadius:20,padding:'5px 12px',fontSize:10,fontWeight:600,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap',flexShrink:0}}>
            {label}
          </button>
        ))}
      </div>

      {/* Contenido del step actual */}
      <div style={{background:'#1F232B',borderRadius:14,border:'1px solid #2E343E',padding:'20px 22px',marginBottom:16}}>
        <div style={{fontWeight:700,fontSize:15,color:'#83B8EC',marginBottom:16}}>{stepLabels[step]}</div>
        {renderStep()}
      </div>

      {/* Botones nav */}
      <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
        <button onClick={()=>setStep(s=>Math.max(0,s-1))} disabled={step===0}
          style={{background:'#262B34',color:'#C3C8D0',border:'none',borderRadius:8,padding:'8px 20px',fontSize:12,fontWeight:600,cursor:step===0?'not-allowed':'pointer',fontFamily:'inherit',opacity:step===0?.4:1}}>
          ← Anterior
        </button>
        <button onClick={()=>setStep(s=>Math.min(7,s+1))} disabled={step===7}
          style={{background:'#0a2540',color:'#FFF',border:'none',borderRadius:8,padding:'8px 20px',fontSize:12,fontWeight:700,cursor:step===7?'not-allowed':'pointer',fontFamily:'inherit',opacity:step===7?.4:1}}>
          Siguiente →
        </button>
      </div>
    </div>
  );
}

const TABS=[
  {id:"inicio",      label:"Inicio"},
  {id:"equipo",      label:"Equipo"},
  {id:"proyectos",   label:"Proyectos"},
  {id:"checkpoints", label:"Checkpoints"},
  {id:"clockify",    label:"Horas"},
  {id:"finanzas",    label:"Finanzas"},
  // Ocultas de momento (el código sigue): Documentos, Auditoría, MTA Model, Evaluaciones
  {id:"calendario",  label:"Calendario"},
];

// ── CHAT WIDGET ───────────────────────────────────────────────────────────────
const CHAT_GROUPS = [
  { id:"tlt",       label:"🔒 Privado",         password:CLAVE_CHAT_PRIVADO, locked:true  },
  { id:"general",   label:"💬 General",          password:null,   locked:false },
  { id:"training",  label:"🎯 Training Sessions", password:null,   locked:false },
];
const ALL_MEMBERS_CHAT = [...INIT_MEMBERS.map(m=>m.name),...EXTERNAL_MEMBERS.map(m=>m.name)];

function ChatWidget(){
  const [open, setOpen]         = useState(false);
  const [grupo, setGrupo]       = useState("general");
  const [autor, setAutor]       = useState(()=>perfil.nombre||"");
  const [texto, setTexto]       = useState("");
  const [msgs, setMsgs]         = useState([]);
  const [unread, setUnread]     = useState(0);
  const [pwInput, setPwInput]   = useState("");
  const [pwError, setPwError]   = useState(false);
  const [unlocked, setUnlocked] = useState({tlt:false,general:true,training:true});
  const [nameModal, setNameModal] = useState(false); // el nombre sale del perfil, no se elige
  const [nameTmp, setNameTmp]   = useState("");
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const lastIdRef = useRef(0);

  const grpInfo = CHAT_GROUPS.find(g=>g.id===grupo);
  const isUnlocked = unlocked[grupo];

  // Initial load for current group
  useEffect(()=>{
    lastIdRef.current = 0;
    setMsgs([]);
    sb.from("chat_messages")
      .select("*").eq("grupo",grupo)
      .order("created_at",{ascending:true}).limit(200)
      .then(({data,error})=>{
        if(error){ console.error("chat load error",error); return; }
        if(data&&data.length){
          setMsgs(data);
          lastIdRef.current = Math.max(...data.map(m=>m.id));
        }
      });
  },[grupo]);

  // Poll every 3s for new messages
  useEffect(()=>{
    const poll = async()=>{
      if(!lastIdRef.current && msgs.length===0) return;
      const {data,error} = await sb.from("chat_messages")
        .select("*").eq("grupo",grupo)
        .gt("id", lastIdRef.current)
        .order("created_at",{ascending:true}).limit(50);
      if(error||!data||data.length===0) return;
      lastIdRef.current = Math.max(...data.map(m=>m.id));
      setMsgs(prev=>{
        const existingIds = new Set(prev.map(m=>String(m.id)));
        const newOnes = data.filter(m=>!existingIds.has(String(m.id)));
        if(!newOnes.length) return prev;
        if(!open){
          setUnread(u=>u+newOnes.length);
          if("Notification" in window && Notification.permission==="granted"){
            newOnes.forEach(m=>{
              new Notification(EMPRESA+" Chat — "+grpInfo.label,{
                body:`${m.autor}: ${m.texto}`,
                icon:"/icon-192.png"
              });
            });
          }
        }
        return [...prev,...newOnes];
      });
    };
    const iv = setInterval(poll,3000);
    return ()=>clearInterval(iv);
  },[grupo,open,msgs.length]);

  // Scroll to bottom on new messages
  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:"smooth"}); },[msgs]);

  // Reset unread when opened
  useEffect(()=>{ if(open) setUnread(0); },[open]);

  // Request notification permission once
  useEffect(()=>{
    if("Notification" in window && Notification.permission==="default")
      Notification.requestPermission();
  },[]);

  async function sendMsg(){
    if(!texto.trim()||!autor) return;
    const txt = texto.trim();
    setTexto("");
    inputRef.current?.focus();
    // Optimistic local add
    const tmpId = "tmp_"+Date.now();
    const tmpMsg = {id:tmpId,grupo,autor,texto:txt,created_at:new Date().toISOString()};
    setMsgs(prev=>[...prev,tmpMsg]);
    // Insert to Supabase
    const {data,error} = await sb.from("chat_messages")
      .insert({grupo,autor,texto:txt})
      .select().single();
    if(error){ console.error("send error",error); return; }
    // Replace tmp with real
    setMsgs(prev=>prev.map(m=>m.id===tmpId?data:m));
    lastIdRef.current = Math.max(lastIdRef.current, data.id);
  }

  function unlockGroup(){
    if(pwInput===grpInfo.password){ setUnlocked(u=>({...u,[grupo]:true})); setPwInput(""); setPwError(false); }
    else{ setPwError(true); setPwInput(""); }
  }

  function saveName(){
    const n=nameTmp.trim(); if(!n) return;
    setAutor(n); localStorage.setItem("chat_autor",n); setNameModal(false);
  }

  function formatTime(ts){ const d=new Date(ts); return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`; }
  function formatDay(ts){
    const d=new Date(ts), today=new Date();
    if(d.toDateString()===today.toDateString()) return "Hoy";
    return d.toLocaleDateString("es-ES",{day:"2-digit",month:"short"});
  }

  const grouped = msgs.reduce((acc,m)=>{
    const day=new Date(m.created_at).toDateString();
    if(!acc.length||acc[acc.length-1].day!==day) acc.push({day,msgs:[m]});
    else acc[acc.length-1].msgs.push(m);
    return acc;
  },[]);

  return(
    <>
      {/* Name modal */}
      {nameModal&&(
        <div style={{position:"fixed",inset:0,background:"#0008",zIndex:99999,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#1F232B",borderRadius:14,padding:24,maxWidth:340,width:"95%",boxShadow:"0 8px 24px rgba(0,0,0,0.12)",textAlign:"center"}}>
            <div style={{fontSize:24,marginBottom:8}}>💬</div>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>¿Cómo te llamas?</div>
            <div style={{fontSize:11,color:"#9AA1AC",marginBottom:16}}>Elige tu nombre para el chat</div>
            <select value={nameTmp} onChange={e=>setNameTmp(e.target.value)}
              style={{width:"100%",border:"1px solid #2E343E",borderRadius:7,padding:"8px 12px",fontSize:12,fontFamily:"inherit",outline:"none",marginBottom:12}}>
              <option value="">— Selecciona —</option>
              {ALL_MEMBERS_CHAT.map(n=><option key={n} value={n}>{n}</option>)}
            </select>
            <button onClick={saveName} disabled={!nameTmp}
              style={{width:"100%",background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",opacity:nameTmp?1:0.4}}>
              Entrar al chat
            </button>
          </div>
        </div>
      )}

      {/* FAB */}
      <button onClick={()=>setOpen(o=>!o)} style={{
        position:"fixed",bottom:24,right:24,zIndex:9998,
        width:52,height:52,borderRadius:99,
        background:"#323844",color:"#FFF",border:"none",
        fontSize:22,cursor:"pointer",boxShadow:"0 4px 12px rgba(0,0,0,0.18)",
        display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit",
      }}>
        {open?"✕":"💬"}
        {!open&&unread>0&&(
          <div style={{position:"absolute",top:2,right:2,background:"#DC2626",color:"#FFF",borderRadius:99,fontSize:9,fontWeight:700,minWidth:16,height:16,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 4px"}}>
            {unread>9?"9+":unread}
          </div>
        )}
      </button>

      {/* Chat panel */}
      {open&&(
        <div style={{position:"fixed",bottom:88,right:24,zIndex:9997,width:340,height:500,background:"#1F232B",borderRadius:16,boxShadow:"0 8px 24px rgba(0,0,0,0.12)",display:"flex",flexDirection:"column",overflow:"hidden",border:"1px solid #2E343E"}}>
          {/* Header */}
          <div style={{background:"#323844",padding:"12px 14px",flexShrink:0}}>
            <div style={{fontSize:12,fontWeight:700,color:"#FFF",marginBottom:8}}>{EMPRESA} Chat</div>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              {CHAT_GROUPS.map(g=>(
                <button key={g.id} onClick={()=>{ setGrupo(g.id); setPwInput(""); setPwError(false); }} style={{
                  background:grupo===g.id?"#1F232B":"#FFFFFF22",
                  color:grupo===g.id?"#D5D9E0":"#FFFFFF99",
                  border:"none",borderRadius:6,padding:"4px 8px",fontSize:10,
                  fontWeight:grupo===g.id?700:400,cursor:"pointer",fontFamily:"inherit",
                }}>{g.label}</button>
              ))}
            </div>
          </div>

          {/* Lock screen */}
          {!isUnlocked?(
            <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:20,gap:10}}>
              <div style={{fontSize:32}}>🔒</div>
              <div style={{fontWeight:700,fontSize:13,color:"#D5D9E0"}}>Canal privado</div>
              <div style={{fontSize:11,color:"#9AA1AC",marginBottom:4}}>Introduce la contraseña del TLT</div>
              <input type="password" value={pwInput} onChange={e=>setPwInput(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&unlockGroup()} placeholder="Contraseña" autoFocus
                style={{width:"100%",border:`1.5px solid ${pwError?"#DC2626":"#2E343E"}`,borderRadius:7,padding:"8px 12px",fontSize:13,textAlign:"center",fontFamily:"inherit",outline:"none",letterSpacing:4,boxSizing:"border-box"}}/>
              {pwError&&<div style={{fontSize:10,color:"#EB8484"}}>Contraseña incorrecta</div>}
              <button onClick={unlockGroup} style={{width:"100%",background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                Entrar
              </button>
            </div>
          ):(
            <>
              {/* Messages */}
              <div style={{flex:1,overflowY:"auto",padding:"10px 12px",display:"flex",flexDirection:"column",gap:2}}>
                {grouped.map((day,di)=>(
                  <div key={di}>
                    <div style={{textAlign:"center",margin:"8px 0 6px",fontSize:9,color:"#9AA1AC",fontWeight:600,background:"#15181D",borderRadius:99,padding:"2px 10px",display:"inline-block",marginLeft:"50%",transform:"translateX(-50%)"}}>
                      {formatDay(day.msgs[0].created_at)}
                    </div>
                    {day.msgs.map((m,i)=>{
                      const isMe=m.autor===autor;
                      const showAutor=!isMe&&(i===0||day.msgs[i-1]?.autor!==m.autor);
                      return(
                        <div key={m.id} style={{display:"flex",flexDirection:"column",alignItems:isMe?"flex-end":"flex-start",marginBottom:3}}>
                          {showAutor&&<div style={{fontSize:9,color:"#9AA1AC",marginLeft:4,marginBottom:1,fontWeight:600}}>{m.autor}</div>}
                          <div style={{
                            maxWidth:"82%",
                            background:isMe?"#323844":String(m.id).startsWith("tmp_")?"#2E343E":"#1E2B38",
                            color:isMe?"#FFF":"#D5D9E0",
                            borderRadius:isMe?"12px 12px 2px 12px":"12px 12px 12px 2px",
                            padding:"6px 10px",fontSize:12,lineHeight:1.4,wordBreak:"break-word",
                          }}>
                            {m.texto}
                            <div style={{fontSize:8,opacity:0.5,marginTop:2,textAlign:isMe?"right":"left"}}>
                              {formatTime(m.created_at)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
                {msgs.length===0&&<div style={{textAlign:"center",color:"#9AA1AC",fontSize:11,marginTop:60}}>Sin mensajes aún en {grpInfo.label}</div>}
                <div ref={bottomRef}/>
              </div>

              {/* Input */}
              <div style={{padding:"8px 10px",borderTop:"1px solid #635A36",display:"flex",gap:6,flexShrink:0}}>
                <input ref={inputRef} value={texto} onChange={e=>setTexto(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendMsg()}
                  placeholder={`Mensaje en ${grpInfo.label}...`}
                  style={{flex:1,border:"1px solid #2E343E",borderRadius:8,padding:"7px 10px",fontSize:11,fontFamily:"inherit",outline:"none"}}/>
                <button onClick={sendMsg} disabled={!texto.trim()} style={{
                  background:"#3A414D",color:"#FFF",border:"none",borderRadius:8,
                  padding:"7px 12px",fontSize:14,cursor:"pointer",fontFamily:"inherit",
                  opacity:texto.trim()?1:0.4,
                }}>↑</button>
              </div>

              {/* Footer */}
              <div style={{padding:"4px 12px 6px",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
                <span style={{fontSize:9,color:"#9AA1AC"}}>Como: <b style={{color:"#ECEEF2"}}>{autor}</b></span>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

export default function Dashboard(){
  const [tab,setTab]           = useState("inicio");
  const [loading,setLoading]   = useState(true);
  const [updateAvailable,setUpdateAvailable] = useState(false);

  // ── Detector de nueva versión desplegada en Vercel ──────────────────────────
  useEffect(()=>{
    // Guardamos el ETag/Last-Modified del JS principal al cargar
    // Compara el archivo de la app que está cargado con el que hay publicado ahora mismo
    const scriptActual=()=>{ const el=[...document.querySelectorAll("script[src]")].find(x=>/\/assets\/.+\.js/.test(x.getAttribute("src")||"")); return el?el.getAttribute("src"):null; };
    const checkUpdate = async()=>{
      try{
        const actual=scriptActual();
        if(!actual) return; // en desarrollo
        const res = await fetch(`/?v=${Date.now()}`, {cache:"no-store"});
        const html = await res.text();
        const m = html.match(/src="(\/assets\/[^"]+\.js)"/);
        if(m && m[1]!==actual) setUpdateAvailable(true);
      }catch(e){}
    };
    checkUpdate();
    // Check cada 2 minutos
    const iv = setInterval(checkUpdate, 2*60*1000);
    // También al volver a la pestaña
    const onVis = ()=>{ if(document.visibilityState==="visible") checkUpdate(); };
    document.addEventListener("visibilitychange", onVis);
    return ()=>{ clearInterval(iv); document.removeEventListener("visibilitychange",onVis); };
  },[]);
  const [projectsRaw,setProjectsRaw] = useState(INIT_PROJECTS);
  const projects = projectsRaw.map(conTinte);
  const setProjectsDirectly = setProjectsRaw; // direct state update without Supabase side effects
  const [bpGroups,setBPGroupsRaw] = useState([{id:1,name:"1er curso"},{id:2,name:"2do curso"},{id:3,name:"3er curso"},{id:4,name:"4to curso"}]);
  const [cvGroups,setCVGroupsRaw] = useState([{id:1,name:"1er curso"},{id:2,name:"2do curso"},{id:3,name:"3er curso"},{id:4,name:"4to curso"}]);
  const [bp,setBPRaw]          = useState(()=>initByMember(INIT_MEMBERS));
  const [cv,setCVRaw]          = useState(()=>initByMember(INIT_MEMBERS));
  const [ing,setIngRaw]        = useState([]);
  const [gas,setGasRaw]        = useState([]);
  const [hojas,setHojasRaw]    = useState([]);
  const [crm,setCRMRaw]        = useState(()=>initCRM(INIT_PROJECTS));
  const [actas,setActasRaw] = useState([]);
  const [mta,setMtaRaw] = useState({});
  const [tareas,setTareasRaw] = useState([]);
  const [diamante,setDiamanteRaw] = useState({});
  const [horasProyecto,setHorasProyectoRaw] = useState([]);

  // ── Load all data from Supabase on mount ────────────────────────────────────
  useEffect(()=>{
    async function loadAll(){
      try {
        const [
          {data:projData},
          {data:bpData},
          {data:cvData},
          {data:crmData},
          {data:bpgData},
          {data:cvgData},
        ] = await Promise.all([
          sb.from("projects").select("*"),
          sb.from("bookpoints").select("*"),
          sb.from("customers").select("*"),
          sb.from("crm").select("*"),
          sb.from("groups_bp").select("*"),
          sb.from("groups_cv").select("*"),
        ]);
        // ── CLOCKIFY AS SOURCE OF TRUTH ──────────────────────────────────────────
        let syncedProjects = [];
        try {
          if(!USAR_CLOCKIFY) throw new Error("Clockify desactivado: proyectos del dashboard");
          const clockifyProjs = await fetchClockifyProjects();
          // Only projects starting with "1" (any separator: space, dot, dash)
          const clockify1 = clockifyProjs.filter(cp=>cp.name&&/^1[\s.\-_]/.test(cp.name)&&!cp.archived);
          const supaProjs = projData?.filter(p=>p.name&&p.name.trim()!=="") || [];
          const palette = PROJ_PALETTE;

          // Build final list from Clockify
          const toInsert = [];
          const toUpdate = []; // clockify_id patches
          clockify1.forEach((cp,i)=>{
            // Match by clockify_id first, then by name
            const existing = supaProjs.find(p=>p.clockify_id===cp.id||p.name.toLowerCase()===cp.name.toLowerCase());
            if(existing){
              // Keep Supabase row but ensure clockify_id and name are up to date
              const updated = {...existing, clockifyId:cp.id, name:cp.name};
              syncedProjects.push(updated);
              if(!existing.clockify_id||existing.name!==cp.name){
                toUpdate.push({id:existing.id, clockify_id:cp.id, name:cp.name});
              }
            } else {
              // New in Clockify → insert into Supabase
              const [dc,lc]=palette[i%palette.length];
              toInsert.push({name:cp.name, color:dc, light:lc, clockifyId:cp.id});
            }
          });

          // Insert new projects
          if(toInsert.length){
            const {data:inserted} = await sb.from("projects")
              .insert(toInsert.map(p=>({name:p.name,color:p.color,light:p.light,clockify_id:p.clockifyId})))
              .select();
            if(inserted) syncedProjects = [...syncedProjects, ...inserted.map(r=>({...r,clockifyId:r.clockify_id}))];
            else syncedProjects = [...syncedProjects, ...toInsert];
          }

          // Patch clockify_id / name for existing rows
          toUpdate.forEach(u=>sb.from("projects").update({clockify_id:u.clockify_id,name:u.name}).eq("id",u.id));

          // Delete from Supabase any project NOT in Clockify's list
          const clockifyIds = clockify1.map(cp=>cp.id);
          const toDelete = supaProjs.filter(p=>p.clockify_id&&!clockifyIds.includes(p.clockify_id));
          if(toDelete.length) sb.from("projects").delete().in("id",toDelete.map(p=>p.id));

          // Sort by Clockify order (numeric prefix)
          syncedProjects.sort((a,b)=>{
            const n=s=>{const m=s.name.match(/^([\d.]+)/);return m?parseFloat(m[1]):999;};
            return n(a)-n(b);
          });

        } catch(e){
          console.warn("Clockify sync failed, using Supabase fallback", e);
          syncedProjects = projData?.filter(p=>p.name&&p.name.trim()!=="") || INIT_PROJECTS;
        }
        // If Clockify returned nothing, fall back to Supabase
        if(!syncedProjects.length){
          syncedProjects = projData?.filter(p=>p.name&&p.name.trim()!=="") || INIT_PROJECTS;
        }
        const proj = syncedProjects;
        setProjectsRaw(syncedProjects);
        if(bpData?.length)   setBPRaw(rowsToByMember(bpData));
        if(cvData?.length)   setCVRaw(rowsToByMember(cvData));
        if(crmData?.length)  setCRMRaw(rowsToCRM(crmData, proj));
        if(bpgData?.length)  setBPGroupsRaw(bpgData);
        if(cvgData?.length)  setCVGroupsRaw(cvgData);
        // Load facturas (may not exist yet — handle gracefully)
        try {
          const parseDate = f => { if(!f) return 0; const [d,m,y]=f.split('/'); return new Date(y,m-1,d).getTime(); };
          const [{data:ingData},{data:gasData}] = await Promise.all([
            sb.from("facturas").select("*").eq("tipo","ingreso"),
            sb.from("facturas").select("*").eq("tipo","gasto"),
          ]);
          const parseF = (r,extra={}) => ({...r,...extra, linkFactura:r.link_factura||"", pagado:r.pagado||false, frcSign:r.frc_sign||"+", reparto:typeof r.reparto==="string"?JSON.parse(r.reparto||"[]"):r.reparto||[]});
          if(ingData?.length){
            const aprobadas = ingData.filter(r=>r.estado!=="pendiente");
            const pendientes = ingData.filter(r=>r.estado==="pendiente");
            setIngRaw(aprobadas.sort((a,b)=>parseDate(a.fecha)-parseDate(b.fecha)).map(r=>parseF(r)));
            if(pendientes.length){
              // Las pendientes de ingresos se cargan en FacturasTab via prop
              window._ingPendientes = pendientes.map(r=>parseF(r,{_pendiente:true}));
            }
          }
          if(gasData?.length){
            const aprobadas = gasData.filter(r=>r.estado!=="pendiente");
            const pendientes = gasData.filter(r=>r.estado==="pendiente");
            setGasRaw(aprobadas.sort((a,b)=>parseDate(a.fecha)-parseDate(b.fecha)).map(r=>parseF(r)));
            if(pendientes.length){
              window._gasPendientes = pendientes.map(r=>parseF(r,{_pendiente:true}));
            }
          }
        } catch(e){ console.warn("facturas table not ready yet", e); }
        // Load actas
        try {
          const {data:actasData} = await sb.from("actas").select("*").order("fecha",{ascending:false});
          if(actasData?.length) setActasRaw(actasData.map(r=>({
            ...r,
            asistentes: typeof r.asistentes==="string"?JSON.parse(r.asistentes||"[]"):r.asistentes||[],
            proyectos: typeof r.proyectos==="string"?JSON.parse(r.proyectos||"[]"):r.proyectos||[],
            decisiones: typeof r.decisiones==="string"?JSON.parse(r.decisiones||"[]"):r.decisiones||[],
            tareas: typeof r.tareas==="string"?JSON.parse(r.tareas||"[]"):r.tareas||[],
          })));
        } catch(e){ console.warn("actas table not ready",e); }
        // Load MTA model progress
        try {
          const {data:mtaData} = await sb.from("mta_progress").select("*");
          if(mtaData?.length){
            const obj={};
            mtaData.forEach(r=>{ obj[r.key]=r.val; });
            setMtaRaw(obj);
          }
        } catch(e){ console.warn("mta_progress table not ready",e); }
        // Load calendario tareas
        try {
          const {data:tareasData} = await sb.from("calendario").select("*").order("fecha");
          if(tareasData?.length) setTareasRaw(tareasData);
          // Auto-insert TS (martes y jueves 9-13) mayo-junio 2026 si no existen
          try {
            const tsPrefix = "TS_AUTO_";
            const existing = (tareasData||[]).map(t=>t.id);
            const toInsert = [];
            // Generate all Tues/Thu from 05/05/2026 to 26/06/2026
            const start = new Date(2026,4,5); // May 5
            const end   = new Date(2026,5,26); // Jun 26
            for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
              const dow=d.getDay(); // 2=Tue 4=Thu
              if(dow!==2&&dow!==4) continue;
              const dd=String(d.getDate()).padStart(2,"0");
              const mm=String(d.getMonth()+1).padStart(2,"0");
              const yyyy=d.getFullYear();
              const fecha=`${dd}/${mm}/${yyyy}`;
              const tsId=`${tsPrefix}${fecha.replace(/\//g,"")}`;
              if(!existing.includes(tsId)){
                toInsert.push({id:tsId,titulo:"🎯 Training Session",descripcion:"TS semanal 9:00-13:00",fecha,prioridad:"🔴 Alta",estado:"pendiente",proyecto:"",responsable:"Equipo"});
              }
            }
            if(toInsert.length){
              await sb.from("calendario").upsert(toInsert);
              setTareasRaw(prev=>[...prev,...toInsert]);
            }
          } catch(e){ console.warn("TS auto-insert error",e); }
        } catch(e){ console.warn("calendario table not ready",e); }
        // Load hojas de gasto
        try {
          const {data:hojasData} = await sb.from("hojas_gasto").select("*");
          if(hojasData?.length){
            const parseDate = f => { if(!f) return 0; const [d,m,y]=f.split('/'); return new Date(y,m-1,d).getTime(); };
            setHojasRaw(hojasData
              .sort((a,b)=>parseDate(a.fecha)-parseDate(b.fecha))
              .map(r=>({...r, link:r.link||"", pagado:r.pagado||false, importe_proyecto:r.importe_proyecto||"", proyectos: typeof r.proyectos==="string"?JSON.parse(r.proyectos||"[]"):r.proyectos||[], reparto: typeof r.reparto==="string"?JSON.parse(r.reparto||"[]"):r.reparto||[]})));
          }
        } catch(e){ console.warn("hojas_gasto table not ready",e); }
        // Load diamante falkon
        try {
          const {data:dData} = await sb.from("diamante").select("*");
          if(dData?.length){ const obj={}; dData.forEach(r=>{obj[r.id]=r.val;}); setDiamanteRaw(obj); }
        } catch(e){ console.warn("diamante table not ready",e); }
        // Load horas por proyecto
        try {
          const {data:hpData} = await sb.from("horas_proyecto").select("*");
          if(hpData?.length) setHorasProyectoRaw(hpData);
        } catch(e){ console.warn("horas_proyecto table not ready",e); }
      } catch(e){ console.error("Load error",e); }
      setLoading(false);
    }
    loadAll();

    function parseF(r){
      return {...r, linkFactura:r.link_factura||"", pagado:r.pagado||false, frcSign:r.frc_sign||"+",
        reparto: typeof r.reparto==="string"?JSON.parse(r.reparto||"[]"):r.reparto||[]};
    }
    const chF=sb.channel("rt:facturas")
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"facturas"},(p)=>{
        const r=parseF(p.new);
        if(r.estado==="pendiente"){
          // Notificar a FacturasTab via evento custom
          window.dispatchEvent(new CustomEvent("blesk:factura_pendiente",{detail:r}));
          return;
        }
        if(r.tipo==="ingreso") setIngRaw(prev=>prev.find(x=>x.id===r.id)?prev:[...prev,r].sort((a,b)=>parseDate(a.fecha)-parseDate(b.fecha)));
        else setGasRaw(prev=>prev.find(x=>x.id===r.id)?prev:[...prev,r].sort((a,b)=>parseDate(a.fecha)-parseDate(b.fecha)));
      })
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"facturas"},(p)=>{
        const r=parseF(p.new);
        const set=r.tipo==="ingreso"?setIngRaw:setGasRaw;
        if(r.estado==="pendiente") set(prev=>prev.filter(x=>x.id!==r.id));
        else set(prev=>prev.find(x=>x.id===r.id)?prev.map(x=>x.id===r.id?r:x):[...prev,r].sort((a,b)=>parseDate(a.fecha)-parseDate(b.fecha)));
      })
      .on("postgres_changes",{event:"DELETE",schema:"public",table:"facturas"},(p)=>{
        setIngRaw(prev=>prev.filter(x=>x.id!==p.old.id));
        setGasRaw(prev=>prev.filter(x=>x.id!==p.old.id));
        window.dispatchEvent(new CustomEvent("blesk:factura_borrada",{detail:p.old}));
      })
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"facturas"},(p)=>{
        if(p.new.estado==="aprobada"){
          window.dispatchEvent(new CustomEvent("blesk:factura_aprobada",{detail:p.new}));
        }
      }).subscribe();
    const chC=sb.channel("rt:calendario")
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"calendario"},(p)=>{
        setTareasRaw(prev=>prev.find(x=>x.id===p.new.id)?prev:[...prev,p.new]);
      })
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"calendario"},(p)=>{
        setTareasRaw(prev=>prev.map(x=>x.id===p.new.id?p.new:x));
      })
      .on("postgres_changes",{event:"DELETE",schema:"public",table:"calendario"},(p)=>{
        setTareasRaw(prev=>prev.filter(x=>x.id!==p.old.id));
      }).subscribe();
    const chCV=sb.channel("rt:customers")
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"customers"},(p)=>{
        setCv(prev=>{ const n={...prev},m=p.new.member||""; n[m]=[...(n[m]||[]),p.new]; return n; });
      })
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"customers"},(p)=>{
        setCv(prev=>{ const n={...prev}; Object.keys(n).forEach(k=>{ n[k]=n[k].map(x=>x.id===p.new.id?p.new:x); }); return n; });
      })
      .on("postgres_changes",{event:"DELETE",schema:"public",table:"customers"},(p)=>{
        setCv(prev=>{ const n={...prev}; Object.keys(n).forEach(k=>{ n[k]=n[k].filter(x=>x.id!==p.old.id); }); return n; });
      }).subscribe();
    // Recargar cuando la pestaña vuelve a estar activa (usuario vuelve al dashboard)
    function onVisible(){
      if(document.visibilityState==="visible"){
        // Recargar facturas
        const parseDate = f => { if(!f) return 0; const [d,m,y]=f.split('/'); return new Date(y,m-1,d).getTime(); };
        sb.from("facturas").select("*").eq("tipo","ingreso").then(({data})=>{
          // Las pendientes de aprobar no cuentan (antes se colaban al volver a la pestaña)
          if(data) setIngRaw(data.filter(r=>r.estado!=="pendiente").sort((a,b)=>parseDate(a.fecha)-parseDate(b.fecha)).map(r=>({...r,linkFactura:r.link_factura||"",pagado:r.pagado||false,frcSign:r.frc_sign||"+",reparto:typeof r.reparto==="string"?JSON.parse(r.reparto||"[]"):r.reparto||[]})));
        });
        sb.from("facturas").select("*").eq("tipo","gasto").then(({data})=>{
          // Las pendientes de aprobar no cuentan (antes se colaban al volver a la pestaña)
          if(data) setGasRaw(data.filter(r=>r.estado!=="pendiente").sort((a,b)=>parseDate(a.fecha)-parseDate(b.fecha)).map(r=>({...r,linkFactura:r.link_factura||"",pagado:r.pagado||false,frcSign:r.frc_sign||"+",reparto:typeof r.reparto==="string"?JSON.parse(r.reparto||"[]"):r.reparto||[]})));
        });
        sb.from("hojas_gasto").select("*").then(({data})=>{
          if(data) setHojasRaw(data.map(r=>({...r,link:r.link||"",pagado:r.pagado||false,proyectos:typeof r.proyectos==="string"?JSON.parse(r.proyectos||"[]"):r.proyectos||[],reparto:typeof r.reparto==="string"?JSON.parse(r.reparto||"[]"):r.reparto||[]})));
        });
        sb.from("solicitudes_hoja_gasto").select("*").order("created_at",{ascending:false}).then(()=>{});
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return ()=>{ sb.removeChannel(chF); sb.removeChannel(chC); sb.removeChannel(chCV); document.removeEventListener("visibilitychange",onVisible); };
  },[]);

  // ── DB-synced setters ───────────────────────────────────────────────────────
  // Generic: upsert changed rows, delete removed rows
  async function syncTable(table, oldState, newState, member){
    const oldRows = oldState[member]||[];
    const newRows = newState[member]||[];
    const deleted = oldRows.filter(o=>!newRows.find(n=>n.id===o.id));
    const upserted = newRows.map(r=>{
      if(table==="customers"){
        const {linkedFrom, linkedOwner, ...rest} = r;
        return {...rest, member, companeros:JSON.stringify(r.companeros||[]), linked_from:linkedFrom||null, linked_owner:linkedOwner||null};
      }
      // bookpoints — solo campos propios
      const {companeros, linkedFrom, linkedOwner, linked_from, linked_owner, ...rest} = r;
      return {...rest, member};
    });
    if(deleted.length){const{error}=await sb.from(table).delete().in("id",deleted.map(r=>r.id));if(error)console.error("❌ syncTable delete",table,error);}
    if(upserted.length){const{error}=await sb.from(table).upsert(upserted);if(error)console.error("❌ syncTable upsert",table,member,error);else console.log("✅",table,member,"guardado");}
  }

  // Solo puedes tocar tus propias filas (la base de datos también lo bloquea).
  // En Customers también puedes tocar las copias que tú creaste en la lista de un compañero.
  function cambiosAjenos(prev, next, permitirLinked){
    return INIT_MEMBERS.some(m=>{
      if(puedoEditar(m.name)) return false;
      const a=prev[m.name]||[], b=next[m.name]||[];
      if(JSON.stringify(a)===JSON.stringify(b)) return false;
      if(!permitirLinked) return true;
      const tocadas=[...a.filter(o=>!b.find(n=>n.id===o.id)), ...b.filter(n=>JSON.stringify(n)!==JSON.stringify(a.find(o=>o.id===n.id)))];
      return tocadas.some(r=>r.linkedOwner!==perfil.nombre);
    });
  }
  function avisoAjeno(){ setTimeout(()=>alert(`Solo puedes editar tus propios datos (${perfil.nombre||"sin perfil"}).`),0); }

  function setBP(updater){
    setBPRaw(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      if(cambiosAjenos(prev,next,false)){ avisoAjeno(); return prev; }
      INIT_MEMBERS.forEach(m=>{
        const po=JSON.stringify(prev[m.name]), pn=JSON.stringify(next[m.name]);
        if(po!==pn) syncTable("bookpoints", prev, next, m.name);
      });
      return next;
    });
  }
  function setCV(updater){
    setCVRaw(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      if(cambiosAjenos(prev,next,true)){ avisoAjeno(); return prev; }
      INIT_MEMBERS.forEach(m=>{
        const po=JSON.stringify(prev[m.name]), pn=JSON.stringify(next[m.name]);
        if(po!==pn) syncTable("customers", prev, next, m.name);
      });
      return next;
    });
  }
  function setIng(updater){
    setIngRaw(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      const deleted=prev.filter(o=>!next.find(n=>n.id===o.id));
      const changed=next.filter(n=>JSON.stringify(n)!==JSON.stringify(prev.find(p=>p.id===n.id)));
      const upserted=changed.map(r=>({
        id:r.id, tipo:"ingreso", proyecto:r.proyecto||"", fecha:r.fecha||"",
        base:r.base||"", iva:r.iva||"", total:r.total||"", ref:r.ref||"",
        descripcion:r.descripcion||"", link_factura:r.linkFactura||r.link_factura||"",
        reparto:JSON.stringify(r.reparto||[]), pagado:r.pagado||false,
        frc_sign:r.frcSign||r.frc_sign||"+", estado:"aprobada"
      }));
      if(deleted.length) sb.from("facturas").delete().in("id",deleted.map(r=>r.id)).then(({error})=>{if(error)console.error("❌ facturas delete",error);});
      if(upserted.length) sb.from("facturas").upsert(upserted).then(({error})=>{if(error)console.error("❌ facturas upsert ingreso",error);else console.log("✅ facturas ingreso guardado",upserted.length,"filas");});
      return next;
    });
  }
  function setGas(updater){
    setGasRaw(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      const deleted=prev.filter(o=>!next.find(n=>n.id===o.id));
      const changed=next.filter(n=>JSON.stringify(n)!==JSON.stringify(prev.find(p=>p.id===n.id)));
      const upserted=changed.map(r=>({
        id:r.id, tipo:"gasto", proyecto:r.proyecto||"", fecha:r.fecha||"",
        base:r.base||"", iva:r.iva||"", total:r.total||"", ref:r.ref||"",
        descripcion:r.descripcion||"", link_factura:r.linkFactura||r.link_factura||"",
        reparto:JSON.stringify(r.reparto||[]), pagado:r.pagado||false,
        frc_sign:r.frcSign||r.frc_sign||"+", estado:"aprobada"
      }));
      if(deleted.length) sb.from("facturas").delete().in("id",deleted.map(r=>r.id)).then(({error})=>{if(error)console.error("❌ facturas delete",error);});
      if(upserted.length) sb.from("facturas").upsert(upserted).then(({error})=>{if(error)console.error("❌ facturas upsert gasto",error);else console.log("✅ facturas gasto guardado",upserted.length,"filas");});
      return next;
    });
  }
  function setActas(updater){
    setActasRaw(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      const deleted=prev.filter(o=>!next.find(n=>n.id===o.id));
      const upserted=next.map(r=>({
        id:r.id, titulo:r.titulo||"", fecha:r.fecha||"",
        asistentes:JSON.stringify(r.asistentes||[]),
        proyectos:JSON.stringify(r.proyectos||[]),
        decisiones:JSON.stringify(r.decisiones||[]),
        tareas:JSON.stringify(r.tareas||[]),
      }));
      if(deleted.length) sb.from("actas").delete().in("id",deleted.map(r=>r.id)).then(({error})=>{if(error)console.error("❌ actas delete",error);});
      if(upserted.length) sb.from("actas").upsert(upserted).then(({error})=>{if(error)console.error("❌ actas upsert",error);else console.log("✅ actas guardado");});
      return next;
    });
  }
  function setMta(key,val){
    setMtaRaw(prev=>{
      const next={...prev,[key]:val};
      sb.from("mta_progress").upsert({key,val}).then(({error})=>{if(error)console.error("❌ mta_progress upsert",error);else console.log("✅ mta guardado",key);});
      return next;
    });
  }
  function setTareas(updater){
    setTareasRaw(prev=>{
      const next = typeof updater==="function"?updater(prev):updater;
      const deleted=prev.filter(o=>!next.find(n=>n.id===o.id));
      const upserted=next.filter(r=>r.id&&r.titulo).map(r=>({
        id:r.id, titulo:r.titulo||"", descripcion:r.descripcion||"",
        fecha:r.fecha||"", prioridad:r.prioridad||"", estado:r.estado||"Pendiente",
        proyecto:r.proyecto||"", responsable:r.responsable||""
      }));
      if(deleted.length) sb.from("calendario").delete().in("id",deleted.map(r=>r.id)).then(({error})=>{if(error)console.error("❌ calendario delete",error);});
      if(upserted.length) sb.from("calendario").upsert(upserted).then(({error})=>{if(error)console.error("❌ calendario upsert",error);else console.log("✅ calendario guardado");});
      return next;
    });
  }
  function setHojas(updater){
    setHojasRaw(prev=>{
      const next = typeof updater==="function"?updater(prev):updater;
      const deleted=prev.filter(o=>!next.find(n=>n.id===o.id));
      const upserted=next.map(r=>({
        id:r.id, fecha:r.fecha||"", link:r.link||"",
        importe:r.importe||"", responsable:r.responsable||"",
        proyecto:r.proyecto||"", reparto:JSON.stringify(r.reparto||[]),
        pagado:r.pagado||false, importe_proyecto:r.importe_proyecto||"",
        proyectos:JSON.stringify(r.proyectos||[])
      }));
      if(deleted.length) sb.from("hojas_gasto").delete().in("id",deleted.map(r=>r.id)).then(({error})=>{if(error)console.error("❌ hojas_gasto delete",error);});
      if(upserted.length) sb.from("hojas_gasto").upsert(upserted).then(({error})=>{if(error)console.error("❌ hojas_gasto upsert",error);else console.log("✅ hojas_gasto guardado");});
      return next;
    });
  }
  function setDiamante(key, val){
    setDiamanteRaw(prev=>{
      const next={...prev,[key]:val};
      sb.from("diamante").upsert({id:key,val}).then(({error})=>{if(error)console.error("❌ diamante upsert",error);});
      return next;
    });
  }
  function setHorasProyecto(updater){
    setHorasProyectoRaw(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      const deleted=prev.filter(o=>!next.find(n=>n.id===o.id));
      const changed=next.filter(n=>JSON.stringify(n)!==JSON.stringify(prev.find(p=>p.id===n.id)));
      if(deleted.length) sb.from("horas_proyecto").delete().in("id",deleted.map(r=>r.id)).then(({error})=>{if(error)console.error("❌ horas_proyecto delete",error);});
      if(changed.length) sb.from("horas_proyecto").upsert(changed).then(({error})=>{if(error)console.error("❌ horas_proyecto upsert",error);else console.log("✅ horas_proyecto guardado");});
      return next;
    });
  }
  function setCRM(updater){
    setCRMRaw(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      const flatNext = Object.entries(next).flatMap(([proyecto,val])=>
        ["g1","g2"].flatMap(gk=>(val[gk]?.rows||[]).map(r=>({
          id:r.id, proyecto, grupo_key:gk, grupo_name:val[gk]?.name||gk,
          cliente:r.cliente||"", ubicacion:r.ubicacion||"", tlf:r.tlf||"",
          email:r.email||"", estado:r.estado||"", comentarios:r.comentarios||""
        })))
      );
      const flatPrev = Object.entries(prev).flatMap(([proyecto,val])=>
        ["g1","g2"].flatMap(gk=>(val[gk]?.rows||[]).map(r=>({id:r.id,proyecto,grupo_key:gk})))
      );
      const deleted = flatPrev.filter(o=>!flatNext.find(n=>n.id===o.id));
      if(deleted.length) sb.from("crm").delete().in("id",deleted.map(r=>r.id)).then(({error})=>{if(error)console.error("❌ crm delete",error);});
      if(flatNext.length) sb.from("crm").upsert(flatNext).then(({error})=>{if(error)console.error("❌ crm upsert",error);else console.log("✅ crm guardado");});
      return next;
    });
  }
  function setProjects(updater){
    setProjectsRaw(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      const deleted = prev.filter(o=>!next.find(n=>n.id===o.id));
      const added   = next.filter(n=>!prev.find(o=>o.id===n.id));
      const renamed = next.filter(n=>{
        const old=prev.find(o=>o.id===n.id);
        return old && old.name!==n.name;
      });
      if(deleted.length) sb.from("projects").delete().in("id",deleted.map(p=>p.id)).then(({error})=>{if(error)console.error("delete projects",error);});
      if(added.length)   sb.from("projects").insert(added.map(p=>({name:p.name,color:p.color,light:p.light,...(p.clockifyId?{clockify_id:p.clockifyId}:{}),...(p.participantes?.length?{participantes:p.participantes}:{})}))).then(({error})=>{if(error)console.error("insert projects",error);});
      if(renamed.length){
        renamed.forEach(p=>{
          sb.from("projects").update({name:p.name}).eq("id",p.id).then(({error})=>{if(error)console.error("rename project supabase",error);});
          // Sync to Clockify if project has a clockifyId
          if(USAR_CLOCKIFY&&p.clockifyId) renameClockifyProject(p.clockifyId, p.name);
        });
      }
      return next;
    });
  }
  function setBPGroups(updater){
    setBPGroupsRaw(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      const deleted = prev.filter(o=>!next.find(n=>String(n.id)===String(o.id)));
      const added = next.filter(n=>!prev.find(o=>String(o.id)===String(n.id)));
      const updated = next.filter(n=>prev.find(o=>String(o.id)===String(n.id)&&o.name!==n.name));
      if(deleted.length) sb.from("groups_bp").delete().in("id",deleted.map(g=>String(g.id))).then(({error})=>{if(error)console.error("del bp",error);});
      if(added.length) sb.from("groups_bp").insert(added.map(g=>({id:String(g.id),name:g.name}))).then(({error})=>{if(error)console.error("ins bp",error);});
      if(updated.length) updated.forEach(g=>sb.from("groups_bp").update({name:g.name}).eq("id",String(g.id)).then(({error})=>{if(error)console.error("upd bp",error);}));
      return next;
    });
  }
  function setCVGroups(updater){
    setCVGroupsRaw(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      const deleted = prev.filter(o=>!next.find(n=>String(n.id)===String(o.id)));
      const added = next.filter(n=>!prev.find(o=>String(o.id)===String(n.id)));
      const updated = next.filter(n=>prev.find(o=>String(o.id)===String(n.id)&&o.name!==n.name));
      if(deleted.length) sb.from("groups_cv").delete().in("id",deleted.map(g=>String(g.id))).then(({error})=>{if(error)console.error("del cv",error);});
      if(added.length) sb.from("groups_cv").insert(added.map(g=>({id:String(g.id),name:g.name}))).then(({error})=>{if(error)console.error("ins cv",error);});
      if(updated.length) updated.forEach(g=>sb.from("groups_cv").update({name:g.name}).eq("id",String(g.id)).then(({error})=>{if(error)console.error("upd cv",error);}));
      return next;
    });
  }

  if(loading) return(
    <div style={{minHeight:"100vh",background:"#15181D",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <img src="/icon-192.png" alt={EMPRESA} style={{width:48,height:48,borderRadius:10,display:"block",objectFit:"cover"}}/>
      <div style={{color:"#9C9B97",fontSize:13,fontWeight:500}}>Cargando datos...</div>
    </div>
  );

  const allBP=Object.values(bp).flat(),allCV=Object.values(cv).flat();
  const allCRM=Object.values(crm).flatMap(p=>[...(p.g1?.rows||[]),...(p.g2?.rows||[])]);
  const totPts=allBP.reduce((s,r)=>s+(parseFloat(r.puntos)||0),0);
  const totVent=allCRM.filter(r=>r.estado==="Venta cerrada").length;

  return(
    <div style={{minHeight:"100vh",background:"#15181D",fontFamily:"'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif",color:"#ECEEF2"}}>
      <style>{`
        * { box-sizing: border-box; }
        @media (max-width: 768px) {
          .blesk-header-kpis { display: none !important; }
          .blesk-header-pad { padding: 0 12px !important; }
          .blesk-tabs-wrap { padding: 0 12px !important; overflow-x: auto; -webkit-overflow-scrolling: touch; }
          .blesk-tabs-wrap::-webkit-scrollbar { display: none; }
          .blesk-content { padding: 16px 12px !important; }
          .blesk-grid-2 { grid-template-columns: 1fr !important; }
          .blesk-grid-3 { grid-template-columns: 1fr 1fr !important; }
          .blesk-grid-4 { grid-template-columns: 1fr 1fr !important; }
          .blesk-grid-auto { grid-template-columns: repeat(2, 1fr) !important; }
          .blesk-rankings { grid-template-columns: 1fr !important; }
          .blesk-member-cards { grid-template-columns: 1fr !important; }
          .blesk-hide-mobile { display: none !important; }
        }
        @media (max-width: 480px) {
          .blesk-grid-3 { grid-template-columns: 1fr !important; }
          .blesk-grid-4 { grid-template-columns: 1fr !important; }
        }
        :root { --keia-calor: linear-gradient(90deg,#FFB547 0%,#FF6A1F 45%,#C81E4A 100%); --keia-brasa:#E8501C; }
        :root { color-scheme: dark; }
        input, select, textarea { background-color:#1B1F26; color:#ECEEF2; border-color:#3A414D; }
        input::placeholder, textarea::placeholder { color:#6B7280; }
        option { background:#1F232B; color:#ECEEF2; }
        body { margin:0; background:#15181D; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; font-feature-settings:"tnum" 1,"cv11" 1; }
        ::selection { background:#452211; color:#ECEEF2; }
        button { transition: background-color .15s, color .15s, border-color .15s, box-shadow .15s; }
        button:active { opacity: 0.75; }
        button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--keia-brasa); outline-offset: 2px; }
        input:focus, select:focus, textarea:focus { border-color: #7F8692 !important; }
        /* Tarjetas blancas: sombra suave en dos capas en vez de solo borde */
        .blesk-content div[style*="background: rgb(31, 35, 43)"][style*="border-radius"] { box-shadow: inset 0 1px 0 rgba(255,255,255,.035), 0 10px 28px -14px rgba(0,0,0,.55); }
        ::-webkit-scrollbar { width:10px; height:10px; }
        ::-webkit-scrollbar-thumb { background:#3A414D; border-radius:99px; border:3px solid transparent; background-clip:content-box; }
        ::-webkit-scrollbar-thumb:hover { background:#969CA6; background-clip:content-box; border:3px solid transparent; }
        .keia-tab:hover { color:#FFFFFF !important; }
        .keia-salir:hover { background:rgba(255,255,255,.14) !important; }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition:none !important; animation-duration:.01ms !important; } }
        input, select, textarea { -webkit-appearance: none; font-size: 16px !important; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* ── HEADER ── */}
      <div style={{background:"#1F232B",position:"sticky",top:0,zIndex:100,boxShadow:"0 8px 24px -16px rgba(0,0,0,.5)"}}>
        <div className="blesk-header-pad" style={{padding:"0 32px",display:"flex",alignItems:"center",justifyContent:"space-between",height:60}}>
          {/* Logo */}
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <img src="/icon-192.png" alt={EMPRESA} style={{width:32,height:32,borderRadius:9,display:"block",objectFit:"cover",boxShadow:"0 0 0 1px rgba(255,255,255,.08), 0 4px 14px -4px rgba(255,106,31,.55)"}}/>
            <div>
              <div style={{fontWeight:700,fontSize:15,color:"#FFFFFF",letterSpacing:"-0.3px"}}>{EMPRESA}</div>
              <div style={{fontSize:10.5,color:"#8C93A0",fontWeight:400}}>{EMPRESA_SUB}</div>
            </div>
          </div>
          {/* KPIs */}
          <div className="blesk-header-kpis" style={{display:"flex",gap:0,alignItems:"center"}}>
            {[
              {label:"Bookpoints", val:totPts},
              {label:"CV", val:allCV.filter(r=>r.cat==="CV"&&!r.linkedFrom).length},
              {label:"Ingresos", val:ing.reduce((s,r)=>s+signedBase(r),0).toFixed(0)+"€"},
              {label:"Gastos", val:(gas.reduce((s,r)=>s+signedBase(r),0)+hojas.reduce((s,r)=>s+(parseFloat(r.importe)||0),0)).toFixed(0)+"€"},
              {label:"Neto", val:(ing.reduce((s,r)=>s+signedBase(r),0)-gas.reduce((s,r)=>s+signedBase(r),0)-hojas.reduce((s,r)=>s+(parseFloat(r.importe)||0),0)).toFixed(0)+"€", accent:(ing.reduce((s,r)=>s+signedBase(r),0)-gas.reduce((s,r)=>s+signedBase(r),0)-hojas.reduce((s,r)=>s+(parseFloat(r.importe)||0),0))>=0},
              {label:"Ventas CRM", val:totVent},
              {label:"Proyectos", val:projects.length},
            ].map((k,i)=>(
              <div key={k.label} style={{textAlign:"right",padding:"0 16px",borderLeft:i>0?"1px solid rgba(255,255,255,.08)":"none"}}>
                <div style={{fontSize:10.5,color:"#8C93A0",fontWeight:500,marginBottom:2}}>{k.label}</div>
                <div style={{fontSize:14,fontWeight:600,color:k.accent===false?"#FF7A7A":k.accent===true?"#4ADE9B":"#FFFFFF",letterSpacing:"-0.2px"}}>{k.val}</div>
              </div>
            ))}
          </div>
          <button className="keia-salir" onClick={()=>sb.auth.signOut()} title="Cerrar sesión"
            style={{marginLeft:12,background:"rgba(255,255,255,.07)",color:"#E6E8EC",border:"1px solid rgba(255,255,255,.1)",borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
            {perfil.nombre?`${perfil.nombre} · Salir`:"Salir"}
          </button>
        </div>
        {/* Banner actualización */}
        {updateAvailable&&(
          <div style={{background:"#453B11",borderTop:"1px solid #7A651F",padding:"6px 32px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <span style={{fontSize:11,color:"#F3A97D",fontWeight:600}}>🔄 Hay una nueva versión del dashboard disponible</span>
            <button onClick={()=>window.location.replace(`${window.location.pathname}?v=${Date.now()}`)}
              style={{background:"#D97706",color:"#FFF",border:"none",borderRadius:6,padding:"5px 14px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
              Actualizar ahora
            </button>
          </div>
        )}
        {/* Tab bar */}
        <div className="blesk-tabs-wrap" style={{padding:"0 24px",display:"flex",gap:2,overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          {TABS.map(t=>(
            <button key={t.id} className="keia-tab" onClick={()=>setTab(t.id)} style={{
              position:"relative",
              background:"transparent",
              color:tab===t.id?"#FFFFFF":"#8C93A0",
              border:"none",
              padding:"11px 14px 13px",
              fontSize:13,fontWeight:tab===t.id?600:500,
              cursor:"pointer",fontFamily:"inherit",
              whiteSpace:"nowrap",
            }}>
              {t.label}
              {tab===t.id&&<span aria-hidden="true" style={{position:"absolute",left:14,right:14,bottom:0,height:3,borderRadius:"3px 3px 0 0",background:"var(--keia-calor)"}}/>}
            </button>
          ))}
        </div>
        {/* Línea de calor: la firma de KEIA */}
        <div aria-hidden="true" style={{height:2,background:"var(--keia-calor)",opacity:.9}}/>
      </div>

      {/* ── CONTENT ── */}
      <div className="blesk-content" style={{padding:"28px 32px 48px",maxWidth:1400,margin:"0 auto"}}>
        {tab==="inicio"     && <InicioTab bp={bp} cv={cv} ing={ing} gas={gas} hojas={hojas} projects={projects} tareas={tareas} setTareas={setTareas}/>}
        {tab==="equipo"     && <EquipoTab     bp={bp} cv={cv} ing={ing} gas={gas} hojas={hojas} projects={projects}/>}
        {tab==="proyectos"   && <ProyectosTab  projects={projects} setProjects={setProjects} setProjectsDirectly={setProjectsDirectly} crm={crm} setCRM={setCRM} customers={cv} ingresos={ing} gastos={gas} hojas={hojas} ing={ing} cv={cv} bp={bp}/>}
        {tab==="checkpoints" && <CheckpointsTab ing={ing} gas={gas} hojas={hojas} bp={bp} setBP={setBP} bpGroups={bpGroups} setBPGroups={setBPGroups} cv={cv} setCV={setCV} cvGroups={cvGroups} setCVGroups={setCVGroups} projects={projects}/>}
        {tab==="finanzas"   && <FinanzasTab ing={ing} setIng={setIng} gas={gas} setGas={setGas} hojas={hojas} setHojas={setHojas} projects={projects} diamante={diamante} setDiamante={setDiamante} sb={sb}/>}
        {tab==="documentos" && <DocumentosTab/>}
        {tab==="auditoria"  && <AuditoriaTab/>}
        {tab==="clockify"   && <HorasTab projects={projects}/>}
        {tab==="mta"        && <MTAModelTab   mta={mta} setMta={setMta}/>}
        {tab==="calendario" && <CalendarioTab tareas={tareas} setTareas={setTareas} projects={projects}/>}
        {tab==="evaluaciones" && <EvaluacionesTab/>}
      </div>
    </div>
  );
}

import { createClient } from "@supabase/supabase-js";
import { perfil, esAdmin } from "./perfil.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Un único cliente para toda la app (login + datos), así la sesión se comparte.
const cliente = createClient(SUPABASE_URL, SUPABASE_KEY);

// Tablas de la empresa: todos las ven, pero solo los admin pueden cambiarlas.
// (La base de datos también lo bloquea: esto solo sirve para avisar en vez de fallar en silencio.)
export const TABLAS_SOLO_ADMIN = new Set([
  "projects","facturas","hojas_gasto","groups_bp","groups_cv","crm","calendario","actas",
  "presupuestos_2026","presupuestos_activos","estrategia","estrategia_activos","proyecto_roles",
  "evaluaciones_members","evaluaciones_scores","member_colors","mta_progress","diamante","horas_proyecto",
]);
const ESCRITURAS = new Set(["insert","upsert","update","delete"]);

let ultimoAviso = 0;
export function avisarSinPermiso(){
  const ahora = Date.now();
  if(ahora - ultimoAviso < 4000) return;   // un solo aviso aunque se disparen varias escrituras
  ultimoAviso = ahora;
  setTimeout(()=>alert(`No tienes permiso para cambiar esto, ${perfil.nombre||""}: solo puedes editar lo tuyo. No se ha guardado (recarga la página).`), 0);
}

// Respuesta "falsa" que aguanta cualquier cadena (.select().single().eq()...) y acaba en error.
function bloqueado(tabla){
  avisarSinPermiso();
  const res = { data:null, error:{ code:"42501", message:`Sin permiso para cambiar ${tabla}` } };
  const p = Promise.resolve(res);
  const cadena = new Proxy(function(){}, {
    get:(_t,prop)=> prop==="then" ? p.then.bind(p) : prop==="catch" ? p.catch.bind(p) : prop==="finally" ? p.finally.bind(p) : ()=>cadena,
    apply:()=>cadena,
  });
  return cadena;
}

function horasDeOtro(filas){
  const arr = Array.isArray(filas) ? filas : [filas];
  return arr.some(f=>!String(f?.key||"").startsWith("horas|") || (f?.val?.persona && f.val.persona!==perfil.nombre));
}

export const sb = new Proxy(cliente, {
  get(target, prop){
    if(prop!=="from") return Reflect.get(target, prop);
    return (tabla)=>{
      const q = target.from(tabla);
      return new Proxy(q, {
        get(qt, metodo){
          const real = Reflect.get(qt, metodo);
          if(!ESCRITURAS.has(metodo) || esAdmin() || typeof real!=="function") return typeof real==="function" ? real.bind(qt) : real;
          if(TABLAS_SOLO_ADMIN.has(tabla)) return ()=>bloqueado(tabla);
          if(tabla==="audit_progress" && (metodo==="insert"||metodo==="upsert"))
            return (filas,...r)=> horasDeOtro(filas) ? bloqueado(tabla) : real.call(qt,filas,...r);
          if(tabla==="audit_progress" && metodo==="update") return ()=>bloqueado(tabla);
          // Hojas de gasto: cualquiera envía la suya, pero aprobar/editar/borrar es de admin
          if(tabla==="solicitudes_hoja_gasto" && metodo!=="insert") return ()=>bloqueado(tabla);
          return real.bind(qt);
        },
      });
    };
  },
});

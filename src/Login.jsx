import { useState, useEffect } from "react";
import { sb } from "./supabase.js";
import { EMPRESA } from "./config.js";
import { perfil } from "./perfil.js";

// Marca KEIA: Inter para el texto, Manrope para titulares; blanco, ceniza, carbón y naranja Keia
const font = "'Inter',system-ui,-apple-system,'Segoe UI',sans-serif";
const fontTit = "'Manrope','Inter',system-ui,sans-serif";
const box = {minHeight:"100vh",background:"#5a4232 url('/fondo-keia.jpg') center/cover no-repeat fixed",display:"flex",alignItems:"center",justifyContent:"center",padding:16,fontFamily:font,color:"#171717"};
const card = {position:"relative",overflow:"hidden",background:"linear-gradient(160deg, rgba(70,54,44,.55), rgba(30,22,17,.62))",WebkitBackdropFilter:"blur(22px) saturate(1.3)",backdropFilter:"blur(22px) saturate(1.3)",border:"1px solid rgba(255,255,255,.18)",borderRadius:28,boxShadow:"inset 0 1px 0 rgba(255,255,255,.18), 0 30px 60px -24px rgba(0,0,0,.7)",padding:"40px 30px 30px",width:"100%",maxWidth:380,display:"flex",flexDirection:"column",gap:18,color:"#FFFFFF"};
const input = {width:"100%",boxSizing:"border-box",border:"1px solid rgba(255,255,255,.6)",background:"rgba(255,255,255,.92)",borderRadius:999,padding:"12px 14px",fontSize:16,fontFamily:"inherit",outline:"none",color:"#171717"};
const btn = {background:"linear-gradient(180deg, #F0785C, #D94A32)",color:"#FFF",border:"none",borderRadius:999,boxShadow:"inset 0 1px 0 rgba(255,255,255,.35), 0 10px 22px -10px rgba(217,74,50,.9)",padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:fontTit};

function Pantalla({children}){
  return (
    <div style={box}>
      <div style={card}>
        <img src="/keia-logo-negativo.svg" alt={EMPRESA} style={{height:46,alignSelf:"center",display:"block"}}/>
        {children}
      </div>
    </div>
  );
}

function Login(){
  const [email,setEmail]=useState("");
  const [pass,setPass]=useState("");
  const [err,setErr]=useState("");
  const [busy,setBusy]=useState(false);

  async function entrar(e){
    e.preventDefault();
    setErr(""); setBusy(true);
    const {error}=await sb.auth.signInWithPassword({email:email.trim().toLowerCase(),password:pass});
    setBusy(false);
    if(error) setErr("Correo o contraseña incorrectos.");
  }

  return (
    <Pantalla>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:13,color:"rgba(255,255,255,.75)"}}>Entra con tu correo de Mondragon</div>
      </div>
      <form onSubmit={entrar} style={{display:"flex",flexDirection:"column",gap:10}}>
        <input style={input} type="email" autoComplete="username" placeholder="tu.correo@alumni.mondragon.edu" value={email} onChange={e=>setEmail(e.target.value)} required/>
        <input style={input} type="password" autoComplete="current-password" placeholder="Contraseña" value={pass} onChange={e=>setPass(e.target.value)} required/>
        {err&&<div style={{color:"#FFB4A6",fontSize:12}}>{err}</div>}
        <button style={{...btn,opacity:busy?0.6:1}} disabled={busy}>{busy?"Entrando…":"Entrar"}</button>
      </form>
    </Pantalla>
  );
}

// Envuelve la app: sin sesión → login; con sesión pero sin estar en la lista → sin acceso.
export default function AuthGate({children}){
  const [session,setSession]=useState(undefined);
  const [miembro,setMiembro]=useState(undefined);

  useEffect(()=>{
    sb.auth.getSession().then(({data})=>setSession(data.session));
    const {data:{subscription}}=sb.auth.onAuthStateChange((_e,s)=>setSession(s));
    return ()=>subscription.unsubscribe();
  },[]);

  useEffect(()=>{
    if(!session){ setMiembro(undefined); return; }
    // Carga el perfil (nombre + rol) ligado a este correo. Sin perfil no se entra.
    sb.from("perfiles").select("nombre,rol,finanzas").eq("email",(session.user.email||"").toLowerCase()).maybeSingle()
      .then(({data,error})=>{
        if(error||!data){ perfil.nombre=null; perfil.rol=null; perfil.finanzas=false; setMiembro(false); return; }
        perfil.nombre=data.nombre; perfil.rol=data.rol; perfil.finanzas=!!data.finanzas; setMiembro(true);
      });
  },[session?.user?.id]);

  if(session===undefined||(session&&miembro===undefined)) return <div style={box}/>;
  if(!session) return <Login/>;
  if(!miembro) return (
    <Pantalla>
      <div style={{textAlign:"center",fontSize:14}}>Esta cuenta no tiene acceso a {EMPRESA}.</div>
      <button style={btn} onClick={()=>sb.auth.signOut()}>Volver</button>
    </Pantalla>
  );
  return children;
}

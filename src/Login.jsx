import { useState, useEffect } from "react";
import { sb } from "./supabase.js";
import { EMPRESA } from "./config.js";
import { perfil } from "./perfil.js";

const font = "'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif";
const calor = "linear-gradient(90deg,#FFB547 0%,#FF6A1F 45%,#C81E4A 100%)";
const box = {minHeight:"100vh",background:"radial-gradient(120% 80% at 50% 0%,#2A2F39 0%,#1F232B 45%,#171A20 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:16,fontFamily:font,color:"#1A1D23"};
const card = {position:"relative",overflow:"hidden",background:"#FFF",borderRadius:16,boxShadow:"0 30px 60px -30px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.04)",padding:"36px 30px 30px",width:"100%",maxWidth:370,display:"flex",flexDirection:"column",gap:16};
const input = {width:"100%",boxSizing:"border-box",border:"1px solid #E3E6EA",background:"#F7F8FA",borderRadius:10,padding:"12px 14px",fontSize:16,fontFamily:"inherit",outline:"none",color:"#1A1D23"};
const btn = {background:"#1F232B",color:"#FFF",border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"};

function Pantalla({children}){
  return (
    <div style={box}>
      <div style={card}>
        <div aria-hidden="true" style={{position:"absolute",top:0,left:0,right:0,height:3,background:calor}}/>
        <img src="/icon-192.png" alt={EMPRESA} style={{width:56,height:56,borderRadius:14,alignSelf:"center",objectFit:"cover",boxShadow:"0 8px 22px -8px rgba(255,106,31,.6)"}}/>
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
        <div style={{fontWeight:700,fontSize:22,letterSpacing:"-0.4px"}}>{EMPRESA}</div>
        <div style={{fontSize:13,color:"#646B76",marginTop:4}}>Entra con tu correo de Mondragon</div>
      </div>
      <form onSubmit={entrar} style={{display:"flex",flexDirection:"column",gap:10}}>
        <input style={input} type="email" autoComplete="username" placeholder="tu.correo@alumni.mondragon.edu" value={email} onChange={e=>setEmail(e.target.value)} required/>
        <input style={input} type="password" autoComplete="current-password" placeholder="Contraseña" value={pass} onChange={e=>setPass(e.target.value)} required/>
        {err&&<div style={{color:"#DC2626",fontSize:12}}>{err}</div>}
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
    sb.from("perfiles").select("nombre,rol").eq("email",(session.user.email||"").toLowerCase()).maybeSingle()
      .then(({data,error})=>{
        if(error||!data){ perfil.nombre=null; perfil.rol=null; setMiembro(false); return; }
        perfil.nombre=data.nombre; perfil.rol=data.rol; setMiembro(true);
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

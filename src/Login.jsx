import { useState, useEffect } from "react";
import { sb } from "./supabase.js";
import { EMPRESA } from "./config.js";

const box = {minHeight:"100vh",background:"#F0F2F5",display:"flex",alignItems:"center",justifyContent:"center",padding:16,fontFamily:"'DM Sans','Segoe UI',sans-serif",color:"#111827"};
const card = {background:"#FFF",borderRadius:14,boxShadow:"0 4px 24px rgba(0,0,0,0.06)",padding:"32px 28px",width:"100%",maxWidth:360,display:"flex",flexDirection:"column",gap:14};
const input = {width:"100%",boxSizing:"border-box",border:"1px solid #E5E7EB",borderRadius:8,padding:"11px 12px",fontSize:16,fontFamily:"inherit",outline:"none"};
const btn = {background:"#111827",color:"#FFF",border:"none",borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"};

function Pantalla({children}){
  return (
    <div style={box}>
      <div style={card}>
        <img src="/icon-192.png" alt={EMPRESA} style={{width:52,height:52,borderRadius:12,alignSelf:"center",objectFit:"cover"}}/>
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
        <div style={{fontWeight:700,fontSize:18}}>{EMPRESA}</div>
        <div style={{fontSize:12,color:"#6B7280",marginTop:4}}>Acceso solo para miembros</div>
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
    sb.rpc("es_miembro").then(({data,error})=>setMiembro(!error&&data===true));
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

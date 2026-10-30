// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURACIÓN DE TU EMPRESA — cambia esto y listo
// ─────────────────────────────────────────────────────────────────────────────

// Nombre que sale arriba del todo, en los PDFs y en los informes
export const EMPRESA = "KEIA";
// Subtítulo (organización, universidad, ciudad…)
export const EMPRESA_SUB = "Nombre de la organización";

// Contraseña para editar facturas, hojas de gasto, banco… (¡cámbiala!)
export const CLAVE_EDICION = "1234";
// Contraseña del chat privado
export const CLAVE_CHAT_PRIVADO = "1234";

// Miembros del equipo (nombre + color). El nombre es el que se usa en repartos, horas, etc.
export const MIEMBROS = [
  { name:"Ana",    color:"#1E3A5F", light:"#EEF2FF" },
  { name:"Bruno",  color:"#059669", light:"#ECFDF5" },
  { name:"Carla",  color:"#DC2626", light:"#FEF2F2" },
  { name:"David",  color:"#D97706", light:"#FFFBEB" },
  { name:"Elena",  color:"#0891B2", light:"#ECFEFF" },
  { name:"Fran",   color:"#DB2777", light:"#FDF2F8" },
];

// Personas que ya no están: se ocultan en Inicio pero sus datos siguen contando (pon aquí sus nombres)
export const MIEMBROS_ANTIGUOS = [];

// Colaboradores externos que pueden aparecer en repartos y en el chat
export const EXTERNOS = [];

// Proyectos con los que arranca la app la primera vez (luego se gestionan en la pestaña Proyectos)
export const PROYECTOS_INICIALES = [
  { name:"1.1. Proyecto ejemplo", color:"#1E3A5F", light:"#F2F2F0" },
];

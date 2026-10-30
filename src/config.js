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
  { name:"Lier",             color:"#EA580C", light:"#FFF7ED" },
  { name:"Asier Anchustegi", color:"#1E3A5F", light:"#EEF2FF" },
  { name:"Eneko Guinea",     color:"#059669", light:"#ECFDF5" },
  { name:"Ander",            color:"#DC2626", light:"#FEF2F2" },
  { name:"Asier Olloqui",    color:"#D97706", light:"#FFFBEB" },
  { name:"Asier Garcia",     color:"#0891B2", light:"#ECFEFF" },
  { name:"Eneko Ruiz",       color:"#DB2777", light:"#FDF2F8" },
  { name:"Bruno",            color:"#7C3AED", light:"#F5F3FF" },
  { name:"Garazi",           color:"#2563EB", light:"#EFF6FF" },
  { name:"Leire",            color:"#16A34A", light:"#F0FDF4" },
  { name:"Mario",            color:"#9333EA", light:"#FAF5FF" },
  { name:"Naiara",           color:"#CA8A04", light:"#FEFCE8" },
  { name:"Naroa",            color:"#0D9488", light:"#F0FDFA" },
  { name:"Unai",             color:"#E11D48", light:"#FFF1F2" },
  { name:"Xabi",             color:"#4F46E5", light:"#EEF2FF" },
  { name:"Markel",           color:"#65A30D", light:"#F7FEE7" },
  { name:"Sara",             color:"#C026D3", light:"#FDF4FF" },
  { name:"Alex",             color:"#0284C7", light:"#F0F9FF" },
  { name:"Iker",             color:"#57534E", light:"#F5F5F4" },
];

// Personas que ya no están: se ocultan en Inicio pero sus datos siguen contando (pon aquí sus nombres)
export const MIEMBROS_ANTIGUOS = [];

// Colaboradores externos que pueden aparecer en repartos y en el chat
export const EXTERNOS = [];

// Proyectos con los que arranca la app la primera vez (luego se gestionan en la pestaña Proyectos)
export const PROYECTOS_INICIALES = [
  { name:"1.1. Proyecto ejemplo", color:"#1E3A5F", light:"#F2F2F0" },
];

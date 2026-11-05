// Perfil de la persona que ha iniciado sesión (lo rellena Login.jsx antes de abrir la app).
// nombre = el mismo que en src/config.js → MIEMBROS. rol = "miembro" | "admin" | "visitante".
export const perfil = { nombre: null, rol: null };

export const esAdmin = () => perfil.rol === "admin";

// Visitante (p. ej. profesorado): puede ver todo, pero no cambia nada.
export const esVisitante = () => perfil.rol === "visitante";

// ¿Puede gestionar proyectos y finanzas? Cualquier miembro o admin (los visitantes no).
export const puedoGestionar = () => perfil.rol === "admin" || perfil.rol === "miembro";

// ¿Puede la persona actual tocar los datos de `miembro`?
export const puedoEditar = (miembro) => esAdmin() || (!!perfil.nombre && miembro === perfil.nombre);

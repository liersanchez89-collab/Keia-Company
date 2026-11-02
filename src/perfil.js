// Perfil de la persona que ha iniciado sesión (lo rellena Login.jsx antes de abrir la app).
// nombre = el mismo que en src/config.js → MIEMBROS. rol = "miembro" | "admin".
export const perfil = { nombre: null, rol: null };

export const esAdmin = () => perfil.rol === "admin";

// ¿Puede la persona actual tocar los datos de `miembro`?
export const puedoEditar = (miembro) => esAdmin() || (!!perfil.nombre && miembro === perfil.nombre);

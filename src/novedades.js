// ─────────────────────────────────────────────────────────────────────────────
//  NOVEDADES — lo que ha cambiado en cada actualización de la app
// ─────────────────────────────────────────────────────────────────────────────
// Cada vez que se cambie algo en la app, AÑADE UNA ENTRADA NUEVA ARRIBA DEL TODO
// (con un id nuevo). Al abrir la app con la versión nueva, a cada persona le sale
// un aviso dentro de la app con estos cambios durante 5 segundos (solo una vez).
//
//   id:      algo único, p. ej. la fecha + un número ("2026-11-16-1")
//   fecha:   "DD/MM/AAAA"
//   titulo:  frase corta (opcional)
//   cambios: lista de cambios, en lenguaje normal (lo lee todo el equipo)

export const NOVEDADES = [
  {
    id: "2026-11-26-2",
    fecha: "26/11/2026",
    titulo: "Customer Visits: cada uno lo suyo",
    cambios: [
      "En Customer Visits ya no se pueden añadir compañeros a una visita.",
      "Cada persona añade sus propias visitas, así no se suman dos veces.",
      "Las visitas que ya tenías de un compañero (↗) se quedan como estaban.",
    ],
  },
  {
    id: "2026-11-26-1",
    fecha: "26/11/2026",
    titulo: "Cambios en el equipo",
    cambios: [
      "Eneko Ruiz y Mario ya no están en KEIA: dejan de salir en Inicio y en los rankings.",
      "Shazia entra como visitante (solo puede ver, no editar), igual que Bego.",
    ],
  },
  {
    id: "2026-11-16-1",
    fecha: "16/11/2026",
    titulo: "Fotos de perfil",
    cambios: [
      "Ya puedes poner tu foto de perfil: toca tu círculo arriba a la derecha.",
      "Tu foto sale en Equipo, en los proyectos y en el resto de la app.",
      "Al actualizar la app verás aquí qué ha cambiado.",
    ],
  },
];

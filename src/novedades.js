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
    id: "2026-11-19-1",
    fecha: "19/11/2026",
    titulo: "Cambiar la hora de inicio en directo",
    cambios: [
      "Con el temporizador en marcha ya puedes cambiar la hora a la que empezaste (\"Empezó a las\").",
      "Si se te olvidó darle al empezar, pon la hora real y el contador se corrige sin pararlo.",
      "En modo Todos, el cambio se aplica a todo el equipo a la vez.",
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

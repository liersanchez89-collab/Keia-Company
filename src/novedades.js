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
    id: "2026-11-26-10",
    fecha: "26/11/2026",
    titulo: "🛠 Arreglo en hojas de gasto",
    cambios: [
      "Naroa ya puede aprobar, rechazar y eliminar solicitudes de hoja de gasto sin que salga el aviso de permisos, y los cambios se quedan guardados.",
      "Si algo no se guarda, ahora la app avisa en vez de hacer como que se ha borrado.",
    ],
  },
  {
    id: "2026-11-26-9",
    fecha: "26/11/2026",
    titulo: "💰 Naroa, líder financiera",
    cambios: [
      "Naroa puede aprobar, rechazar, mover y borrar en Finanzas lo de todos (hojas de gasto, facturas, banco…).",
      "A ella y al admin ya no les pide la contraseña de edición en Finanzas.",
    ],
  },
  {
    id: "2026-11-26-8",
    fecha: "26/11/2026",
    titulo: "📋 Nueva plantilla de hoja de gastos",
    cambios: [
      "Al crear una hoja de gastos, ahora se genera con la plantilla oficial de KEIA (logo, colores y formato de la hoja de Excel).",
      "Incluye km por día, Peajes, Taxi, Mugi, Billetes, Dietas, Otros, itinerario, comentarios y firmas. Sale en horizontal, lista para imprimir o guardar en PDF.",
    ],
  },
  {
    id: "2026-11-26-7",
    fecha: "26/11/2026",
    titulo: "Equipo actualizado",
    cambios: [
      "Eneko Ruiz y Mario ya no salen en ninguna lista: proyectos, checkpoints, horas, equipo, actas…",
    ],
  },
  {
    id: "2026-11-26-6",
    fecha: "26/11/2026",
    titulo: "🏆 Trabajadores de la semana",
    cambios: [
      "En Inicio salen los trabajadores de la semana: más horas, más lectura y más visitas a clientes.",
      "Se reinicia cada viernes a las 9:00, igual que el contador de horas.",
    ],
  },
  {
    id: "2026-11-26-5",
    fecha: "26/11/2026",
    titulo: "Finanzas más sencillas",
    cambios: [
      "💰 Ingresos y gastos: apunta el dinero que entra y el que sale, repartido entre personas.",
      "📄 Facturas: ahora es un solo apartado y sirve solo de registro (foto o PDF).",
      "Las facturas ya no suman ni restan: lo que cuenta es lo de Ingresos y gastos.",
    ],
  },
  {
    id: "2026-11-26-4",
    fecha: "26/11/2026",
    titulo: "Nuevo: 💰 Ingresos en Finanzas",
    cambios: [
      "En Finanzas hay un apartado nuevo, 💰 Ingresos, para apuntar el dinero que ganamos.",
      "Cada ingreso se puede repartir entre personas (o todos a partes iguales).",
      "El dinero de la Action Week ya está ahí. Las facturas siguen en su sitio.",
    ],
  },
  {
    id: "2026-11-26-3",
    fecha: "26/11/2026",
    titulo: "Ver fotos en grande",
    cambios: [
      "Toca la foto de perfil de cualquier compañero para verla en grande.",
      "Para cerrarla, toca en cualquier sitio o pulsa Esc.",
      "Las fotos que subas a partir de ahora se guardan con más calidad.",
    ],
  },
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

# KEIA — notas para trabajar en este repo

- App React + Vite (todo el panel está en `src/App.jsx`), datos en Supabase, publicada en Vercel desde `main`.
- Los cambios de base de datos se guardan también como `.sql` en `supabase/`.

## Novedades (obligatorio en cada cambio)
Cada vez que se cambie algo de la app, añade una entrada nueva **arriba del todo** de
`src/novedades.js` (id nuevo, fecha y la lista de cambios en lenguaje sencillo, para el equipo).
Al abrir la versión nueva, a cada persona le sale ese resumen dentro de la app durante 15 segundos.

# Dashboard de empresa

App web para gestionar una empresa de equipo: facturas, hojas de gasto, banco y conciliación,
previsiones, cuenta de resultados, balance, horas (con temporizador), checkpoints, CRM y calendario.

Hecha con **React + Vite**, base de datos **Supabase** y publicada en **Vercel**.
Viene vacía: no lleva datos de nadie.

---

## Puesta en marcha (unos 20 minutos)

### 1. Supabase (la base de datos)
1. Entra en [supabase.com](https://supabase.com) y crea un proyecto nuevo.
2. Ve a **SQL Editor → New query**, pega todo el archivo `supabase/schema.sql` y pulsa **Run**.
3. Ve a **Project Settings → API** y copia:
   - **Project URL**
   - **anon public key**

### 2. GitHub (el código)
1. Crea un repositorio nuevo en [github.com](https://github.com) (puede ser privado).
2. Sube todos los archivos de esta carpeta (botón **Add file → Upload files**, o con `git push`).

### 3. Vercel (la web)
1. Entra en [vercel.com](https://vercel.com) con tu cuenta de GitHub → **Add New → Project** → elige el repositorio.
2. Antes de pulsar Deploy, en **Environment Variables** añade:
   - `VITE_SUPABASE_URL` → la Project URL de Supabase
   - `VITE_SUPABASE_ANON_KEY` → la anon public key
   - `ANTHROPIC_API_KEY` → *(opcional)* para leer facturas y extractos en PDF con IA
3. Pulsa **Deploy**. En un minuto tienes la web funcionando.

Cada vez que subas un cambio a GitHub, Vercel la actualiza sola.

### 4. Personalízala
Abre `src/config.js` y cambia:
- el **nombre de la empresa** y el subtítulo,
- los **miembros** del equipo,
- las **contraseñas** (edición y chat privado),
- los **proyectos** iniciales.

Los logos están en `public/` (`icon-192.png`, `icon-512.png`): cámbialos por los tuyos.

---

## Probarla en tu ordenador (opcional)
```bash
npm install
cp .env.example .env     # y pon tus claves de Supabase
npm run dev
```

## A tener en cuenta
- Cualquiera que tenga la dirección de la web puede verla. Las partes de dinero se editan con la contraseña de `src/config.js`.
- La pestaña de previsiones tiene un periodo extra (“Corea”) y unos objetivos de ahorro (“NY + Corea”) que se usaban para un viaje: se pueden renombrar en `src/App.jsx` (`PERIODOS_PREV` y `ObjetivosCard`).
- Las pestañas Documentos, Auditoría, MTA Model y Evaluaciones están ocultas: para enseñarlas, añádelas a la lista `TABS` de `src/App.jsx`.

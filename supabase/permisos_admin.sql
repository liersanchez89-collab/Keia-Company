-- Regla general: todos los miembros VEN todo, pero solo pueden EDITAR lo suyo.
-- Lo que es de la empresa (proyectos, facturas, calendario, CRM, actas, estrategia, presupuestos…)
-- solo lo pueden cambiar los admin (tabla perfiles, rol = 'admin').
-- Se ejecuta después de perfiles.sql.

-- 1) Tablas de empresa: ver = miembros, cambiar = solo admin
do $$
declare t text;
begin
  foreach t in array array[
    'projects','facturas','hojas_gasto','groups_bp','groups_cv','crm','calendario','actas',
    'presupuestos_2026','presupuestos_activos','estrategia','estrategia_activos','proyecto_roles',
    'evaluaciones_members','evaluaciones_scores','member_colors','mta_progress','diamante','horas_proyecto'
  ] loop
    execute format('drop policy if exists "solo miembros" on public.%I', t);
    execute format('drop policy if exists "ver" on public.%I', t);
    execute format('drop policy if exists "solo admin" on public.%I', t);
    execute format('create policy "ver" on public.%I for select to authenticated using (public.es_miembro())', t);
    execute format('create policy "solo admin" on public.%I for all to authenticated using (public.es_admin()) with check (public.es_admin())', t);
  end loop;
end $$;

-- 2) audit_progress: las horas ("horas|<id>") son de cada persona; el resto de claves, solo admin
drop policy if exists "solo miembros" on public.audit_progress;
drop policy if exists "ver" on public.audit_progress;
drop policy if exists "crear lo mio" on public.audit_progress;
drop policy if exists "editar lo mio" on public.audit_progress;
drop policy if exists "borrar lo mio" on public.audit_progress;
create policy "ver" on public.audit_progress for select to authenticated using (public.es_miembro());
create policy "crear lo mio" on public.audit_progress for insert to authenticated
  with check (public.es_admin() or (key like 'horas|%' and val->>'persona' = public.mi_nombre()));
create policy "editar lo mio" on public.audit_progress for update to authenticated
  using (public.es_admin() or (key like 'horas|%' and val->>'persona' = public.mi_nombre()))
  with check (public.es_admin() or (key like 'horas|%' and coalesce(val->>'persona', public.mi_nombre()) = public.mi_nombre()));
create policy "borrar lo mio" on public.audit_progress for delete to authenticated
  using (public.es_admin() or (key like 'horas|%' and val->>'persona' = public.mi_nombre()));

-- 3) Solicitudes de hoja de gasto: cualquiera puede ENVIAR la suya; aprobar/editar/borrar, solo admin
drop policy if exists "solo miembros" on public.solicitudes_hoja_gasto;
drop policy if exists "ver" on public.solicitudes_hoja_gasto;
drop policy if exists "enviar" on public.solicitudes_hoja_gasto;
drop policy if exists "solo admin" on public.solicitudes_hoja_gasto;
create policy "ver" on public.solicitudes_hoja_gasto for select to authenticated using (public.es_miembro());
create policy "enviar" on public.solicitudes_hoja_gasto for insert to authenticated
  with check (public.es_miembro() and coalesce(estado,'pendiente') = 'pendiente');
create policy "solo admin" on public.solicitudes_hoja_gasto for update to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy "solo admin borrar" on public.solicitudes_hoja_gasto for delete to authenticated
  using (public.es_admin());

-- 4) Archivos: cualquiera sube sus PDFs de gasto; el extracto del banco (banco/…) y borrar/cambiar, solo admin
drop policy if exists "hoja_gasto subir" on storage.objects;
drop policy if exists "hoja_gasto cambiar" on storage.objects;
drop policy if exists "hoja_gasto borrar" on storage.objects;
create policy "hoja_gasto subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'hoja_gasto' and public.es_miembro() and (name not like 'banco/%' or public.es_admin()));
create policy "hoja_gasto cambiar" on storage.objects for update to authenticated
  using (bucket_id = 'hoja_gasto' and public.es_admin());
create policy "hoja_gasto borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'hoja_gasto' and public.es_admin());

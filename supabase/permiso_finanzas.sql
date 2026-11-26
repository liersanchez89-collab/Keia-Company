-- 26/11/2026: permiso de "líder financiera" (Naroa).
-- Quien tenga perfiles.finanzas = true (o sea admin) puede, en Finanzas, aprobar/rechazar/borrar
-- solicitudes de hoja de gasto de todos, cambiar/borrar archivos y subir extractos del banco.
-- Para dárselo a otra persona: update perfiles set finanzas = true where email = '...';
alter table public.perfiles add column if not exists finanzas boolean not null default false;
update public.perfiles set finanzas = true where email = 'naroa.orellana@alumni.mondragon.edu';

create or replace function public.es_finanzas() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where email = lower(auth.jwt()->>'email') and (rol = 'admin' or finanzas));
$$;
revoke execute on function public.es_finanzas() from public, anon;
grant execute on function public.es_finanzas() to authenticated;

drop policy if exists "solo admin" on public.solicitudes_hoja_gasto;
drop policy if exists "solo admin borrar" on public.solicitudes_hoja_gasto;
create policy "solo admin" on public.solicitudes_hoja_gasto for update to authenticated
  using (public.es_finanzas()) with check (public.es_finanzas());
create policy "solo admin borrar" on public.solicitudes_hoja_gasto for delete to authenticated
  using (public.es_finanzas());

drop policy if exists "hoja_gasto subir" on storage.objects;
drop policy if exists "hoja_gasto cambiar" on storage.objects;
drop policy if exists "hoja_gasto borrar" on storage.objects;
create policy "hoja_gasto subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'hoja_gasto' and public.es_miembro() and (name not like 'banco/%' or public.es_finanzas()));
create policy "hoja_gasto cambiar" on storage.objects for update to authenticated
  using (bucket_id = 'hoja_gasto' and public.es_finanzas());
create policy "hoja_gasto borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'hoja_gasto' and public.es_finanzas());

-- Acceso solo para miembros de KEIA.
-- Las cuentas se crean en Authentication → Users (email + contraseña) y el correo
-- tiene que estar en la tabla miembros_permitidos. Para añadir a alguien:
--   insert into miembros_permitidos(email) values ('nombre@alumni.mondragon.edu');
-- y crea su usuario en Authentication → Users → Add user (marca "Auto Confirm User").

create table if not exists public.miembros_permitidos (email text primary key);
alter table public.miembros_permitidos enable row level security;

create or replace function public.es_miembro() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.miembros_permitidos where email = lower(auth.jwt()->>'email'));
$$;
revoke execute on function public.es_miembro() from public, anon;
grant execute on function public.es_miembro() to authenticated;

-- Todas las tablas de datos: solo usuarios logueados que estén en la lista
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename <> 'miembros_permitidos' loop
    execute format('drop policy if exists "acceso app" on public.%I', t);
    execute format('drop policy if exists "solo miembros" on public.%I', t);
    execute format('create policy "solo miembros" on public.%I for all to authenticated using (public.es_miembro()) with check (public.es_miembro())', t);
  end loop;
end $$;

-- Archivos (hojas de gasto, extractos): solo miembros pueden listar, subir o borrar
drop policy if exists "hoja_gasto leer" on storage.objects;
drop policy if exists "hoja_gasto subir" on storage.objects;
drop policy if exists "hoja_gasto cambiar" on storage.objects;
drop policy if exists "hoja_gasto borrar" on storage.objects;
create policy "hoja_gasto leer"    on storage.objects for select to authenticated using (bucket_id = 'hoja_gasto' and public.es_miembro());
create policy "hoja_gasto subir"   on storage.objects for insert to authenticated with check (bucket_id = 'hoja_gasto' and public.es_miembro());
create policy "hoja_gasto cambiar" on storage.objects for update to authenticated using (bucket_id = 'hoja_gasto' and public.es_miembro());
create policy "hoja_gasto borrar"  on storage.objects for delete to authenticated using (bucket_id = 'hoja_gasto' and public.es_miembro());

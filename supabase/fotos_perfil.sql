-- Fotos de perfil: cada persona sube y cambia SOLO la suya (los admin, la de cualquiera).
-- Todos los miembros ven las fotos de todos.
-- Las imágenes van al bucket público "avatares", en la carpeta <id de usuario>/.

create table if not exists public.fotos_perfil (
  nombre     text primary key,          -- el mismo nombre que en src/config.js → MIEMBROS
  url        text not null,
  updated_at timestamptz not null default now()
);
alter table public.fotos_perfil enable row level security;

drop policy if exists "ver" on public.fotos_perfil;
drop policy if exists "crear la mia" on public.fotos_perfil;
drop policy if exists "cambiar la mia" on public.fotos_perfil;
drop policy if exists "borrar la mia" on public.fotos_perfil;
create policy "ver" on public.fotos_perfil for select to authenticated using (public.es_miembro());
create policy "crear la mia" on public.fotos_perfil for insert to authenticated
  with check (public.es_miembro() and (nombre = public.mi_nombre() or public.es_admin()));
create policy "cambiar la mia" on public.fotos_perfil for update to authenticated
  using (nombre = public.mi_nombre() or public.es_admin())
  with check (nombre = public.mi_nombre() or public.es_admin());
create policy "borrar la mia" on public.fotos_perfil for delete to authenticated
  using (nombre = public.mi_nombre() or public.es_admin());

-- Tiempo real: si alguien cambia su foto, los demás la ven al momento
do $$ begin
  alter publication supabase_realtime add table public.fotos_perfil;
exception when duplicate_object then null; end $$;

-- Almacenamiento de las imágenes
insert into storage.buckets (id, name, public) values ('avatares','avatares', true)
  on conflict (id) do nothing;
drop policy if exists "avatares leer" on storage.objects;
drop policy if exists "avatares subir" on storage.objects;
drop policy if exists "avatares cambiar" on storage.objects;
drop policy if exists "avatares borrar" on storage.objects;
create policy "avatares leer" on storage.objects for select to authenticated
  using (bucket_id = 'avatares');
create policy "avatares subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatares' and public.es_miembro() and ((storage.foldername(name))[1] = auth.uid()::text or public.es_admin()));
create policy "avatares cambiar" on storage.objects for update to authenticated
  using (bucket_id = 'avatares' and ((storage.foldername(name))[1] = auth.uid()::text or public.es_admin()));
create policy "avatares borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'avatares' and ((storage.foldername(name))[1] = auth.uid()::text or public.es_admin()));

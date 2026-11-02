-- Perfiles: cada cuenta (correo) es una persona concreta de KEIA.
-- Cada uno solo puede crear, editar y borrar SUS bookpoints, customers y mensajes del chat.
-- Todos pueden ver todo. Los admin pueden tocarlo todo.
-- Para añadir a alguien nuevo: insert into perfiles(email,nombre) values ('x@alumni.mondragon.edu','Nombre');
-- (el nombre tiene que ser exactamente el mismo que en src/config.js → MIEMBROS)

create table if not exists public.perfiles (
  email  text primary key,
  nombre text not null unique,
  rol    text not null default 'miembro' check (rol in ('miembro','admin'))
);
alter table public.perfiles enable row level security;

drop policy if exists "ver perfiles" on public.perfiles;
create policy "ver perfiles" on public.perfiles for select to authenticated using (public.es_miembro());
-- Nadie puede cambiar perfiles desde la app (ni su rol ni su nombre). Solo desde el panel de Supabase.

insert into public.perfiles(email,nombre,rol) values
  ('lier.sanchez@alumni.mondragon.edu','Lier','admin'),
  ('asier.anchustegui@alumni.mondragon.edu','Asier Anchustegi','miembro'),
  ('eneko.guineag@alumni.mondragon.edu','Eneko Guinea','miembro'),
  ('ander.iribar@alumni.mondragon.edu','Ander','miembro'),
  ('asier.olloqui@alumni.mondragon.edu','Asier Olloqui','miembro'),
  ('asier.garciama@alumni.mondragon.edu','Asier Garcia','miembro'),
  ('eneko.ruizd@alumni.mondragon.edu','Eneko Ruiz','miembro'),
  ('bruno.bravo@alumni.mondragon.edu','Bruno','miembro'),
  ('garazi.lopezm@alumni.mondragon.edu','Garazi','miembro'),
  ('leire.ferreiro@alumni.mondragon.edu','Leire','miembro'),
  ('mario.espinosa@alumni.mondragon.edu','Mario','miembro'),
  ('naiara.novo@alumni.mondragon.edu','Naiara','miembro'),
  ('naroa.orellana@alumni.mondragon.edu','Naroa','miembro'),
  ('unai.arrausi@alumni.mondragon.edu','Unai','miembro'),
  ('xabi.antia@alumni.mondragon.edu','Xabi','miembro'),
  ('markel.mediavilla@alumni.mondragon.edu','Markel','miembro'),
  ('sarakristine.ovalle@alumni.mondragon.edu','Sara','miembro'),
  ('alejandro.juaristi@alumni.mondragon.edu','Alex','miembro'),
  ('iker.arrue@alumni.mondragon.edu','Iker','miembro'),
  ('smaryam@mondragon.edu','Maryam','miembro')
on conflict (email) do update set nombre = excluded.nombre, rol = excluded.rol;

create or replace function public.mi_nombre() returns text
language sql stable security definer set search_path = public as $$
  select nombre from public.perfiles where email = lower(auth.jwt()->>'email');
$$;
create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where email = lower(auth.jwt()->>'email') and rol = 'admin');
$$;
revoke execute on function public.mi_nombre(), public.es_admin() from public, anon;
grant execute on function public.mi_nombre(), public.es_admin() to authenticated;

-- BOOKPOINTS: cada uno lo suyo
drop policy if exists "solo miembros" on public.bookpoints;
drop policy if exists "ver" on public.bookpoints;
drop policy if exists "crear lo mio" on public.bookpoints;
drop policy if exists "editar lo mio" on public.bookpoints;
drop policy if exists "borrar lo mio" on public.bookpoints;
create policy "ver" on public.bookpoints for select to authenticated using (public.es_miembro());
create policy "crear lo mio" on public.bookpoints for insert to authenticated
  with check (member = public.mi_nombre() or public.es_admin());
create policy "editar lo mio" on public.bookpoints for update to authenticated
  using (member = public.mi_nombre() or public.es_admin())
  with check (member = public.mi_nombre() or public.es_admin());
create policy "borrar lo mio" on public.bookpoints for delete to authenticated
  using (member = public.mi_nombre() or public.es_admin());

-- CUSTOMERS: lo tuyo, y también las copias que tú creas en la lista de tus compañeros (linked_owner)
drop policy if exists "solo miembros" on public.customers;
drop policy if exists "ver" on public.customers;
drop policy if exists "crear lo mio" on public.customers;
drop policy if exists "editar lo mio" on public.customers;
drop policy if exists "borrar lo mio" on public.customers;
create policy "ver" on public.customers for select to authenticated using (public.es_miembro());
create policy "crear lo mio" on public.customers for insert to authenticated
  with check (member = public.mi_nombre() or linked_owner = public.mi_nombre() or public.es_admin());
create policy "editar lo mio" on public.customers for update to authenticated
  using (member = public.mi_nombre() or linked_owner = public.mi_nombre() or public.es_admin())
  with check (member = public.mi_nombre() or linked_owner = public.mi_nombre() or public.es_admin());
create policy "borrar lo mio" on public.customers for delete to authenticated
  using (member = public.mi_nombre() or linked_owner = public.mi_nombre() or public.es_admin());

-- CHAT: solo puedes escribir con tu nombre y borrar tus mensajes
drop policy if exists "solo miembros" on public.chat_messages;
drop policy if exists "ver" on public.chat_messages;
drop policy if exists "escribir como yo" on public.chat_messages;
drop policy if exists "editar lo mio" on public.chat_messages;
drop policy if exists "borrar lo mio" on public.chat_messages;
create policy "ver" on public.chat_messages for select to authenticated using (public.es_miembro());
create policy "escribir como yo" on public.chat_messages for insert to authenticated
  with check (autor = public.mi_nombre());
create policy "editar lo mio" on public.chat_messages for update to authenticated
  using (autor = public.mi_nombre() or public.es_admin())
  with check (autor = public.mi_nombre() or public.es_admin());
create policy "borrar lo mio" on public.chat_messages for delete to authenticated
  using (autor = public.mi_nombre() or public.es_admin());

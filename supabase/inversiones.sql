-- 26/11/2026: 📈 Inversiones (pestaña de Finanzas). Solo registro: no suma ni resta en Ingresos y gastos.
-- Todos los miembros (admin o miembro) ven, añaden, editan y borran; los visitantes solo ven.
create table if not exists public.inversiones (
  id            text primary key,
  concepto      text not null,
  tipo          text not null default 'otra',   -- equipo | digital | financiera | socio | otra
  fecha         date not null default current_date,
  importe       numeric(12,2) not null check (importe >= 0),
  valor_actual  numeric(12,2),
  proyecto      text,
  persona       text,
  notas         text,
  creado_por    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.inversiones enable row level security;

create or replace function public.puede_gestionar() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where email = lower(auth.jwt()->>'email') and rol in ('admin','miembro'));
$$;
revoke execute on function public.puede_gestionar() from public, anon;
grant execute on function public.puede_gestionar() to authenticated;

drop policy if exists "ver" on public.inversiones;
drop policy if exists "gestionar" on public.inversiones;
create policy "ver" on public.inversiones for select to authenticated using (public.es_miembro());
create policy "gestionar" on public.inversiones for all to authenticated
  using (public.es_miembro() and public.puede_gestionar())
  with check (public.es_miembro() and public.puede_gestionar());

-- Tiempo real (para que se vea al momento lo que añaden los demás)
do $$ begin
  alter publication supabase_realtime add table public.inversiones;
exception when duplicate_object then null; end $$;

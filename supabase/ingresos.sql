-- 26/11/2026: 💰 Ingresos (dinero ganado sin factura). Van en la tabla facturas con es_ingreso = true
alter table public.facturas add column if not exists es_ingreso boolean not null default false;
-- El dinero metido hasta ahora (Action Week) pasa de Facturas a Ingresos
update public.facturas set es_ingreso = true where tipo = 'ingreso' and ref = 'ACTION WEEK';
-- Desde ahora es_ingreso = true también en gastos: marca los movimientos de "💰 Ingresos y gastos",
-- que son lo único que cuenta. Las facturas (es_ingreso = false) son solo registro.

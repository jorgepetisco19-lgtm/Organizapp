-- Organizapp · cambio 2: eventos "de los dos" (un solo registro, con color propio)
-- Cómo usarlo: Supabase → SQL Editor → New query → pegar esto → Run.
-- Solo añade una columna; no toca datos ni reglas de acceso (las reglas de siempre se aplican igual:
-- cada persona edita lo suyo y la pareja puede editar todo).
alter table public.eventos add column if not exists compartido boolean not null default false;
notify pgrst, 'reload schema';

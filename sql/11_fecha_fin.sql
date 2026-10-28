-- Organizapp · SQL 11: eventos que acaban otro día (turno de noche, viajes…), también si se repiten cada semana.
-- Pégalo entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez sin problema.
-- No borra ni cambia ningún evento: añade una columna (por defecto 0 = acaba el mismo día)
-- y cambia la regla «la hora de fin no puede ser anterior a la de inicio», que ya no vale para un turno 22:00 → 06:00.

alter table public.eventos add column if not exists dias_extra smallint not null default 0;

-- Quita la regla antigua (da igual el nombre que tenga en tu base de datos).
do $$
declare r record;
begin
  for r in select conname from pg_constraint
           where conrelid = 'public.eventos'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%hora_fin >= hora_inicio%'
  loop
    execute format('alter table public.eventos drop constraint %I', r.conname);
  end loop;
end $$;

-- Reglas nuevas:
--  · un evento puede acabar hasta 30 días después de empezar (6 si se repite cada semana, para que no se solape consigo mismo);
--  · la hora de fin solo puede ser anterior a la de inicio si el evento acaba otro día.
alter table public.eventos drop constraint if exists eventos_dias_extra_ok;
alter table public.eventos add constraint eventos_dias_extra_ok
  check (dias_extra between 0 and 30 and (repeticion is null or dias_extra <= 6));
alter table public.eventos drop constraint if exists eventos_hora_fin_ok;
alter table public.eventos add constraint eventos_hora_fin_ok
  check (hora_fin is null or hora_inicio is null or dias_extra > 0 or hora_fin >= hora_inicio);

notify pgrst, 'reload schema';

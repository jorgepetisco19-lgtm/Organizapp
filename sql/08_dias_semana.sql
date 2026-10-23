-- Organizapp · SQL 08: eventos que se repiten varios días a la semana (lunes, miércoles y viernes, por ejemplo).
-- Pégalo entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez sin problema.
-- dias_semana: 0 = lunes … 6 = domingo. Vacío (null) = se repite el mismo día de la semana que su fecha (como hasta ahora).

alter table public.eventos add column if not exists dias_semana smallint[];
alter table public.eventos drop constraint if exists eventos_dias_semana_ok;
alter table public.eventos add constraint eventos_dias_semana_ok check (
  dias_semana is null
  or (repeticion is not null and repeticion = 'semanal' and cardinality(dias_semana) between 1 and 7 and dias_semana <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[])
);

notify pgrst, 'reload schema';

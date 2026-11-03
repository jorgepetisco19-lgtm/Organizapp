-- Organizapp · SQL 12: copias vinculadas. Un evento que copias a otro calendario tuyo sigue siendo «el mismo»:
-- si cambias la hora, el título, la fecha… en uno, se cambia también en las otras copias.
-- Pégalo entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez sin problema.
--
-- Qué se sincroniza: tipo, título, fecha, horas, notas, repetición (y «hasta cuándo»), días extra y «hecha».
-- Qué NO se sincroniza (queda por calendario): borrar el evento, quitar un solo día de una serie, de quién es y para quién,
-- y el subtipo de las citas (cada calendario tiene los suyos).
-- Quién puede: solo se cambian las copias que quien edita también podría editar a mano (nadie toca un calendario que no es suyo).
-- Las copias que ya existían (mismo dueño, mismo título, día, hora y tipo en distintos calendarios) se vinculan solas.

alter table public.eventos add column if not exists grupo_copia uuid;
create index if not exists eventos_grupo_copia_idx on public.eventos (grupo_copia) where grupo_copia is not null;

-- Al cambiar un evento vinculado, copia el cambio a las demás copias que quien edita puede editar.
create or replace function public.sincronizar_copias()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c record;
begin
  if pg_trigger_depth() > 1 then return null; end if;   -- los cambios que hace esta misma función no vuelven a disparar nada
  if new.grupo_copia is null then return null; end if;
  for c in select id, espacio_id, owner_id, creado_por, participantes, subtipo_id
           from public.eventos where grupo_copia = new.grupo_copia and id <> new.id
  loop
    if not public.puede_editar_evento(c.espacio_id, c.owner_id, c.creado_por, c.participantes) then continue; end if;
    update public.eventos set
      tipo = new.tipo, titulo = new.titulo, fecha = new.fecha, hora_inicio = new.hora_inicio, hora_fin = new.hora_fin,
      notas = new.notas, repeticion = new.repeticion, repite_hasta = new.repite_hasta, dias_semana = new.dias_semana,
      dias_extra = new.dias_extra, hechas = new.hechas,
      subtipo_id = case when new.tipo = 'compromiso' then c.subtipo_id else null end
    where id = c.id;
  end loop;
  return null;
end $$;
drop trigger if exists eventos_sincronizar on public.eventos;
create trigger eventos_sincronizar after update on public.eventos
  for each row
  when (old.grupo_copia is not distinct from new.grupo_copia and (
        old.tipo is distinct from new.tipo or old.titulo is distinct from new.titulo or old.fecha is distinct from new.fecha
        or old.hora_inicio is distinct from new.hora_inicio or old.hora_fin is distinct from new.hora_fin
        or old.notas is distinct from new.notas or old.repeticion is distinct from new.repeticion
        or old.repite_hasta is distinct from new.repite_hasta or old.dias_semana is distinct from new.dias_semana
        or old.dias_extra is distinct from new.dias_extra or old.hechas is distinct from new.hechas))
  execute function public.sincronizar_copias();

-- Si de un grupo solo queda un evento (se borraron las otras copias), deja de estar vinculado.
create or replace function public.limpiar_grupo_copia()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.grupo_copia is not null
     and (select count(*) from public.eventos where grupo_copia = old.grupo_copia) = 1 then
    update public.eventos set grupo_copia = null where grupo_copia = old.grupo_copia;
  end if;
  return null;
end $$;
drop trigger if exists eventos_limpiar_grupo on public.eventos;
create trigger eventos_limpiar_grupo after delete on public.eventos
  for each row execute function public.limpiar_grupo_copia();

-- Vincula las copias que ya tienes: mismo dueño, mismo tipo, título (sin mayúsculas), día, horas y repetición, en calendarios distintos.
with candidatas as (
  select id, espacio_id,
         concat_ws('|', owner_id, tipo, lower(btrim(titulo)), fecha, coalesce(hora_inicio::text, ''), coalesce(hora_fin::text, ''),
                   dias_extra, coalesce(repeticion, ''), coalesce(dias_semana::text, '')) as clave,
         row_number() over (partition by owner_id, tipo, lower(btrim(titulo)), fecha, hora_inicio, hora_fin, dias_extra, repeticion, dias_semana, espacio_id
                            order by creado, id) as n
  from public.eventos
  where grupo_copia is null
), grupos as (
  select clave, gen_random_uuid() as g from candidatas where n = 1 group by clave having count(*) > 1
)
update public.eventos e set grupo_copia = gr.g
from candidatas c join grupos gr on gr.clave = c.clave
where e.id = c.id and c.n = 1;

revoke all on function public.sincronizar_copias(), public.limpiar_grupo_copia() from public, anon, authenticated;

notify pgrst, 'reload schema';

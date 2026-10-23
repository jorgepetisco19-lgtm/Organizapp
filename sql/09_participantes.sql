-- Organizapp · SQL 09: eventos de varias personas (por ejemplo, un partido solo para dos de los cuatro del calendario).
-- Pégalo entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez sin problema.
-- participantes: las personas del evento (de 2 a 5). Vacío (null) = como hasta ahora: de una persona o, si es «compartido», de todas.

alter table public.eventos add column if not exists participantes uuid[];
alter table public.eventos drop constraint if exists eventos_participantes_ok;
alter table public.eventos add constraint eventos_participantes_ok check (
  participantes is null
  or (not compartido and cardinality(participantes) between 2 and 5 and owner_id = any(participantes))
);

-- Quien está en un evento de varias personas debe ser del calendario, sin repetirse, y quien lo añade debe poder editar su agenda
-- (así un «amigo» no puede apuntar a otra persona en un evento).
create or replace function public.validar_participantes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare p uuid;
begin
  if new.participantes is null then return new; end if;
  if tg_op = 'UPDATE' and new.participantes is not distinct from old.participantes and new.espacio_id = old.espacio_id then return new; end if;
  if (select count(distinct x) from unnest(new.participantes) x) <> cardinality(new.participantes) then
    raise exception 'Hay personas repetidas en el evento.';
  end if;
  foreach p in array new.participantes loop
    if not exists (select 1 from public.miembros where espacio_id = new.espacio_id and user_id = p) then
      raise exception 'Todas las personas del evento deben estar en el calendario.';
    end if;
    if (tg_op = 'INSERT' or old.participantes is null or not (p = any(old.participantes)))
       and not public.puede_editar(new.espacio_id, p) then
      raise exception 'No puedes añadir a una persona cuya agenda no puedes editar.';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists eventos_participantes on public.eventos;
create trigger eventos_participantes before insert or update of participantes, espacio_id on public.eventos
  for each row execute function public.validar_participantes();

-- ¿Puede quien llama modificar este evento? Los de una persona (o de todos): como siempre (su dueño o la pareja).
-- Los de varias personas: quien lo creó o cualquier persona con relación «pareja» (un «amigo» que solo participa lo ve, pero no lo cambia).
create or replace function public.puede_editar_evento(esp uuid, owner uuid, creador uuid, participantes uuid[])
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when participantes is null then public.puede_editar(esp, owner)
    else exists (select 1 from public.miembros m
                 where m.espacio_id = esp and m.user_id = (select auth.uid())
                   and (m.relacion = 'pareja' or creador = (select auth.uid())))
  end
$$;

drop policy if exists eventos_crear on public.eventos;
create policy eventos_crear on public.eventos for insert to authenticated
  with check (public.puede_editar_evento(espacio_id, owner_id, creado_por, participantes) and creado_por = (select auth.uid()));
drop policy if exists eventos_editar on public.eventos;
create policy eventos_editar on public.eventos for update to authenticated
  using (public.puede_editar_evento(espacio_id, owner_id, creado_por, participantes))
  with check (public.puede_editar_evento(espacio_id, owner_id, creado_por, participantes));
drop policy if exists eventos_borrar on public.eventos;
create policy eventos_borrar on public.eventos for delete to authenticated
  using (public.puede_editar_evento(espacio_id, owner_id, creado_por, participantes));

-- Interna: saca a alguien de un calendario. Sus eventos y menús se borran; los eventos "de todos" que creó pasan a quien creó el calendario;
-- en los eventos de varias personas se le quita de la lista (si queda una sola, pasa a ser un evento normal de esa persona).
create or replace function public.limpiar_miembro(esp uuid, quien uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare creador uuid := (select creado_por from public.espacios where id = esp);
begin
  update public.eventos set
    participantes = case when cardinality(array_remove(participantes, quien)) < 2 then null else array_remove(participantes, quien) end,
    owner_id = case when owner_id = quien then (array_remove(participantes, quien))[1] else owner_id end
  where espacio_id = esp and participantes @> array[quien];
  if creador is not null then
    update public.eventos set owner_id = creador where espacio_id = esp and owner_id = quien and compartido;
  end if;
  delete from public.eventos where espacio_id = esp and owner_id = quien;
  delete from public.menu where espacio_id = esp and owner_id = quien;
  delete from public.miembros where espacio_id = esp and user_id = quien;
end $$;

revoke all on function public.validar_participantes(), public.limpiar_miembro(uuid, uuid), public.puede_editar_evento(uuid, uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.puede_editar_evento(uuid, uuid, uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';

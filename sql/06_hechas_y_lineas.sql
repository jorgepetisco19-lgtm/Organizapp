-- Organizapp · SQL 06: tareas hechas, pasos dentro de una tarea y lista de la compra.
-- Pégalo entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez sin problema.
--
--  1) eventos.hechas: los días en que una tarea está marcada como hecha (así una tarea que se repite se marca día a día).
--  2) lineas: una línea es un paso de una tarea (evento_id) o un producto de la lista de la compra del calendario (evento_id vacío).
--     - La lista de la compra: la ven y la editan todas las personas del calendario.
--     - Los pasos de una tarea: los ven todas las personas del calendario; los edita quien puede editar esa tarea.
--     - Nadie de fuera del calendario ve ni toca nada. Límites: 300 líneas en la lista de la compra y 100 pasos por tarea.

alter table public.eventos add column if not exists hechas date[] not null default '{}';

create table if not exists public.lineas (
  id          uuid primary key default gen_random_uuid(),
  espacio_id  uuid not null references public.espacios(id) on delete cascade,
  evento_id   uuid references public.eventos(id) on delete cascade,   -- vacío = lista de la compra del calendario
  texto       text not null check (char_length(texto) between 1 and 200),
  hecha       boolean not null default false,
  orden       bigint not null default (extract(epoch from clock_timestamp()) * 1000)::bigint,
  creado_por  uuid references auth.users(id) on delete set null,
  creada      timestamptz not null default now()
);
create index if not exists lineas_espacio_idx on public.lineas (espacio_id) where evento_id is null;
create index if not exists lineas_evento_idx on public.lineas (evento_id);
alter table public.lineas enable row level security;

-- ¿Puede quien llama escribir esta línea? La lista de la compra: cualquier miembro del calendario.
-- Un paso de tarea: solo si la tarea es de ese mismo calendario, es de tipo tarea y puede editarla.
create or replace function public.puede_editar_linea(esp uuid, ev uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when ev is null then exists (select 1 from public.miembros where espacio_id = esp and user_id = (select auth.uid()))
    else exists (select 1 from public.eventos e
                 where e.id = ev and e.espacio_id = esp and e.tipo = 'tarea'
                   and public.puede_editar(e.espacio_id, e.owner_id))
  end
$$;

create or replace function public.limitar_lineas()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.evento_id is null then
    if (select count(*) from public.lineas where espacio_id = new.espacio_id and evento_id is null) >= 300 then
      raise exception 'La lista de la compra ya tiene 300 líneas.';
    end if;
  elsif (select count(*) from public.lineas where evento_id = new.evento_id) >= 100 then
    raise exception 'Esta tarea ya tiene 100 pasos.';
  end if;
  return new;
end $$;
drop trigger if exists lineas_limite on public.lineas;
create trigger lineas_limite before insert on public.lineas
  for each row execute function public.limitar_lineas();

drop policy if exists lineas_ver on public.lineas;
create policy lineas_ver on public.lineas for select to authenticated
  using (public.es_miembro(espacio_id));

drop policy if exists lineas_crear on public.lineas;
create policy lineas_crear on public.lineas for insert to authenticated
  with check (public.puede_editar_linea(espacio_id, evento_id) and creado_por = (select auth.uid()));

drop policy if exists lineas_editar on public.lineas;
create policy lineas_editar on public.lineas for update to authenticated
  using (public.puede_editar_linea(espacio_id, evento_id))
  with check (public.puede_editar_linea(espacio_id, evento_id));

drop policy if exists lineas_borrar on public.lineas;
create policy lineas_borrar on public.lineas for delete to authenticated
  using (public.puede_editar_linea(espacio_id, evento_id));

-- Permisos: solo quien ha iniciado sesión; el calendario y la tarea de una línea no se pueden cambiar después.
revoke all on public.lineas from public, anon, authenticated;
grant select, insert, delete on public.lineas to authenticated;
grant update (texto, hecha, orden) on public.lineas to authenticated;

revoke all on function public.puede_editar_linea(uuid, uuid), public.limitar_lineas() from public, anon, authenticated;
grant execute on function public.puede_editar_linea(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

-- Organizapp · SQL 10: subtipos de cita (por ejemplo: médica, peluquería) con su color, a nivel de calendario.
-- Pégalo entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez sin problema.
-- Solo AÑADE cosas nuevas: no cambia ni borra nada de lo que ya tienes.

create table if not exists public.subtipos (
  id          uuid primary key default gen_random_uuid(),
  espacio_id  uuid not null references public.espacios(id) on delete cascade,
  nombre      text not null check (char_length(btrim(nombre)) between 1 and 40),
  color       text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  creado_por  uuid references auth.users(id) on delete set null,
  creado      timestamptz not null default now()
);
create unique index if not exists subtipos_nombre_idx on public.subtipos (espacio_id, lower(btrim(nombre)));
alter table public.subtipos enable row level security;

alter table public.eventos add column if not exists subtipo_id uuid references public.subtipos(id) on delete set null;
alter table public.eventos drop constraint if exists eventos_subtipo_ok;
alter table public.eventos add constraint eventos_subtipo_ok check (subtipo_id is null or tipo = 'compromiso');
create index if not exists eventos_subtipo_idx on public.eventos (subtipo_id) where subtipo_id is not null;

-- Máximo 20 subtipos por calendario.
create or replace function public.limitar_subtipos()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.subtipos where espacio_id = new.espacio_id) >= 20 then
    raise exception 'Este calendario ya tiene 20 subtipos.';
  end if;
  return new;
end $$;
drop trigger if exists subtipos_limite on public.subtipos;
create trigger subtipos_limite before insert on public.subtipos
  for each row execute function public.limitar_subtipos();

-- El subtipo de un evento tiene que ser de su mismo calendario.
create or replace function public.validar_subtipo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.subtipo_id is not null and not exists (
    select 1 from public.subtipos where id = new.subtipo_id and espacio_id = new.espacio_id
  ) then
    raise exception 'Ese subtipo no es de este calendario.';
  end if;
  return new;
end $$;
drop trigger if exists eventos_subtipo on public.eventos;
create trigger eventos_subtipo before insert or update of subtipo_id, espacio_id on public.eventos
  for each row execute function public.validar_subtipo();

-- Subtipos: los ve cualquier persona del calendario; los crea cualquiera del calendario;
-- los cambia o borra quien los creó o quien tiene rol «pareja».
drop policy if exists subtipos_ver on public.subtipos;
create policy subtipos_ver on public.subtipos for select to authenticated
  using (public.es_miembro(espacio_id));

drop policy if exists subtipos_crear on public.subtipos;
create policy subtipos_crear on public.subtipos for insert to authenticated
  with check (public.es_miembro(espacio_id) and creado_por = (select auth.uid()));

drop policy if exists subtipos_editar on public.subtipos;
create policy subtipos_editar on public.subtipos for update to authenticated
  using (public.es_miembro(espacio_id) and (public.es_pareja(espacio_id) or creado_por = (select auth.uid())))
  with check (public.es_miembro(espacio_id) and (public.es_pareja(espacio_id) or creado_por = (select auth.uid())));

drop policy if exists subtipos_borrar on public.subtipos;
create policy subtipos_borrar on public.subtipos for delete to authenticated
  using (public.es_miembro(espacio_id) and (public.es_pareja(espacio_id) or creado_por = (select auth.uid())));

revoke all on public.subtipos from public, anon, authenticated;
grant select, insert, delete on public.subtipos to authenticated;
grant update (nombre, color) on public.subtipos to authenticated;
revoke all on function public.limitar_subtipos(), public.validar_subtipo() from public, anon, authenticated;

notify pgrst, 'reload schema';

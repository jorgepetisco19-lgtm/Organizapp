-- Organizapp · cambio 4: varios calendarios por persona
-- Cómo usarlo: Supabase → SQL Editor → New query → pegar TODO esto → Run. Se puede ejecutar más de una vez.
-- Qué hace: quita el límite de "un calendario por persona" (hasta 20), pone el color por calendario,
-- permite invitar a amigos a un calendario con un rol, y añade salir / quitar a alguien / renombrar / borrar calendario.
-- Los calendarios y datos que ya tienes se quedan tal cual.

-- Color por calendario (antes era uno global por persona) y destino de invitación por amigo (sin correo).
alter table public.miembros add column if not exists color text;
update public.miembros m set color = p.color from public.perfiles p where p.id = m.user_id and m.color is null;
alter table public.miembros alter column color set default '#3b82f6';
alter table public.miembros alter column color set not null;
do $$ begin
  alter table public.miembros add constraint miembros_color_check check (color ~ '^#[0-9a-fA-F]{6}$');
exception when duplicate_object then null; end $$;

alter table public.invitaciones add column if not exists para_user uuid references public.perfiles(id) on delete cascade;
alter table public.invitaciones alter column email drop not null;
do $$ begin
  alter table public.invitaciones add constraint invitaciones_destino_check
    check ((email is not null and para_user is null) or (email is null and para_user is not null));
exception when duplicate_object then null; end $$;
create unique index if not exists invitaciones_amigo_idx on public.invitaciones (espacio_id, para_user) where para_user is not null;

-- ---------- VARIOS CALENDARIOS POR PERSONA ----------

-- Un color para quien entra a un calendario: el suyo, o uno libre de la paleta si ya lo usa otro miembro.
create or replace function public.color_libre(esp uuid, preferido text)
returns text language plpgsql stable set search_path = '' as $$
declare
  paleta text[] := array['#3b82f6','#f97316','#10b981','#a855f7','#ef4444','#eab308','#06b6d4','#ec4899'];
  c text;
begin
  if not exists (select 1 from public.miembros where espacio_id = esp and lower(color) = lower(preferido)) then
    return preferido;
  end if;
  foreach c in array paleta loop
    if not exists (select 1 from public.miembros where espacio_id = esp and lower(color) = c) then return c; end if;
  end loop;
  return preferido;
end $$;

-- Crea un calendario nuevo y te hace miembro con relación "pareja". Puedes tener hasta 20.
create or replace function public.crear_espacio(p_nombre text default 'Nuestro calendario')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  esp uuid;
  mi_color text;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  select color into mi_color from public.perfiles where id = uid;
  if mi_color is null then raise exception 'Falta tu perfil'; end if;
  if (select count(*) from public.miembros where user_id = uid) >= 20 then
    raise exception 'Has llegado al máximo de 20 calendarios.';
  end if;
  insert into public.espacios (nombre, creado_por)
  values (left(coalesce(nullif(trim(p_nombre), ''), 'Nuestro calendario'), 80), uid)
  returning id into esp;
  insert into public.miembros (espacio_id, user_id, relacion, color) values (esp, uid, 'pareja', mi_color);
  return esp;
end $$;

-- Invitaciones pendientes para ti: las hechas a tu correo y las de tus amigos (por tu cuenta).
create or replace function public.mis_invitaciones()
returns table (id uuid, espacio_nombre text, de_nombre text, relacion text)
language sql stable security definer set search_path = '' as $$
  select i.id, e.nombre, coalesce(p.nombre, 'Alguien'), i.relacion
  from public.invitaciones i
  join public.espacios e on e.id = i.espacio_id
  left join public.perfiles p on p.id = i.creada_por
  where i.email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
     or i.para_user = (select auth.uid())
  order by i.creada
$$;

-- Acepta una invitación (a tu correo o a tu cuenta). Máximo 5 personas por calendario.
create or replace function public.aceptar_invitacion(p_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  mail text := lower(coalesce((select auth.jwt()) ->> 'email', ''));
  inv public.invitaciones;
  mi_color text;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  select color into mi_color from public.perfiles where id = uid;
  if mi_color is null then raise exception 'Falta tu perfil'; end if;

  select * into inv from public.invitaciones
  where id = p_id and (email = mail or para_user = uid)
  for update;
  if not found then raise exception 'Invitación no válida'; end if;

  if exists (select 1 from public.miembros where espacio_id = inv.espacio_id and user_id = uid) then
    delete from public.invitaciones where id = inv.id;   -- ya estabas dentro
    return inv.espacio_id;
  end if;
  if (select count(*) from public.miembros where espacio_id = inv.espacio_id) >= 5 then
    raise exception 'Este calendario ya tiene 5 personas';
  end if;
  if (select count(*) from public.miembros where user_id = uid) >= 20 then
    raise exception 'Has llegado al máximo de 20 calendarios.';
  end if;

  insert into public.miembros (espacio_id, user_id, relacion, color)
  values (inv.espacio_id, uid, inv.relacion, public.color_libre(inv.espacio_id, mi_color));
  delete from public.invitaciones where id = inv.id;
  return inv.espacio_id;
end $$;

create or replace function public.rechazar_invitacion(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.invitaciones
  where id = p_id and (email = lower(coalesce((select auth.jwt()) ->> 'email', '')) or para_user = (select auth.uid()))
$$;

-- Invitaciones que ha enviado el calendario (solo las ve quien tiene relación "pareja"): al correo o a un amigo.
create or replace function public.invitaciones_enviadas(p_espacio uuid)
returns table (id uuid, destino text, relacion text, creada timestamptz, es_amigo boolean)
language sql stable security definer set search_path = '' as $$
  select i.id, coalesce(i.email, p.nombre::text), i.relacion, i.creada, i.para_user is not null
  from public.invitaciones i
  left join public.perfiles p on p.id = i.para_user
  where i.espacio_id = p_espacio and public.es_pareja(p_espacio)
  order by i.creada
$$;

-- Invita a un AMIGO tuyo a un calendario en el que tienes relación "pareja", con el rol que elijas.
create or replace function public.invitar_amigo(p_espacio uuid, p_amigo uuid, p_relacion text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  nueva uuid;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if not public.es_pareja(p_espacio) then raise exception 'No tienes permiso en este calendario.'; end if;
  if p_relacion not in ('pareja', 'amigo') then raise exception 'Rol no válido.'; end if;
  if not exists (
    select 1 from public.amistades
    where estado = 'aceptada' and ((de = uid and para = p_amigo) or (de = p_amigo and para = uid))
  ) then raise exception 'Solo puedes invitar a tus amigos.'; end if;
  if exists (select 1 from public.miembros where espacio_id = p_espacio and user_id = p_amigo) then
    raise exception 'Ya está en este calendario.';
  end if;
  if (select count(*) from public.miembros where espacio_id = p_espacio) >= 5 then
    raise exception 'Este calendario ya tiene 5 personas.';
  end if;
  begin
    insert into public.invitaciones (espacio_id, para_user, relacion, creada_por)
    values (p_espacio, p_amigo, p_relacion, uid) returning id into nueva;
  exception when unique_violation then
    raise exception 'Ya le invitaste a este calendario.';
  end;
  return nueva;
end $$;

-- Interna: saca a alguien de un calendario. Sus eventos y menús se borran; los eventos "de todos" que creó pasan a quien creó el calendario.
create or replace function public.limpiar_miembro(esp uuid, quien uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare creador uuid := (select creado_por from public.espacios where id = esp);
begin
  if creador is not null then
    update public.eventos set owner_id = creador where espacio_id = esp and owner_id = quien and compartido;
  end if;
  delete from public.eventos where espacio_id = esp and owner_id = quien;
  delete from public.menu where espacio_id = esp and owner_id = quien;
  delete from public.miembros where espacio_id = esp and user_id = quien;
end $$;

create or replace function public.salir_espacio(p_espacio uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if not public.es_miembro(p_espacio) then raise exception 'No estás en ese calendario.'; end if;
  if (select creado_por from public.espacios where id = p_espacio) = uid then
    raise exception 'Creaste este calendario: puedes borrarlo, pero no salir de él.';
  end if;
  perform public.limpiar_miembro(p_espacio, uid);
end $$;

create or replace function public.quitar_miembro(p_espacio uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if not public.es_pareja(p_espacio) then raise exception 'No tienes permiso en este calendario.'; end if;
  if p_user = uid then raise exception 'Para irte usa «Salir del calendario».'; end if;
  if (select creado_por from public.espacios where id = p_espacio) = p_user then
    raise exception 'No se puede quitar a quien creó el calendario.';
  end if;
  if not exists (select 1 from public.miembros where espacio_id = p_espacio and user_id = p_user) then
    raise exception 'Esa persona no está en el calendario.';
  end if;
  perform public.limpiar_miembro(p_espacio, p_user);
end $$;

-- Solo quien creó el calendario puede borrarlo (se borra para todos, con todo lo que contiene).
create or replace function public.eliminar_espacio(p_espacio uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  delete from public.espacios where id = p_espacio and creado_por = uid;
  if not found then raise exception 'Solo quien creó el calendario puede borrarlo.'; end if;
end $$;

create or replace function public.renombrar_espacio(p_espacio uuid, p_nombre text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_pareja(p_espacio) then raise exception 'No tienes permiso en este calendario.'; end if;
  update public.espacios set nombre = left(coalesce(nullif(trim(p_nombre), ''), 'Nuestro calendario'), 80) where id = p_espacio;
end $$;

-- Tu color en UN calendario (y el que se te propondrá en los nuevos).
create or replace function public.cambiar_mi_color(p_espacio uuid, p_color text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if p_color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Color no válido.'; end if;
  update public.miembros set color = p_color where espacio_id = p_espacio and user_id = uid;
  if not found then raise exception 'No estás en ese calendario.'; end if;
  update public.perfiles set color = p_color where id = uid;
end $$;

drop policy if exists invitaciones_crear on public.invitaciones;
create policy invitaciones_crear on public.invitaciones for insert to authenticated
  with check (public.es_pareja(espacio_id) and creada_por = (select auth.uid()) and para_user is null);

revoke all on function
  public.invitaciones_enviadas(uuid), public.invitar_amigo(uuid, uuid, text), public.salir_espacio(uuid),
  public.quitar_miembro(uuid, uuid), public.eliminar_espacio(uuid), public.renombrar_espacio(uuid, text), public.cambiar_mi_color(uuid, text),
  public.color_libre(uuid, text), public.limpiar_miembro(uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.invitaciones_enviadas(uuid), public.invitar_amigo(uuid, uuid, text), public.salir_espacio(uuid),
  public.quitar_miembro(uuid, uuid), public.eliminar_espacio(uuid), public.renombrar_espacio(uuid, text), public.cambiar_mi_color(uuid, text)
  to authenticated;

notify pgrst, 'reload schema';

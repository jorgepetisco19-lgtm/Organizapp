-- =====================================================================
-- Organizapp · estructura de la base de datos y reglas de acceso
--
-- Cómo usarlo: Supabase → SQL Editor → New query → pegar TODO esto → Run.
-- Se puede ejecutar más de una vez sin romper nada.
--
-- Idea de seguridad (lo importante):
--   * Nadie sin sesión (anon) tiene permiso sobre ninguna tabla ni función.
--   * Cada tabla tiene RLS (reglas por fila) activado.
--   * Solo los miembros de un calendario ("espacio") ven sus datos.
--   * Cada persona edita su propia capa. Quien tiene relación "pareja"
--     puede editar además las capas de los demás miembros.
--     Quien tiene relación "amigo" solo ve lo de los demás.
--   * Unirse a un calendario solo se puede con una invitación hecha al
--     correo de tu cuenta de Google.
-- =====================================================================

-- ---------- TABLAS ----------

create table if not exists public.perfiles (
  id      uuid primary key references auth.users(id) on delete cascade,
  nombre  text not null check (char_length(nombre) between 1 and 60),
  color   text not null default '#3b82f6' check (color ~ '^#[0-9a-fA-F]{6}$'),
  creado  timestamptz not null default now()
);

create table if not exists public.espacios (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null default 'Nuestro calendario'
              check (char_length(nombre) between 1 and 80),
  creado_por  uuid references auth.users(id) on delete set null,
  creado      timestamptz not null default now()
);

create table if not exists public.miembros (
  espacio_id  uuid not null references public.espacios(id) on delete cascade,
  user_id     uuid not null references public.perfiles(id) on delete cascade,
  relacion    text not null check (relacion in ('pareja', 'amigo')),
  unido       timestamptz not null default now(),
  primary key (espacio_id, user_id)
);
create index if not exists miembros_user_idx on public.miembros (user_id);

create table if not exists public.invitaciones (
  id          uuid primary key default gen_random_uuid(),
  espacio_id  uuid not null references public.espacios(id) on delete cascade,
  email       text not null check (email = lower(email) and position('@' in email) > 1),
  relacion    text not null check (relacion in ('pareja', 'amigo')),
  creada_por  uuid references auth.users(id) on delete set null,
  creada      timestamptz not null default now(),
  unique (espacio_id, email)
);
create index if not exists invitaciones_email_idx on public.invitaciones (email);

create table if not exists public.eventos (
  id           uuid primary key default gen_random_uuid(),
  espacio_id   uuid not null references public.espacios(id) on delete cascade,
  owner_id     uuid not null references public.perfiles(id) on delete cascade,
  tipo         text not null check (tipo in ('deporte', 'plan', 'tarea', 'compromiso')),
  titulo       text not null check (char_length(titulo) between 1 and 120),
  fecha        date not null,
  hora_inicio  time,
  hora_fin     time,
  notas        text check (char_length(notas) <= 1000),
  repeticion   text check (repeticion in ('semanal')),
  repite_hasta date,
  excepciones  date[] not null default '{}',
  compartido   boolean not null default false,  -- true = es de todos los del calendario (se muestra con un color propio)
  creado_por   uuid references auth.users(id) on delete set null,
  creado       timestamptz not null default now(),
  actualizado  timestamptz not null default now(),
  check (hora_fin is null or hora_inicio is not null),
  check (hora_fin is null or hora_fin >= hora_inicio),
  check (repite_hasta is null or repeticion is not null),
  check (repite_hasta is null or repite_hasta >= fecha)
);
-- Para bases creadas con una versión anterior de este archivo:
alter table public.eventos add column if not exists compartido boolean not null default false;
create index if not exists eventos_espacio_fecha_idx on public.eventos (espacio_id, fecha);

create table if not exists public.menu (
  id           uuid primary key default gen_random_uuid(),
  espacio_id   uuid not null references public.espacios(id) on delete cascade,
  owner_id     uuid not null references public.perfiles(id) on delete cascade,
  fecha        date not null,
  franja       text not null check (franja in ('desayuno', 'media_manana', 'comida', 'merienda', 'cena')),
  hora         time,
  texto        text not null check (char_length(texto) between 1 and 1000),
  actualizado  timestamptz not null default now(),
  unique (espacio_id, owner_id, fecha, franja)
);
create index if not exists menu_espacio_fecha_idx on public.menu (espacio_id, fecha);

-- Mantiene la columna "actualizado"
create or replace function public.tocar_actualizado()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.actualizado := now();
  return new;
end $$;

drop trigger if exists eventos_tocar on public.eventos;
create trigger eventos_tocar before update on public.eventos
  for each row execute function public.tocar_actualizado();

drop trigger if exists menu_tocar on public.menu;
create trigger menu_tocar before update on public.menu
  for each row execute function public.tocar_actualizado();

-- ---------- FUNCIONES AUXILIARES PARA LAS REGLAS ----------
-- Se ejecutan con permisos del propietario para poder mirar "miembros"
-- sin que las propias reglas se llamen a sí mismas en bucle.

create or replace function public.es_miembro(esp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.miembros
    where espacio_id = esp and user_id = (select auth.uid())
  )
$$;

create or replace function public.es_pareja(esp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.miembros
    where espacio_id = esp and user_id = (select auth.uid()) and relacion = 'pareja'
  )
$$;

create or replace function public.comparte_espacio(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.miembros a
    join public.miembros b on b.espacio_id = a.espacio_id
    where a.user_id = (select auth.uid()) and b.user_id = uid
  )
$$;

-- ¿Puede quien llama crear/editar/borrar algo de la capa "owner" en el espacio "esp"?
--  - tiene que ser miembro del espacio
--  - la capa tiene que ser de un miembro del mismo espacio
--  - o es su propia capa, o tiene relación "pareja"
create or replace function public.puede_editar(esp uuid, owner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select
    exists (select 1 from public.miembros
            where espacio_id = esp and user_id = (select auth.uid()))
    and exists (select 1 from public.miembros
                where espacio_id = esp and user_id = owner)
    and (
      owner = (select auth.uid())
      or exists (select 1 from public.miembros
                 where espacio_id = esp and user_id = (select auth.uid()) and relacion = 'pareja')
    )
$$;

-- ---------- FUNCIONES QUE USA LA APP ----------

-- Crea (o recupera) tu perfil la primera vez que entras.
create or replace function public.iniciar_perfil(p_nombre text)
returns public.perfiles language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  fila public.perfiles;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  insert into public.perfiles (id, nombre)
  values (uid, left(coalesce(nullif(trim(p_nombre), ''), 'Yo'), 60))
  on conflict (id) do nothing;
  select * into fila from public.perfiles where id = uid;
  return fila;
end $$;

-- Crea tu calendario y te hace miembro con relación "pareja".
create or replace function public.crear_espacio(p_nombre text default 'Nuestro calendario')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  esp uuid;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if not exists (select 1 from public.perfiles where id = uid) then
    raise exception 'Falta tu perfil';
  end if;
  if exists (select 1 from public.miembros where user_id = uid) then
    raise exception 'Ya perteneces a un calendario';
  end if;
  insert into public.espacios (nombre, creado_por)
  values (left(coalesce(nullif(trim(p_nombre), ''), 'Nuestro calendario'), 80), uid)
  returning id into esp;
  insert into public.miembros (espacio_id, user_id, relacion) values (esp, uid, 'pareja');
  return esp;
end $$;

-- Invitaciones pendientes dirigidas al correo de TU cuenta de Google.
create or replace function public.mis_invitaciones()
returns table (id uuid, espacio_nombre text, de_nombre text, relacion text)
language sql stable security definer set search_path = '' as $$
  select i.id, e.nombre, coalesce(p.nombre, 'Alguien'), i.relacion
  from public.invitaciones i
  join public.espacios e on e.id = i.espacio_id
  left join public.perfiles p on p.id = i.creada_por
  where i.email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
$$;

-- Acepta una invitación hecha a tu correo. Máximo 5 personas por calendario.
create or replace function public.aceptar_invitacion(p_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  mail text := lower(coalesce((select auth.jwt()) ->> 'email', ''));
  inv public.invitaciones;
  paleta text[] := array['#3b82f6','#f97316','#10b981','#a855f7','#ef4444','#eab308','#06b6d4','#ec4899'];
  mi_color text;
  c text;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if not exists (select 1 from public.perfiles where id = uid) then
    raise exception 'Falta tu perfil';
  end if;
  if exists (select 1 from public.miembros where user_id = uid) then
    raise exception 'Ya perteneces a un calendario';
  end if;

  select * into inv from public.invitaciones
  where id = p_id and email = mail
  for update;
  if not found then raise exception 'Invitación no válida'; end if;

  if (select count(*) from public.miembros where espacio_id = inv.espacio_id) >= 5 then
    raise exception 'Este calendario ya tiene 5 personas';
  end if;

  insert into public.miembros (espacio_id, user_id, relacion)
  values (inv.espacio_id, uid, inv.relacion);
  delete from public.invitaciones where id = inv.id;

  -- Si tu color coincide con el de otro miembro, te asigna uno libre.
  select color into mi_color from public.perfiles where id = uid;
  if exists (
    select 1 from public.miembros m join public.perfiles p on p.id = m.user_id
    where m.espacio_id = inv.espacio_id and m.user_id <> uid and p.color = mi_color
  ) then
    foreach c in array paleta loop
      if not exists (
        select 1 from public.miembros m join public.perfiles p on p.id = m.user_id
        where m.espacio_id = inv.espacio_id and p.color = c
      ) then
        update public.perfiles set color = c where id = uid;
        exit;
      end if;
    end loop;
  end if;

  return inv.espacio_id;
end $$;

create or replace function public.rechazar_invitacion(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.invitaciones
  where id = p_id and email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
$$;

-- ---------- REGLAS DE ACCESO (RLS) ----------

alter table public.perfiles      enable row level security;
alter table public.espacios      enable row level security;
alter table public.miembros      enable row level security;
alter table public.invitaciones  enable row level security;
alter table public.eventos       enable row level security;
alter table public.menu          enable row level security;

-- perfiles: ves el tuyo y los de quien comparte calendario contigo; editas solo el tuyo
drop policy if exists perfiles_ver on public.perfiles;
create policy perfiles_ver on public.perfiles for select to authenticated
  using (id = (select auth.uid()) or public.comparte_espacio(id));

drop policy if exists perfiles_editar on public.perfiles;
create policy perfiles_editar on public.perfiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- espacios y miembros: solo los ven sus miembros (se modifican solo con las funciones de arriba)
drop policy if exists espacios_ver on public.espacios;
create policy espacios_ver on public.espacios for select to authenticated
  using (public.es_miembro(id));

drop policy if exists miembros_ver on public.miembros;
create policy miembros_ver on public.miembros for select to authenticated
  using (public.es_miembro(espacio_id));

-- invitaciones: solo las gestiona quien tiene relación "pareja" en ese calendario
drop policy if exists invitaciones_ver on public.invitaciones;
create policy invitaciones_ver on public.invitaciones for select to authenticated
  using (public.es_pareja(espacio_id));

drop policy if exists invitaciones_crear on public.invitaciones;
create policy invitaciones_crear on public.invitaciones for insert to authenticated
  with check (public.es_pareja(espacio_id) and creada_por = (select auth.uid()));

drop policy if exists invitaciones_borrar on public.invitaciones;
create policy invitaciones_borrar on public.invitaciones for delete to authenticated
  using (public.es_pareja(espacio_id));

-- eventos
drop policy if exists eventos_ver on public.eventos;
create policy eventos_ver on public.eventos for select to authenticated
  using (public.es_miembro(espacio_id));

drop policy if exists eventos_crear on public.eventos;
create policy eventos_crear on public.eventos for insert to authenticated
  with check (public.puede_editar(espacio_id, owner_id) and creado_por = (select auth.uid()));

drop policy if exists eventos_editar on public.eventos;
create policy eventos_editar on public.eventos for update to authenticated
  using (public.puede_editar(espacio_id, owner_id))
  with check (public.puede_editar(espacio_id, owner_id));

drop policy if exists eventos_borrar on public.eventos;
create policy eventos_borrar on public.eventos for delete to authenticated
  using (public.puede_editar(espacio_id, owner_id));

-- menú
drop policy if exists menu_ver on public.menu;
create policy menu_ver on public.menu for select to authenticated
  using (public.es_miembro(espacio_id));

drop policy if exists menu_crear on public.menu;
create policy menu_crear on public.menu for insert to authenticated
  with check (public.puede_editar(espacio_id, owner_id));

drop policy if exists menu_editar on public.menu;
create policy menu_editar on public.menu for update to authenticated
  using (public.puede_editar(espacio_id, owner_id))
  with check (public.puede_editar(espacio_id, owner_id));

drop policy if exists menu_borrar on public.menu;
create policy menu_borrar on public.menu for delete to authenticated
  using (public.puede_editar(espacio_id, owner_id));

-- ---------- PERMISOS ----------
-- Primero se quita todo (también a "anon", que es quien no ha iniciado sesión)
-- y luego se da solo lo necesario a "authenticated" (quien ha iniciado sesión).

revoke all on public.perfiles, public.espacios, public.miembros,
              public.invitaciones, public.eventos, public.menu
  from public, anon, authenticated;

grant select on public.espacios, public.miembros to authenticated;
grant select on public.perfiles to authenticated;
grant update (nombre, color) on public.perfiles to authenticated;
grant select, insert, delete on public.invitaciones to authenticated;
grant select, insert, update, delete on public.eventos, public.menu to authenticated;

revoke all on function
  public.es_miembro(uuid), public.es_pareja(uuid), public.comparte_espacio(uuid),
  public.puede_editar(uuid, uuid), public.iniciar_perfil(text), public.crear_espacio(text),
  public.mis_invitaciones(), public.aceptar_invitacion(uuid), public.rechazar_invitacion(uuid),
  public.tocar_actualizado()
  from public, anon, authenticated;

grant execute on function
  public.es_miembro(uuid), public.es_pareja(uuid), public.comparte_espacio(uuid),
  public.puede_editar(uuid, uuid), public.iniciar_perfil(text), public.crear_espacio(text),
  public.mis_invitaciones(), public.aceptar_invitacion(uuid), public.rechazar_invitacion(uuid)
  to authenticated;

-- Avisa a la API de que hay tablas nuevas
notify pgrst, 'reload schema';

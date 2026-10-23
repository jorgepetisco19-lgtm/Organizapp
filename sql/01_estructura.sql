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
--   * Amistades: se piden con el código de amigo exacto y las acepta quien las recibe.
--   * Cada persona puede tener varios calendarios (uno solo para ella, otros con su pareja o amigos).
--   * Unirse a un calendario solo se puede con una invitación: a tu correo de Google o, si sois
--     amigos, a tu cuenta.
-- =====================================================================

-- ---------- TABLAS ----------

create table if not exists public.perfiles (
  id      uuid primary key references auth.users(id) on delete cascade,
  nombre  text not null check (char_length(nombre) between 1 and 60),
  color   text not null default '#3b82f6' check (color ~ '^#[0-9a-fA-F]{6}$'),
  creado  timestamptz not null default now(),
  codigo_amigo text
);
-- Para bases creadas con una versión anterior (cambio 3):
alter table public.perfiles add column if not exists codigo_amigo text;

-- Código de amigo: 8 caracteres al azar sin letras confusas (sin 0/O/1/I/L). Se muestra como XXXX-XXXX.
create or replace function public.generar_codigo()
returns text language plpgsql volatile set search_path = '' as $$
declare
  alfabeto constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  b bytea;
  c text;
  i int;
begin
  loop
    b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    c := '';
    for i in 0..7 loop
      c := c || substr(alfabeto, (get_byte(b, i) % 31) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.perfiles where codigo_amigo = c);
  end loop;
  return c;
end $$;

alter table public.perfiles alter column codigo_amigo set default public.generar_codigo();
update public.perfiles set codigo_amigo = public.generar_codigo() where codigo_amigo is null;
alter table public.perfiles alter column codigo_amigo set not null;
create unique index if not exists perfiles_codigo_idx on public.perfiles (codigo_amigo);

-- Amistades: quien tiene tu código puede pedirte amistad; tú aceptas o no.
-- Nadie lee ni escribe esta tabla directamente: solo las funciones de abajo.
create table if not exists public.amistades (
  id      uuid primary key default gen_random_uuid(),
  de      uuid not null references public.perfiles(id) on delete cascade,
  para    uuid not null references public.perfiles(id) on delete cascade,
  estado  text not null default 'pendiente' check (estado in ('pendiente', 'aceptada')),
  creada  timestamptz not null default now(),
  check (de <> para)
);
create unique index if not exists amistades_par_idx on public.amistades (least(de, para), greatest(de, para));
create index if not exists amistades_para_idx on public.amistades (para);

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
  color       text not null default '#3b82f6' check (color ~ '^#[0-9a-fA-F]{6}$'),  -- color de esta persona EN este calendario
  primary key (espacio_id, user_id)
);
create index if not exists miembros_user_idx on public.miembros (user_id);

create table if not exists public.invitaciones (
  id          uuid primary key default gen_random_uuid(),
  espacio_id  uuid not null references public.espacios(id) on delete cascade,
  email       text check (email = lower(email) and position('@' in email) > 1),   -- invitación a un correo...
  para_user   uuid references public.perfiles(id) on delete cascade,                -- ...o a un amigo (por su cuenta)
  relacion    text not null check (relacion in ('pareja', 'amigo')),
  creada_por  uuid references auth.users(id) on delete set null,
  creada      timestamptz not null default now(),
  unique (espacio_id, email),
  check ((email is not null and para_user is null) or (email is null and para_user is not null))
);
create index if not exists invitaciones_email_idx on public.invitaciones (email);
-- Para bases creadas con una versión anterior (cambio 4):
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
  hechas       date[] not null default '{}',  -- días en que la tarea está hecha (una tarea que se repite se marca día a día)
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
alter table public.eventos add column if not exists hechas date[] not null default '{}';
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

-- Solo quien creó el calendario puede cambiar el rol de los demás (nunca el suyo).
create or replace function public.cambiar_rol(p_espacio uuid, p_user uuid, p_relacion text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if p_relacion not in ('pareja', 'amigo') then raise exception 'Rol no válido.'; end if;
  if (select creado_por from public.espacios where id = p_espacio) is distinct from uid then
    raise exception 'Solo quien creó el calendario puede cambiar roles.';
  end if;
  if p_user = uid then raise exception 'Quien creó el calendario siempre es pareja.'; end if;
  update public.miembros set relacion = p_relacion where espacio_id = p_espacio and user_id = p_user;
  if not found then raise exception 'Esa persona no está en el calendario.'; end if;
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

-- ---------- AMIGOS (código de amigo y solicitudes) ----------

create or replace function public.normalizar_codigo(t text)
returns text language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Busca a alguien por su código EXACTO. Devuelve solo su nombre y en qué punto está vuestra relación.
create or replace function public.buscar_codigo(p_codigo text)
returns table (id uuid, nombre text, estado text)
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  otro public.perfiles;
  a public.amistades;
  est text;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if length(public.normalizar_codigo(p_codigo)) <> 8 then return; end if;
  select * into otro from public.perfiles where codigo_amigo = public.normalizar_codigo(p_codigo);
  if not found then return; end if;
  if otro.id = uid then raise exception 'Ese es tu propio código.'; end if;
  select * into a from public.amistades
    where (de = uid and para = otro.id) or (de = otro.id and para = uid);
  if not found then est := 'nuevo';
  elsif a.estado = 'aceptada' then est := 'amigos';
  elsif a.de = uid then est := 'enviada';
  else est := 'recibida';
  end if;
  return query select otro.id, otro.nombre::text, est;
end $$;

-- Envía una solicitud de amistad al dueño del código. Si esa persona ya te la había enviado a ti, se aceptan.
create or replace function public.pedir_amistad(p_codigo text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  otro uuid;
  a public.amistades;
  nueva uuid;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  select id into otro from public.perfiles where codigo_amigo = public.normalizar_codigo(p_codigo);
  if otro is null then raise exception 'No hay nadie con ese código.'; end if;
  if otro = uid then raise exception 'Ese es tu propio código.'; end if;
  select * into a from public.amistades
    where (de = uid and para = otro) or (de = otro and para = uid);
  if found then
    if a.estado = 'aceptada' then raise exception 'Ya sois amigos.'; end if;
    if a.de = uid then raise exception 'Ya le enviaste una solicitud.'; end if;
    update public.amistades set estado = 'aceptada' where id = a.id;
    return a.id;
  end if;
  if (select count(*) from public.amistades where de = uid and estado = 'pendiente') >= 20 then
    raise exception 'Tienes demasiadas solicitudes pendientes.';
  end if;
  insert into public.amistades (de, para) values (uid, otro) returning id into nueva;
  return nueva;
end $$;

-- Solo quien RECIBE la solicitud puede aceptarla o rechazarla.
create or replace function public.responder_amistad(p_id uuid, p_aceptar boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if not exists (select 1 from public.amistades where id = p_id and para = uid and estado = 'pendiente') then
    raise exception 'Esa solicitud ya no existe.';
  end if;
  if p_aceptar then update public.amistades set estado = 'aceptada' where id = p_id;
  else delete from public.amistades where id = p_id;
  end if;
end $$;

-- Cancela una solicitud enviada o quita a un amigo (cualquiera de los dos puede).
create or replace function public.quitar_amistad(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.amistades
  where id = p_id and ((select auth.uid()) in (de, para))
$$;

create or replace function public.mis_amistades()
returns table (id uuid, otro_id uuid, nombre text, estado text, direccion text, creada timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.id, p.id, p.nombre::text, a.estado,
         case when a.de = (select auth.uid()) then 'enviada' else 'recibida' end, a.creada
  from public.amistades a
  join public.perfiles p on p.id = case when a.de = (select auth.uid()) then a.para else a.de end
  where (select auth.uid()) in (a.de, a.para)
  order by a.creada
$$;

-- Cambia tu código por otro nuevo (por si lo has compartido con quien no querías). Las amistades siguen igual.
create or replace function public.regenerar_codigo()
returns text language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  nuevo text := public.generar_codigo();
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  update public.perfiles set codigo_amigo = nuevo where id = uid;
  return nuevo;
end $$;

-- ---------- REGLAS DE ACCESO (RLS) ----------

alter table public.perfiles      enable row level security;
alter table public.espacios      enable row level security;
alter table public.miembros      enable row level security;
alter table public.invitaciones  enable row level security;
alter table public.eventos       enable row level security;
alter table public.menu          enable row level security;
alter table public.amistades    enable row level security;  -- sin políticas: solo se usa a través de las funciones

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
  with check (public.es_pareja(espacio_id) and creada_por = (select auth.uid()) and para_user is null);

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

-- ---------- LÍNEAS: pasos de una tarea y lista de la compra ----------
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

-- ---------- PERMISOS ----------
-- Primero se quita todo (también a "anon", que es quien no ha iniciado sesión)
-- y luego se da solo lo necesario a "authenticated" (quien ha iniciado sesión).

revoke all on public.perfiles, public.espacios, public.miembros,
              public.invitaciones, public.eventos, public.menu, public.amistades, public.lineas
  from public, anon, authenticated;

grant select on public.espacios, public.miembros to authenticated;
-- (el código de amigo no se puede leer con select: cada cual lo recibe de iniciar_perfil)
grant select (id, nombre, color, creado) on public.perfiles to authenticated;
grant update (nombre, color) on public.perfiles to authenticated;
grant select, insert, delete on public.invitaciones to authenticated;
grant select, insert, update, delete on public.eventos, public.menu to authenticated;
grant select, insert, delete on public.lineas to authenticated;
grant update (texto, hecha, orden) on public.lineas to authenticated;

-- Borra TU cuenta y todo lo tuyo. Solo puede llamarla la propia persona (borra la cuenta de quien llama, nunca otra).
--  - Calendarios que creaste y nadie más usa: se borran enteros.
--  - Calendarios que creaste y comparten otras personas: pasan a ser de otra persona con rol «pareja»
--    (sus eventos «de todos» se quedan ahí). Si no hay nadie con ese rol, no se borra nada y se avisa.
--  - En los demás calendarios: se borran tus eventos y menús y sales de ellos.
--  - Se borran tus invitaciones enviadas, las que tenías pendientes, tus amistades y tu perfil.
create or replace function public.borrar_mi_cuenta()
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid    uuid := (select auth.uid());
  correo text;
  r      record;
  nuevo  uuid;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;

  for r in select id, nombre from public.espacios where creado_por = uid loop
    if not exists (select 1 from public.miembros where espacio_id = r.id and user_id <> uid) then
      delete from public.espacios where id = r.id;
    else
      select user_id into nuevo from public.miembros
        where espacio_id = r.id and user_id <> uid and relacion = 'pareja' order by unido, user_id limit 1;
      if nuevo is null then
        raise exception 'Creaste «%» y lo comparten otras personas, pero ninguna tiene el rol «pareja». Pon a alguien como «pareja» (Más → Personas) o borra ese calendario, y vuelve a intentarlo.', r.nombre;
      end if;
      update public.espacios set creado_por = nuevo where id = r.id;
    end if;
  end loop;

  for r in select espacio_id from public.miembros where user_id = uid loop
    perform public.limpiar_miembro(r.espacio_id, uid);
  end loop;

  select lower(email) into correo from auth.users where id = uid;
  delete from public.invitaciones where creada_por = uid or (correo is not null and email = correo);

  delete from auth.users where id = uid;   -- arrastra perfil, amistades y todo lo que cuelga de él
end $$;

revoke all on function
  public.es_miembro(uuid), public.es_pareja(uuid), public.comparte_espacio(uuid),
  public.puede_editar(uuid, uuid), public.iniciar_perfil(text), public.crear_espacio(text),
  public.mis_invitaciones(), public.aceptar_invitacion(uuid), public.rechazar_invitacion(uuid),
  public.tocar_actualizado(),
  public.invitaciones_enviadas(uuid), public.invitar_amigo(uuid, uuid, text), public.salir_espacio(uuid),
  public.quitar_miembro(uuid, uuid), public.eliminar_espacio(uuid), public.renombrar_espacio(uuid, text), public.cambiar_mi_color(uuid, text), public.cambiar_rol(uuid, uuid, text),
  public.color_libre(uuid, text), public.limpiar_miembro(uuid, uuid), public.puede_editar_linea(uuid, uuid), public.limitar_lineas(), public.borrar_mi_cuenta(),
  public.buscar_codigo(text), public.pedir_amistad(text), public.responder_amistad(uuid, boolean),
  public.quitar_amistad(uuid), public.mis_amistades(), public.regenerar_codigo(), public.normalizar_codigo(text), public.generar_codigo()
  from public, anon, authenticated;

grant execute on function
  public.es_miembro(uuid), public.es_pareja(uuid), public.comparte_espacio(uuid),
  public.puede_editar(uuid, uuid), public.iniciar_perfil(text), public.crear_espacio(text),
  public.mis_invitaciones(), public.aceptar_invitacion(uuid), public.rechazar_invitacion(uuid),
  public.buscar_codigo(text), public.pedir_amistad(text), public.responder_amistad(uuid, boolean),
  public.quitar_amistad(uuid), public.mis_amistades(), public.regenerar_codigo(),
  public.invitaciones_enviadas(uuid), public.invitar_amigo(uuid, uuid, text), public.salir_espacio(uuid),
  public.quitar_miembro(uuid, uuid), public.eliminar_espacio(uuid), public.renombrar_espacio(uuid, text), public.cambiar_mi_color(uuid, text), public.cambiar_rol(uuid, uuid, text),
  public.puede_editar_linea(uuid, uuid), public.borrar_mi_cuenta()
  to authenticated;

-- Avisa a la API de que hay tablas nuevas
notify pgrst, 'reload schema';

-- Organizapp · cambio 3: código de amigo y solicitudes de amistad
-- Cómo usarlo: Supabase → SQL Editor → New query → pegar TODO esto → Run. Se puede ejecutar más de una vez.
-- Qué hace: añade a cada persona un código de amigo, una tabla de amistades (que nadie toca directamente)
-- y las funciones para buscar por código exacto, pedir amistad, aceptar, rechazar y quitar.
-- Además cierra la lectura de la tabla de perfiles a las columnas necesarias (el código no se ve en ella).

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

alter table public.amistades    enable row level security;  -- sin políticas: solo se usa a través de las funciones

revoke all on public.amistades from public, anon, authenticated;
revoke select on public.perfiles from authenticated;
grant select (id, nombre, color, creado) on public.perfiles to authenticated;

revoke all on function
  public.buscar_codigo(text), public.pedir_amistad(text), public.responder_amistad(uuid, boolean),
  public.quitar_amistad(uuid), public.mis_amistades(), public.regenerar_codigo(), public.normalizar_codigo(text), public.generar_codigo()
  from public, anon, authenticated;
grant execute on function
  public.buscar_codigo(text), public.pedir_amistad(text), public.responder_amistad(uuid, boolean),
  public.quitar_amistad(uuid), public.mis_amistades(), public.regenerar_codigo()
  to authenticated;
-- iniciar_perfil devuelve tu fila completa (con tu código); ya tenía permiso.

notify pgrst, 'reload schema';

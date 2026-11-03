-- Organizapp · SQL 13: aviso en el móvil cuando OTRA persona crea o cambia un evento en el que estás
-- (uno tuyo, uno «de todos» o uno de un grupo que te incluye). Tú no recibes aviso de lo que haces tú.
-- Pégalo entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez sin problema.
--
-- Qué hace: guarda el «token» de cada móvil (lo manda la app) y, cuando alguien guarda un evento, avisa a la función
-- «notificar» de Supabase (que habla con Firebase) para que llegue la notificación. Si algo de eso no está configurado,
-- guardar eventos funciona igual: el aviso simplemente no sale (nunca bloquea un guardado).
-- Hasta que no crees el proyecto de Firebase y la función (pasos en la guía), este SQL no hace nada visible.

-- Para enviar avisos a la función. En Supabase suele venir ya activada; si no, esto la activa.
do $$ begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'No se pudo activar pg_net aquí: actívala en Database → Extensions (pg_net).';
end $$;

-- ---------- móviles que reciben avisos ----------
create table if not exists public.dispositivos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.perfiles(id) on delete cascade,
  token       text not null unique check (char_length(token) between 20 and 4096),
  actualizado timestamptz not null default now()
);
create index if not exists dispositivos_user_idx on public.dispositivos (user_id);
alter table public.dispositivos enable row level security;
-- Sin reglas y sin permisos: nadie lee ni toca esta tabla desde la app; solo las dos funciones de abajo (cada una con lo suyo).
revoke all on public.dispositivos from anon, authenticated;

-- La app registra aquí el móvil de quien ha entrado. Si el mismo móvil lo usa otra cuenta, pasa a esa. Máximo 8 móviles por persona.
create or replace function public.registrar_dispositivo(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if p_token is null or char_length(p_token) not between 20 and 4096 then raise exception 'Código de móvil no válido'; end if;
  insert into public.dispositivos (user_id, token) values (uid, p_token)
  on conflict (token) do update set user_id = excluded.user_id, actualizado = now();
  delete from public.dispositivos where user_id = uid and id in (
    select id from public.dispositivos where user_id = uid order by actualizado desc, id offset 8);
end $$;

-- Quita este móvil de los avisos (al cerrar sesión o desactivar los avisos). Solo puede quitar los suyos.
create or replace function public.quitar_dispositivo(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  delete from public.dispositivos where token = p_token and user_id = uid;
end $$;

-- ---------- quién está en un evento ----------
-- «De todos»: las personas del calendario. De un grupo: las del grupo. Si no: su dueño. Siempre solo gente que sigue en el calendario.
create or replace function public.destinatarios_evento(esp uuid, compartido boolean, participantes uuid[], owner uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.user_id from public.miembros m
  where m.espacio_id = esp
    and case when compartido then true
             when participantes is not null then m.user_id = any (participantes)
             else m.user_id = owner end
$$;

create or replace function public.fecha_corta_es(d date)
returns text language sql immutable set search_path = '' as $$
  select (array['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'])[extract(isodow from d)::int] || ' ' || to_char(d, 'DD/MM')
$$;

-- ---------- envío ----------
-- Manda los avisos a la función «notificar» (uno por móvil registrado). Solo lo intenta si algún destinatario tiene un móvil y
-- existe la clave compartida «avisos_secret» (Vault). Cualquier fallo se ignora: un aviso perdido no puede romper un guardado.
create or replace function public.empujar_avisos(p_mensajes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare clave text; envio jsonb;
begin
  if p_mensajes is null or jsonb_typeof(p_mensajes) <> 'array' or jsonb_array_length(p_mensajes) = 0 then return; end if;
  -- un envío por cada móvil registrado de cada destinatario (la función no necesita acceso a la base de datos)
  select jsonb_agg(jsonb_build_object('token', d.token, 'titulo', m ->> 'titulo', 'cuerpo', m ->> 'cuerpo'))
    into envio
  from jsonb_array_elements(p_mensajes) m
  join public.dispositivos d on d.user_id = (m ->> 'user_id')::uuid;
  if envio is null then return; end if;
  select decrypted_secret into clave from vault.decrypted_secrets where name = 'avisos_secret' limit 1;
  if clave is null or clave = '' then return; end if;
  perform net.http_post(
    url := 'https://qyvipsdbytpcedlovotk.supabase.co/functions/v1/notificar',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-avisos-secret', clave),
    body := jsonb_build_object('avisos', envio));
exception when others then
  null;
end $$;

-- «Probar»: manda un aviso de prueba a TUS móviles registrados y dice qué ha pasado (para comprobar que todo está bien configurado).
create or replace function public.probar_aviso()
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); clave text; envio jsonb;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  select jsonb_agg(jsonb_build_object('token', token, 'titulo', '🔔 Organizapp', 'cuerpo', 'Así te avisaré cuando otra persona cree o cambie un evento tuyo.'))
    into envio from public.dispositivos where user_id = uid;
  if envio is null then return 'sin_movil'; end if;
  select decrypted_secret into clave from vault.decrypted_secrets where name = 'avisos_secret' limit 1;
  if clave is null or clave = '' then return 'sin_clave'; end if;
  perform net.http_post(
    url := 'https://qyvipsdbytpcedlovotk.supabase.co/functions/v1/notificar',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-avisos-secret', clave),
    body := jsonb_build_object('avisos', envio));
  return 'enviado';
exception when others then
  return 'error';
end $$;

-- Eventos nuevos: un mensaje por persona (si en un mismo guardado llegan varios, uno solo con el resumen).
-- Los cambios que hacen otras funciones por dentro (copias vinculadas…) no avisan: ya avisó el cambio original.
create or replace function public.avisar_eventos_nuevos()
returns trigger language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); quien text; msgs jsonb;
begin
  if actor is null or pg_trigger_depth() > 1 then return null; end if;
  select coalesce(nullif(left(nombre, 40), ''), 'Alguien') into quien from public.perfiles where id = actor;
  with d as (
    select e.id, e.espacio_id, e.titulo, e.fecha, e.hora_inicio, u.u as persona
    from nuevos e
    cross join lateral public.destinatarios_evento(e.espacio_id, e.compartido, e.participantes, e.owner_id) as u(u)
    where u.u <> actor
  ), g as (
    select persona, count(*) as n, (array_agg(espacio_id))[1] as espacio_id,
           (array_agg(titulo order by fecha, hora_inicio nulls last))[1:3] as titulos,
           (array_agg(public.fecha_corta_es(fecha) || coalesce(' ' || to_char(hora_inicio, 'HH24:MI'), '') order by fecha, hora_inicio nulls last))[1] as cuando
    from d group by persona
  )
  select jsonb_agg(jsonb_build_object(
      'user_id', g.persona,
      'titulo', coalesce(quien, 'Alguien') || ' añadió ' || case when g.n = 1 then 'un evento' else g.n || ' eventos' end || ' · ' || s.nombre,
      'cuerpo', case when g.n = 1 then g.titulos[1] || ' · ' || g.cuando
                     else array_to_string(g.titulos, ', ') || case when g.n > 3 then ' y ' || (g.n - 3) || ' más' else '' end end))
  into msgs
  from g join public.espacios s on s.id = g.espacio_id;
  perform public.empujar_avisos(msgs);
  return null;
exception when others then
  return null;
end $$;

-- Eventos cambiados: avisa si cambia el día, la hora, el título, el tipo, las notas, la repetición o los días quitados,
-- o si te añaden al evento. Marcar una tarea como hecha no avisa.
create or replace function public.avisar_eventos_cambiados()
returns trigger language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); quien text; msgs jsonb;
begin
  if actor is null or pg_trigger_depth() > 1 then return null; end if;
  select coalesce(nullif(left(nombre, 40), ''), 'Alguien') into quien from public.perfiles where id = actor;
  with c as (
    select n.id, n.espacio_id, n.titulo, n.fecha, n.hora_inicio, n.compartido, n.participantes, n.owner_id,
           o.compartido as o_compartido, o.participantes as o_participantes, o.owner_id as o_owner,
           concat_ws(', ',
             case when o.fecha is distinct from n.fecha then 'el día' end,
             case when o.hora_inicio is distinct from n.hora_inicio or o.hora_fin is distinct from n.hora_fin or o.dias_extra is distinct from n.dias_extra then 'la hora' end,
             case when o.titulo is distinct from n.titulo then 'el título' end,
             case when o.tipo is distinct from n.tipo then 'el tipo' end,
             case when o.notas is distinct from n.notas then 'las notas' end,
             case when o.repeticion is distinct from n.repeticion or o.repite_hasta is distinct from n.repite_hasta or o.dias_semana is distinct from n.dias_semana then 'la repetición' end,
             case when o.excepciones is distinct from n.excepciones then 'los días' end) as cambios
    from nuevos n join viejos o on o.id = n.id
  ), d as (
    select c.*, u.u as persona,
           u.u not in (select x from public.destinatarios_evento(c.espacio_id, c.o_compartido, c.o_participantes, c.o_owner) x) as entra
    from c
    cross join lateral public.destinatarios_evento(c.espacio_id, c.compartido, c.participantes, c.owner_id) as u(u)
    where u.u <> actor
  ), f as (
    select * from d where cambios <> '' or entra
  ), g as (
    select persona, count(*) as n, (array_agg(espacio_id))[1] as espacio_id, bool_and(entra) as todos_entra,
           (array_agg(titulo order by fecha, hora_inicio nulls last))[1:3] as titulos,
           (array_agg(public.fecha_corta_es(fecha) || coalesce(' ' || to_char(hora_inicio, 'HH24:MI'), '') order by fecha, hora_inicio nulls last))[1] as cuando,
           (array_agg(cambios order by fecha, hora_inicio nulls last))[1] as cambios,
           (array_agg(entra order by fecha, hora_inicio nulls last))[1] as entra
    from f group by persona
  )
  select jsonb_agg(jsonb_build_object(
      'user_id', g.persona,
      'titulo', coalesce(quien, 'Alguien') || case
                  when g.n = 1 and g.entra then ' te añadió a un evento'
                  when g.n = 1 then ' cambió un evento'
                  when g.todos_entra then ' te añadió a ' || g.n || ' eventos'
                  else ' hizo cambios en ' || g.n || ' eventos' end || ' · ' || s.nombre,
      'cuerpo', case when g.n = 1 then g.titulos[1] || ' · ' || g.cuando || case when g.entra or g.cambios = '' then '' else ' · Cambió ' || g.cambios end
                     else array_to_string(g.titulos, ', ') || case when g.n > 3 then ' y ' || (g.n - 3) || ' más' else '' end end))
  into msgs
  from g join public.espacios s on s.id = g.espacio_id;
  perform public.empujar_avisos(msgs);
  return null;
exception when others then
  return null;
end $$;

drop trigger if exists eventos_avisar_nuevos on public.eventos;
create trigger eventos_avisar_nuevos after insert on public.eventos
  referencing new table as nuevos for each statement execute function public.avisar_eventos_nuevos();
drop trigger if exists eventos_avisar_cambiados on public.eventos;
create trigger eventos_avisar_cambiados after update on public.eventos
  referencing old table as viejos new table as nuevos for each statement execute function public.avisar_eventos_cambiados();

revoke all on function public.registrar_dispositivo(text), public.quitar_dispositivo(text), public.probar_aviso(), public.destinatarios_evento(uuid, boolean, uuid[], uuid),
  public.fecha_corta_es(date), public.empujar_avisos(jsonb), public.avisar_eventos_nuevos(), public.avisar_eventos_cambiados()
  from public, anon, authenticated;
grant execute on function public.registrar_dispositivo(text), public.quitar_dispositivo(text), public.probar_aviso() to authenticated;

notify pgrst, 'reload schema';

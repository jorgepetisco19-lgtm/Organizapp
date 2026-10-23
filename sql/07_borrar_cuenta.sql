-- Organizapp · SQL 07: botón «Borrar mi cuenta y mis datos». Pégalo entero en Supabase → SQL Editor → Run. Se puede repetir sin problema.

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

revoke all on function public.borrar_mi_cuenta() from public, anon, authenticated;
grant execute on function public.borrar_mi_cuenta() to authenticated;

notify pgrst, 'reload schema';

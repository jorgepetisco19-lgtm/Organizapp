-- Organizapp · SQL 05: quien creó un calendario puede cambiar el rol de las demás personas que ya están dentro.
-- Pégalo entero en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez sin problema.
-- Reglas: solo quien creó el calendario; no puede cambiar su propio rol (siempre es «pareja»); el rol es 'pareja' o 'amigo'.
-- Cambiar el rol NO borra nada: los eventos de esa persona se quedan como estaban.

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

revoke all on function public.cambiar_rol(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cambiar_rol(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';

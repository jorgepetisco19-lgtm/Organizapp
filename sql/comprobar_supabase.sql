-- Organizapp · comprobación (solo LEE, no cambia nada). Pégalo en Supabase → SQL Editor → Run.
-- Debe salir una tabla con todas las filas en «true». Si alguna sale en «false», cópiamela entera.
-- (Las filas 13 a 17 solo valen si ya has ejecutado los SQL 12 y 13 y has seguido la guía de avisos.)
select comprobacion, ok from (
  select 1 n, 'eventos tiene la columna «hechas» (tareas hechas)' comprobacion,
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'eventos' and column_name = 'hechas') ok
  union all select 2, 'existe la tabla «lineas» (pasos y lista de la compra)', to_regclass('public.lineas') is not null
  union all select 3, 'TODAS las tablas de public tienen las reglas de acceso (RLS) activadas',
    not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity)
  union all select 4, 'lineas tiene sus 4 reglas (ver, crear, editar, borrar)',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'lineas') = 4
  union all select 5, 'lineas solo deja editar texto, hecha y orden',
    coalesce((select string_agg(column_name::text, ',' order by column_name) from information_schema.column_privileges
              where table_schema = 'public' and table_name = 'lineas' and grantee = 'authenticated' and privilege_type = 'UPDATE'), '') = 'hecha,orden,texto'
  union all select 6, 'lineas tiene el límite de 300 líneas / 100 pasos',
    exists (select 1 from pg_trigger where tgrelid = 'public.lineas'::regclass and tgname = 'lineas_limite' and not tgisinternal)
  union all select 7, 'existen las funciones de la app (borrar_mi_cuenta, cambiar_rol, puede_editar_linea, salir_espacio, eliminar_espacio, limpiar_miembro)',
    (select count(distinct proname) from pg_proc where pronamespace = 'public'::regnamespace
       and proname in ('borrar_mi_cuenta', 'cambiar_rol', 'puede_editar_linea', 'salir_espacio', 'eliminar_espacio', 'limpiar_miembro')) = 6
  union all select 8, 'borrar_mi_cuenta: la pueden ejecutar los usuarios con sesión y NO los anónimos',
    has_function_privilege('authenticated', 'public.borrar_mi_cuenta()', 'execute') and not has_function_privilege('anon', 'public.borrar_mi_cuenta()', 'execute')
  union all select 9, 'ninguna función nuestra de public es ejecutable sin haber iniciado sesión (se excluye rls_auto_enable, de Supabase)',
    not exists (select 1 from information_schema.routine_privileges where routine_schema = 'public' and grantee in ('anon', 'PUBLIC') and routine_name <> 'rls_auto_enable')
  union all select 10, 'los anónimos no tienen ningún permiso sobre las tablas de public',
    not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon')
  union all select 11, 'ningún calendario se ha quedado sin creador',
    not exists (select 1 from public.espacios where creado_por is null)
  union all select 12, 'todo calendario tiene al menos una persona con rol «pareja»',
    not exists (select 1 from public.espacios e where not exists (select 1 from public.miembros m where m.espacio_id = e.id and m.relacion = 'pareja'))
  union all select 13, 'copias vinculadas: eventos tiene «grupo_copia» y su disparador (SQL 12)',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'eventos' and column_name = 'grupo_copia')
    and exists (select 1 from pg_trigger where tgrelid = 'public.eventos'::regclass and tgname = 'eventos_sincronizar' and not tgisinternal)
  union all select 14, 'avisos del móvil: existe «dispositivos» y nadie puede leerla desde la app (SQL 13)',
    to_regclass('public.dispositivos') is not null
    and not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'dispositivos' and grantee in ('anon', 'authenticated'))
  union all select 15, 'avisos del móvil: están los disparadores de eventos nuevos y cambiados (SQL 13)',
    (select count(*) from pg_trigger where tgrelid = 'public.eventos'::regclass and tgname in ('eventos_avisar_nuevos', 'eventos_avisar_cambiados') and not tgisinternal) = 2
  union all select 16, 'avisos del móvil: la extensión pg_net está activada (Database → Extensions)',
    exists (select 1 from pg_extension where extname = 'pg_net')
  union all select 17, 'avisos del móvil: existe la clave «avisos_secret» en Vault (paso de la guía; sale false hasta que la crees)',
    exists (select 1 from vault.decrypted_secrets where name = 'avisos_secret')
) t order by n;

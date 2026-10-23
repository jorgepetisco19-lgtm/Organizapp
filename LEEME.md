# Organizapp

Calendario compartido para dos (menú, deporte, planes y tareas). App web instalable (PWA), sin servidor propio: GitHub Pages + Supabase.

## Despliegue
1. Supabase → SQL Editor → pega `sql/01_estructura.sql` → Run (se puede repetir sin problema).
2. Sube los archivos al repositorio (GitHub Desktop → Commit → Push).
3. Settings → Pages → Deploy from branch `main` / root.
4. En cada cambio: subir el número `VERSION` de `sw.js` (lo hace Claude).

## Pruebas (opcionales, para quien desarrolla)
- `node --test tests/util.test.mjs` — funciones de fechas, repetición e importación.
- `tests/rls_test.mjs` — 79 pruebas de las reglas de acceso en un Postgres real (necesita `npm i @electric-sql/pglite`).
- `python3 tests/e2e/recorrido.py` y `tests/e2e/service_worker.py` — navegador real (Playwright) con un Supabase falso.

## Importante
- `importar/` no se sube a GitHub (el repositorio es público): ahí va tu CSV real del menú.
- `js/config.js` solo lleva la clave *publishable* (pública por diseño). Nunca pongas aquí la clave secret/service_role.

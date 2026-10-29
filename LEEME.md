# Organizapp

Calendario compartido para dos (menú, deporte, planes y tareas). App web instalable (PWA), sin servidor propio: GitHub Pages + Supabase.

## Despliegue
1. Supabase → SQL Editor → pega `sql/01_estructura.sql` → Run (se puede repetir sin problema).
2. Sube los archivos al repositorio (GitHub Desktop → Commit → Push).
3. Settings → Pages → Deploy from branch `main` / root.
4. En cada cambio: subir el número `VERSION` de `sw.js` (lo hace Claude).

## App de Android (APK) con avisos
La misma web, empaquetada con Capacitor, para instalarla como app de verdad y recibir avisos antes de los eventos. La APK **no se compila en tu ordenador**: la construye GitHub.
1. Una sola vez: Supabase → Authentication → URL Configuration → Redirect URLs → añade `io.github.jorgepetisco19lgtm.organizapp://auth` → Save.
2. Mueve `android-nativo\android.yml` a `.github\workflows\android.yml` (crea esas dos carpetas en el Explorador; Claude no puede escribir ahí). Después sube los archivos con GitHub Desktop (Commit + Push), como siempre.
3. GitHub → repositorio → pestaña **Actions** → «Construir APK» → **Run workflow** → Run workflow. Tarda 6-10 minutos.
4. Al acabar, en el repositorio → **Releases** → la última → descarga `organizapp.apk` (o abre `https://github.com/jorgepetisco19-lgtm/Organizapp/releases/latest/download/organizapp.apk` en el móvil).
5. Ábrela en el móvil, permite «instalar apps de esta fuente» si lo pide, y pulsa Instalar.
- Cada cambio de la app (VERSION nueva) necesita una APK nueva (repite 3-5; se instala encima sin perder nada). La app avisa en Más → La app cuando hay una más nueva.
- La APK se firma con `android-nativo/firma/organizapp-instalacion.jks`, una firma **pública solo para instalar a mano** (no sirve para Google Play: allí se firma con otra, privada).
- `android-nativo/preparar.py` retoca el proyecto Android; `js/nativo.js` y `js/avisos.js` son la parte nativa. `www/` y `android/` los crea el workflow y no se suben.

## Pruebas (opcionales, para quien desarrolla)
- `node --test tests/util.test.mjs` — funciones de fechas, repetición e importación.
- `tests/rls_test.mjs` — 79 pruebas de las reglas de acceso en un Postgres real (necesita `npm i @electric-sql/pglite`).
- `node --test tests/avisos.test.mjs` — qué avisos toca programar (los de la app de Android).
- `python3 tests/e2e/recorrido.py`, `tests/e2e/service_worker.py` y `tests/e2e/nativo.py` — navegador real (Playwright) con un Supabase falso; `nativo.py` usa el puente real de Capacitor con un Android simulado (necesita red para `npm ci`).

## Importante
- `importar/` no se sube a GitHub (el repositorio es público): ahí va tu CSV real del menú.
- `js/config.js` solo lleva la clave *publishable* (pública por diseño). Nunca pongas aquí la clave secret/service_role.

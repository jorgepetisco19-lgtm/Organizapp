#!/usr/bin/env python3
"""Prepara la app de Android de Organizapp. Lo ejecuta el workflow de GitHub (.github/workflows/android.yml).

  python3 android-nativo/preparar.py web      -> crea www/ con la web y los componentes nativos de Capacitor (antes de «cap add android»)
  python3 android-nativo/preparar.py android  -> retoca el proyecto android/ recién creado (después de «cap add android»)

No hace falta ejecutarlo a mano: solo lo usa el workflow. Falla con un mensaje claro si algo de la plantilla de Capacitor ha cambiado,
para no generar una APK a medias.
"""
import json
import pathlib
import re
import shutil
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
WWW = RAIZ / 'www'
ANDROID = RAIZ / 'android'
PRINCIPAL = ANDROID / 'app' / 'src' / 'main'

# Qué de la web va dentro de la app
WEB_ARCHIVOS = ['index.html', 'privacidad.html', 'terminos.html', 'manifest.webmanifest', 'sw.js']
WEB_CARPETAS = ['css', 'js', 'icons']
# Archivo JS de cada componente de Capacitor (en node_modules) -> nombre dentro de www/nativo/
COMPONENTES = {
    '@capacitor/core/dist/capacitor.js': 'capacitor.js',
    '@capacitor/app/dist/plugin.js': 'app.js',
    '@capacitor/browser/dist/plugin.js': 'browser.js',
    '@capacitor/local-notifications/dist/plugin.js': 'local-notifications.js',
    '@capacitor/filesystem/dist/plugin.js': 'filesystem.js',
    '@capacitor/share/dist/plugin.js': 'share.js',
    '@capacitor/synapse/dist/synapse.js': 'synapse.js',  # lo necesita el componente de archivos
}


def fallo(msg):
    print(f'ERROR: {msg}', file=sys.stderr)
    sys.exit(1)


def version():
    m = re.search(r"const VERSION = '(\d+)'", (RAIZ / 'sw.js').read_text(encoding='utf-8'))
    if not m:
        fallo("No encuentro «const VERSION = '…'» en sw.js")
    return int(m.group(1))


def web():
    if WWW.exists():
        shutil.rmtree(WWW)
    WWW.mkdir()
    for f in WEB_ARCHIVOS:
        shutil.copy2(RAIZ / f, WWW / f)
    for c in WEB_CARPETAS:
        shutil.copytree(RAIZ / c, WWW / c)
    (WWW / 'nativo').mkdir()
    for origen, destino in COMPONENTES.items():
        p = RAIZ / 'node_modules' / origen
        if not p.exists():
            fallo(f'Falta {origen} (¿se ejecutó «npm ci»?)')
        shutil.copy2(p, WWW / 'nativo' / destino)
    print(f'www/ listo (versión {version()}): {sum(1 for _ in WWW.rglob("*") if _.is_file())} archivos')


def cambiar(texto, antiguo, nuevo, donde):
    if antiguo not in texto:
        fallo(f'La plantilla de Capacitor ha cambiado: no encuentro «{antiguo[:60]}» en {donde}')
    return texto.replace(antiguo, nuevo, 1)


def android():
    if not PRINCIPAL.exists():
        fallo('No existe android/. Ejecuta antes «npx cap add android».')
    v = version()
    cfg = json.loads((RAIZ / 'capacitor.config.json').read_text(encoding='utf-8'))
    app_id = cfg['appId']

    # 1) AndroidManifest: enlace de vuelta del inicio de sesión con Google, alarma exacta (calendario) y sin copia de seguridad
    mf = PRINCIPAL / 'AndroidManifest.xml'
    t = mf.read_text(encoding='utf-8')
    if 'custom_url_scheme' not in t:
        filtro = '''
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="@string/custom_url_scheme" android:host="auth" />
            </intent-filter>
'''
        t = cambiar(t, '''                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
''', '''                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
''' + filtro, 'AndroidManifest.xml (activity)')
    if 'USE_EXACT_ALARM' not in t:
        t = cambiar(t, '    <uses-permission android:name="android.permission.INTERNET" />',
                    '    <uses-permission android:name="android.permission.INTERNET" />\n'
                    '    <!-- Aviso a la hora exacta (app de calendario/agenda): se concede sola -->\n'
                    '    <uses-permission android:name="android.permission.USE_EXACT_ALARM" />', 'AndroidManifest.xml (permisos)')
    t = cambiar(t, 'android:allowBackup="true"', 'android:allowBackup="false"', 'AndroidManifest.xml (application)')
    mf.write_text(t, encoding='utf-8')

    # 2) El esquema del enlace de vuelta debe coincidir con REDIRECT_NATIVO de js/config.js
    cfgjs = (RAIZ / 'js' / 'config.js').read_text(encoding='utf-8')
    m = re.search(r"REDIRECT_NATIVO = '([^']+)'", cfgjs)
    if not m or m.group(1) != f'{app_id}://auth':
        fallo(f'REDIRECT_NATIVO en js/config.js debe ser «{app_id}://auth»')
    st = (PRINCIPAL / 'res' / 'values' / 'strings.xml').read_text(encoding='utf-8')
    if f'<string name="custom_url_scheme">{app_id}</string>' not in st:
        fallo('strings.xml no define custom_url_scheme con el id de la app')

    # 3) Número de versión de la APK = VERSION de sw.js (así cada APK nueva puede actualizar a la anterior)
    gr = ANDROID / 'app' / 'build.gradle'
    g = gr.read_text(encoding='utf-8')
    g = cambiar(g, 'versionCode 1', f'versionCode {v}', 'app/build.gradle')
    g = cambiar(g, 'versionName "1.0"', f'versionName "{v}"', 'app/build.gradle')
    gr.write_text(g, encoding='utf-8')

    # 4) Iconos, pantalla de arranque e icono de las notificaciones (ya preparados en android-nativo/res)
    origen = pathlib.Path(__file__).resolve().parent / 'res'
    n = 0
    for f in origen.rglob('*'):
        if f.is_file():
            destino = PRINCIPAL / 'res' / f.relative_to(origen)
            destino.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, destino)
            n += 1
    print(f'android/ listo: versionCode {v}, {n} recursos copiados')


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in ('web', 'android'):
        fallo('Uso: preparar.py web | android')
    web() if sys.argv[1] == 'web' else android()

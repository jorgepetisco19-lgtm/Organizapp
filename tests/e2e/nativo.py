"""Prueba de la APP DE ANDROID en un navegador real (Chromium), con el puente NATIVO DE CAPACITOR de verdad
(native-bridge.js) y un Android SIMULADO por debajo. Comprueba login con Google por navegador externo, avisos, botón atrás,
compartir archivos y aviso de versión nueva.

Uso (desde la carpeta del proyecto):   python3 tests/e2e/nativo.py
Necesita red para «npm ci» (baja Capacitor, como hace el workflow). NO prueba el Android real: eso solo se ve en un móvil.
"""
import base64, datetime, zoneinfo, functools, http.server, json, os, re, shutil, subprocess, sys, tempfile, threading
from playwright.sync_api import sync_playwright, expect

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FALSO = open(os.path.join(os.path.dirname(__file__), 'falso_supabase.js'), encoding='utf-8').read()
TMP = tempfile.mkdtemp(prefix='organizapp-nativo-')

# 1) Se construye www/ igual que el workflow: copia del proyecto + npm ci + preparar.py web
COPIA = os.path.join(TMP, 'proy')
shutil.copytree(RAIZ, COPIA, ignore=shutil.ignore_patterns('tests', 'sql', 'node_modules', 'android', 'www', '.git', 'importar'))
subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=COPIA, check=True, capture_output=True)
subprocess.run([sys.executable, 'android-nativo/preparar.py', 'web'], cwd=COPIA, check=True)
WWW = os.path.join(COPIA, 'www')
BRIDGE = open(os.path.join(COPIA, 'node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js'), encoding='utf-8').read()
VERSION_LOCAL = re.search(r"const VERSION = '(\d+)'", open(os.path.join(WWW, 'sw.js'), encoding='utf-8').read()).group(1)

class Silencioso(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8124), functools.partial(Silencioso, directory=WWW))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:8124/'

# 2) El «Android» simulado: recibe lo que manda el puente real y contesta como lo haría el móvil
CABECERAS = {
    'App': ['getLaunchUrl', 'exitApp', 'getInfo'],
    'Browser': ['open', 'close'],
    'LocalNotifications': ['schedule', 'getPending', 'cancel', 'createChannel', 'checkPermissions', 'requestPermissions', 'checkExactNotificationSetting'],
    'Filesystem': ['writeFile'],
    'Share': ['share', 'canShare'],
}
NATIVO_JS = """
window.WEBVIEW_SERVER_URL = location.origin;
window.__nativo = { llamadas: [], oyentes: {}, perm: 'prompt', pendientes: [], programadas: [], exacto: 'granted', abierto: [], compartidos: [], archivos: {}, salio: false, launchUrl: null, canales: [] };
window.androidBridge = { postMessage(txt) {
  const d = JSON.parse(txt), N = window.__nativo;
  N.llamadas.push({ p: d.pluginId, m: d.methodName, o: d.options });
  const responder = (data) => setTimeout(() => window.Capacitor.fromNative({ callbackId: d.callbackId, pluginId: d.pluginId, methodName: d.methodName, success: true, data }), 0);
  const o = d.options || {};
  switch (d.pluginId + '.' + d.methodName) {
    case 'App.addListener': N.oyentes[o.eventName] = d.callbackId; return;
    case 'App.getLaunchUrl': return responder(N.launchUrl ? { url: N.launchUrl } : {});
    case 'App.exitApp': N.salio = true; return responder({});
    case 'Browser.open': N.abierto.push(o.url); return responder({});
    case 'LocalNotifications.checkPermissions': return responder({ display: N.perm });
    case 'LocalNotifications.requestPermissions': if (N.perm === 'prompt') N.perm = N.respuestaPermiso || 'granted'; return responder({ display: N.perm });
    case 'LocalNotifications.checkExactNotificationSetting': return responder({ exact_alarm: N.exacto });
    case 'LocalNotifications.createChannel': N.canales.push(o); return responder({});
    case 'LocalNotifications.getPending': return responder({ notifications: N.pendientes.map((id) => ({ id })) });
    case 'LocalNotifications.cancel': { const ids = o.notifications.map((n) => n.id); N.pendientes = N.pendientes.filter((i) => !ids.includes(i)); return responder({}); }
    case 'LocalNotifications.schedule': N.programadas.push(o.notifications); o.notifications.forEach((n) => { if (!N.pendientes.includes(n.id)) N.pendientes.push(n.id); }); return responder({ notifications: o.notifications.map((n) => ({ id: n.id })) });
    case 'Filesystem.writeFile': N.archivos[o.path] = { data: o.data, directory: o.directory }; return responder({ uri: 'file:///cache/' + o.path });
    case 'Share.share': N.compartidos.push(o); return responder({});
    default: return responder({});
  }
} };
""" + BRIDGE + """
window.Capacitor.PluginHeaders = %s.map(([name, ms]) => ({ name, methods: [{ name: 'addListener', rtype: 'none' }, { name: 'removeListener', rtype: 'none' }].concat(ms.map((m) => ({ name: m, rtype: 'promise' }))) }));
// como hace Android de verdad, antes de nada ya hay un «Plugins» con versiones antiguas de cada componente
window.__atajos = {};
window.Capacitor.Plugins = window.Capacitor.Plugins || {};
for (const [name] of %s) { window.Capacitor.Plugins[name] = window.__atajos[name] = { atajo: true, addListener: () => ({ remove() {} }) }; }
window.__disparar = (evento, datos) => window.Capacitor.fromNative({ callbackId: window.__nativo.oyentes[evento], pluginId: 'App', methodName: 'addListener', success: true, data: datos, save: true });
""" % (json.dumps(list(CABECERAS.items())), json.dumps(list(CABECERAS.items())))

CAP = os.path.join(os.path.dirname(__file__), 'capturas'); os.makedirs(CAP, exist_ok=True)
fallos, errores = [], []
def comprobar(cond, msg):
    print(('  OK  ' if cond else '  FALLO ') + msg)
    if not cond: fallos.append(msg)
def N(page, expr): return page.evaluate(f'window.__nativo.{expr}')
def llamadas(page, plugin, metodo): return page.evaluate(f"window.__nativo.llamadas.filter((l) => l.p === '{plugin}' && l.m === '{metodo}')")
def tab(page, nombre):
    page.locator('nav.tabs button', has_text=nombre).click(); page.wait_for_timeout(150)
def semilla(page, evs):
    page.evaluate("""(evs) => { const db = JSON.parse(localStorage.getItem('falso_db')); const esp = db.espacios[0].id;
      for (const e of evs) db.eventos.push(Object.assign({ id: crypto.randomUUID(), espacio_id: esp, tipo: 'plan', titulo: 'x', fecha: '2026-10-23', hora_inicio: null, hora_fin: null, notas: null,
        repeticion: null, repite_hasta: null, excepciones: [], hechas: [], dias_semana: null, participantes: null, compartido: false, dias_extra: 0, creado_por: e.owner_id }, e));
      localStorage.setItem('falso_db', JSON.stringify(db)); }""", evs)

JORGE, PAULA, TERCERO = ('00000000-0000-0000-0000-00000000000' + c for c in 'abc')
REDIR = 'io.github.jorgepetisco19lgtm.organizapp://auth'

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, timezone_id='Europe/Madrid', locale='es-ES', service_workers='allow')
    ctx.route('**/js/supabase.min.js', lambda r: r.fulfill(body=FALSO, content_type='application/javascript'))
    publicada = {'v': VERSION_LOCAL}
    ctx.route('https://jorgepetisco19-lgtm.github.io/**', lambda r: r.fulfill(
        body=f"const VERSION = '{publicada['v']}';", content_type='application/javascript', headers={'access-control-allow-origin': '*'}))
    ctx.add_init_script(NATIVO_JS)
    page = ctx.new_page()
    AHORA = datetime.datetime(2026, 10, 23, 10, 0, 0, tzinfo=zoneinfo.ZoneInfo('Europe/Madrid'))
    page.clock.set_fixed_time(AHORA)
    page.on('console', lambda m: errores.append(f'consola[{m.type}]: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errores.append(f'pageerror: {e}'))
    page.on('dialog', lambda d: d.accept())

    print('1) Arranque nativo')
    page.goto(URL)
    expect(page.get_by_role('button', name='Entrar con Google')).to_be_visible()
    comprobar(page.evaluate('window.Capacitor.isNativePlatform()') is True, 'el puente real de Capacitor dice que es app nativa')
    comprobar(page.evaluate("Object.keys(window.__atajos).every((n) => window.Capacitor.Plugins[n] && window.Capacitor.Plugins[n] !== window.__atajos[n])"),
              'los 5 componentes cargados son los reales (sustituyen a los «atajos» del arranque)')
    comprobar(page.get_by_role('button', name=re.compile('Instalar en este móvil')).count() == 0, 'no ofrece «Instalar» (ya es una app)')
    comprobar(page.evaluate("navigator.serviceWorker.getRegistrations().then((r) => r.length)") == 0, 'no registra service worker')
    comprobar(len(llamadas(page, 'App', 'addListener')) == 2, 'se apunta a «atrás» y a «enlace recibido»')
    comprobar(len(llamadas(page, 'App', 'getLaunchUrl')) == 1, 'pregunta si la app se abrió con un enlace')

    print('2) Entrar con Google (navegador externo + enlace de vuelta)')
    page.evaluate("localStorage.setItem('falso_entrar_como','jorge')")
    page.get_by_role('button', name='Entrar con Google').click(); page.wait_for_timeout(300)
    comprobar(N(page, 'abierto') == ['https://falso.supabase.co/auth/v1/authorize?provider=google'], 'abre Google en el navegador del sistema')
    comprobar(page.evaluate('window.__oauth.redirectTo') == REDIR, 'pide volver a ' + REDIR)
    expect(page.get_by_role('button', name='Entrar con Google')).to_be_visible()
    page.evaluate(f"window.__disparar('appUrlOpen', {{ url: '{REDIR}?code=codigo-malo' }})"); page.wait_for_timeout(300)
    comprobar('invalid flow state' in page.locator('.error-txt').inner_text(), 'un código que no vale se explica en pantalla')
    page.evaluate(f"window.__disparar('appUrlOpen', {{ url: 'https://otra.web/?code=codigo-bueno' }})"); page.wait_for_timeout(200)
    comprobar(page.evaluate('window.__codigos.length') == 1, 'un enlace que no es de la app se ignora')
    page.evaluate(f"window.__disparar('appUrlOpen', {{ url: '{REDIR}?code=codigo-bueno' }})")
    expect(page.get_by_role('button', name='Crear calendario')).to_be_visible()
    comprobar(page.evaluate('window.__codigos') == ['codigo-malo', 'codigo-bueno'], 'el código del enlace se canjea por la sesión')
    page.evaluate(f"window.__disparar('appUrlOpen', {{ url: '{REDIR}?code=codigo-bueno' }})"); page.wait_for_timeout(200)
    comprobar(page.get_by_role('button', name='Crear calendario').is_visible(), 'si el enlace llega dos veces, no pasa nada')
    page.get_by_role('button', name='Crear calendario').click()
    expect(page.locator('nav.tabs')).to_be_visible()
    page.wait_for_timeout(1200)

    print('3) Permiso y primeros avisos')
    comprobar(len(llamadas(page, 'LocalNotifications', 'requestPermissions')) == 1, 'pide permiso de notificaciones una vez al entrar')
    comprobar(N(page, 'perm') == 'granted', 'permiso concedido')
    comprobar(N(page, 'programadas.length') == 0 and N(page, 'pendientes') == [], 'sin eventos con hora, no se programa nada')

    print('4) Eventos: uno propio creado en la app + otros sembrados')
    semilla(page, [
        {'owner_id': PAULA, 'titulo': 'Cena de Paula', 'hora_inicio': '20:00:00'},
        {'owner_id': PAULA, 'titulo': 'Para los dos', 'hora_inicio': '13:00:00', 'compartido': True},
        {'owner_id': PAULA, 'titulo': 'Grupo con Jorge', 'hora_inicio': '14:00:00', 'participantes': [PAULA, JORGE]},
        {'owner_id': PAULA, 'titulo': 'Grupo sin Jorge', 'hora_inicio': '15:00:00', 'participantes': [PAULA, TERCERO]},
        {'owner_id': JORGE, 'titulo': 'Sin hora', 'hora_inicio': None},
        {'owner_id': JORGE, 'titulo': 'Tarea hecha', 'tipo': 'tarea', 'hora_inicio': '17:00:00', 'hechas': ['2026-10-23']},
        {'owner_id': JORGE, 'titulo': 'Ya empezó', 'hora_inicio': '09:00:00'},
    ])
    tab(page, 'Inicio')
    page.locator('.fab').click()
    page.locator('.tipo-btn', has_text='Cita').click()
    page.get_by_label('Título').fill('Dentista'); page.get_by_label('Fecha').fill('2026-10-23'); page.get_by_label('Hora de inicio').fill('12:00')
    page.locator('.modal').get_by_role('button', name='Guardar').click()
    page.wait_for_timeout(300)
    n0 = len(N(page, 'programadas'))
    page.wait_for_timeout(2600)  # el cambio de eventos reprograma solo, con un pequeño retraso
    ult = N(page, 'programadas.slice(-1)[0]')
    titulos = sorted(re.sub(r'^\S+ ', '', n['title']) for n in ult)
    comprobar(titulos == ['Dentista', 'Grupo con Jorge', 'Para los dos'], 'programa lo mío, lo de todos y mi grupo (y nada más): ' + str(titulos))
    d = next(n for n in ult if 'Dentista' in n['title'])
    comprobar(d['body'] == 'En 30 min · 12:00', 'texto «En 30 min · 12:00» → ' + d['body'])
    comprobar(d['schedule']['at'].startswith('2026-10-23T09:30:00'),
              'a las 11:30 hora de Madrid (09:30 UTC) → ' + d['schedule']['at'])
    comprobar(d['channelId'] == 'avisos' and d['smallIcon'] == 'ic_stat_organizapp' and d['isExactNotification'] is True and d['schedule']['allowWhileIdle'] is True,
              'canal, icono de la notificación y alarma exacta (permitida)')
    comprobar(len(N(page, 'canales')) >= 1 and N(page, 'canales[0].importance') == 4, 'crea el canal de avisos con importancia alta')
    ids_antes = sorted(n['id'] for n in ult)
    comprobar(len(set(ids_antes)) == 3 and sorted(N(page, 'pendientes')) == ids_antes, 'tres avisos pendientes, con id propio cada uno')

    print('5) Ajustes de avisos en «Más»')
    tab(page, 'Más')
    comprobar(page.locator('#avisos').count() == 1, 'hay tarjeta «Avisos»')
    comprobar('3 avisos programados' in page.locator('.estado-avisos').inner_text(), 'dice cuántos hay: ' + page.locator('.estado-avisos').inner_text())
    page.get_by_label('Cuánto antes avisar').select_option('60'); page.wait_for_timeout(500)
    ult = N(page, 'programadas.slice(-1)[0]')
    dd = next(n for n in ult if 'Dentista' in n['title'])
    comprobar(dd['body'] == 'En 1 h · 12:00' and dd['schedule']['at'].startswith('2026-10-23T09:00:00'), 'con «1 hora antes» se reprograma: ' + dd['body'] + ' ' + dd['schedule']['at'])
    comprobar(sorted(n['id'] for n in ult) == ids_antes and sorted(N(page, 'pendientes')) == ids_antes, 'mismos ids: reprogramar no duplica avisos')
    page.get_by_label('Cuánto antes avisar').select_option('30'); page.wait_for_timeout(500)
    page.get_by_label('Avisarme antes de mis eventos').uncheck(); page.wait_for_timeout(500)
    comprobar(N(page, 'pendientes') == [], 'al desactivar, se cancelan todos los avisos')
    comprobar('desactivados' in page.locator('.estado-avisos').inner_text(), 'y lo dice')
    page.get_by_label('Avisarme antes de mis eventos').check(); page.wait_for_timeout(800)
    comprobar(len(N(page, 'pendientes')) == 3, 'al volver a activar, vuelven los avisos')
    n_ant = len(N(page, 'programadas'))
    page.get_by_role('button', name=re.compile('Probar aviso')).click(); page.wait_for_timeout(500)
    prueba = next((n for lote in N(page, 'programadas') for n in lote if n['id'] == 2147483000), None)
    comprobar(prueba is not None and prueba['isExactNotification'] is False, 'el aviso de prueba se programa')
    page.screenshot(path=f'{CAP}/n1-mas-avisos.png', full_page=True)

    print('6) Sin alarmas exactas y con permiso denegado')
    page.evaluate("window.__nativo.exacto = 'denied'"); page.get_by_label('Cuánto antes avisar').select_option('15'); page.wait_for_timeout(500)
    ult = N(page, 'programadas.slice(-1)[0]')
    comprobar(all(n['isExactNotification'] is False for n in ult) and len(ult) == 3, 'si Android no da alarma exacta, se programa «aproximada» (sin abrir ajustes)')
    page.evaluate("window.__nativo.perm = 'denied'")
    page.get_by_label('Cuánto antes avisar').select_option('30'); page.wait_for_timeout(600)
    comprobar('bloqueadas' in page.locator('.estado-avisos').inner_text(), 'con permiso denegado lo explica: ' + page.locator('.estado-avisos').inner_text()[:60])
    page.evaluate("window.__nativo.perm = 'granted'; window.__nativo.exacto = 'granted'")

    print('7) Compartir plantilla y enlace')
    page.get_by_role('button', name=re.compile('Plantilla sencilla')).first.click(); page.wait_for_timeout(500)
    arch = N(page, 'archivos')
    comprobar(list(arch) == ['plantilla-menu-organizapp.xlsx'] and arch['plantilla-menu-organizapp.xlsx']['directory'] == 'CACHE', 'escribe el Excel en la caché')
    comprobar(base64.b64decode(arch['plantilla-menu-organizapp.xlsx']['data'])[:2] == b'PK', 'y es un .xlsx válido (zip)')
    comp = N(page, 'compartidos')
    comprobar(len(comp) == 1 and comp[0]['files'] == ['file:///cache/plantilla-menu-organizapp.xlsx'], 'abre el menú Compartir con el archivo')
    page.get_by_role('button', name=re.compile('Compartir enlace')).click(); page.wait_for_timeout(300)
    comp = N(page, 'compartidos')
    comprobar(comp[-1].get('url') == 'https://jorgepetisco19-lgtm.github.io/Organizapp/', 'el enlace compartido es el de la web pública, no localhost')
    comprobar(page.get_by_text('Estás usando la app instalada').count() == 1, 'en «La app» pone que ya es la app instalada')

    print('8) Versión nueva')
    comprobar(page.locator('.nueva-version').count() == 0, 'con la misma versión no avisa')
    publicada['v'] = str(int(VERSION_LOCAL) + 1)
    page.get_by_role('button', name=re.compile('Buscar actualización')).click(); page.wait_for_timeout(400)
    comprobar(f'ya está la {publicada["v"]}' in page.locator('.modal').inner_text(), 'ofrece la versión nueva')
    page.get_by_role('button', name='Ir a la descarga').click(); page.wait_for_timeout(200)
    comprobar(N(page, 'abierto')[-1] == 'https://github.com/jorgepetisco19-lgtm/Organizapp/releases/latest', 'y abre la página de descargas')
    comprobar(page.locator('.nueva-version').count() == 1, 'queda la nota «Hay una versión nueva» en Más')
    publicada['v'] = VERSION_LOCAL
    page.get_by_role('button', name=re.compile('Buscar actualización')).click(); page.wait_for_timeout(400)
    comprobar(page.locator('.nueva-version').count() == 0, 'si ya no hay versión nueva, desaparece')

    print('9) Botón «atrás»')
    page.evaluate("window.__disparar('backButton', { canGoBack: false })"); page.wait_for_timeout(200)
    comprobar(page.locator('nav.tabs button[aria-current="page"]').inner_text().strip().endswith('Inicio'), 'desde Más, «atrás» vuelve a Inicio')
    page.locator('.fab').click()
    page.locator('.tipo-btn', has_text='Plan').click()
    comprobar(page.locator('.modal').count() == 1, 'ventana de nuevo evento abierta')
    page.evaluate("window.__disparar('backButton', { canGoBack: false })"); page.wait_for_timeout(200)
    comprobar(page.locator('.modal').count() == 0 and not N(page, 'salio'), '«atrás» cierra la ventana y no sale de la app')
    page.evaluate("window.__disparar('backButton', { canGoBack: false })"); page.wait_for_timeout(300)
    comprobar(N(page, 'salio') is True, 'en Inicio y sin ventanas, «atrás» sale de la app')

    print('10) Páginas legales fuera de la app')
    page.evaluate("window.__nativo.salio = false")
    tab(page, 'Más')
    page.get_by_role('link', name='Privacidad').click(); page.wait_for_timeout(300)
    comprobar(N(page, 'abierto')[-1] == 'https://jorgepetisco19-lgtm.github.io/Organizapp/privacidad.html' and page.url == URL, 'se abren en el navegador y la app no se mueve')

    print('11) Cerrar sesión y volver a entrar')
    page.get_by_role('button', name='Cerrar sesión').click(); page.wait_for_timeout(400)
    expect(page.get_by_role('button', name='Entrar con Google')).to_be_visible()
    comprobar(True, 'vuelve a la pantalla de entrada')

    print('12) Arranque en frío desde el enlace de vuelta (la app se había cerrado)')
    page2 = ctx.new_page()
    page2.add_init_script(f"window.__nativo.launchUrl = '{REDIR}?code=codigo-bueno';")  # el «Android» dice: me abrieron con este enlace
    page2.on('pageerror', lambda e: errores.append(f'pageerror2: {e}'))
    page2.clock.set_fixed_time(AHORA)
    page2.on('dialog', lambda d: d.accept())
    page2.goto(URL)
    page2.wait_for_timeout(1200)
    comprobar(page2.evaluate('window.__codigos') == ['codigo-bueno'] and page2.locator('nav.tabs').count() == 1, 'si la app se abre con el enlace de vuelta, entra directamente')
    page2.close()

    page.close(); b.close()

malos = [e for e in errores if not re.search(r'favicon', e)]
comprobar(not malos, 'sin errores ni avisos de consola/CSP' + ('' if not malos else ': ' + ' | '.join(malos[:5])))
shutil.rmtree(TMP, ignore_errors=True)
print('\nTODO OK' if not fallos else f'\n{len(fallos)} FALLOS: ' + '; '.join(fallos))
sys.exit(1 if fallos else 0)

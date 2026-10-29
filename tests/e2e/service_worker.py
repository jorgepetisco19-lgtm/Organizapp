"""Prueba del service worker con la librería REAL (sin Supabase falso): se instala, responde su versión y la app abre sin conexión."""
import http.server, threading, functools, os, sys, re
from playwright.sync_api import sync_playwright
RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
class S(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8124), functools.partial(S, directory=RAIZ))
threading.Thread(target=srv.serve_forever, daemon=True).start()
fallos = []
VER = re.search(r"VERSION = '([^']+)'", open(os.path.join(RAIZ, 'sw.js'), encoding='utf-8').read()).group(1)
def ok(c, m):
    print(('  OK  ' if c else '  FALLO ') + m)
    if not c: fallos.append(m)
errs = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844})
    # Supabase real: la red externa no existe aquí, así que se corta (la app debe seguir mostrando el login).
    ctx.route('https://**/*', lambda r: r.abort())
    page = ctx.new_page()
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto('http://127.0.0.1:8124/')
    page.wait_for_selector('text=Entrar con Google', timeout=10000)
    ok(True, 'con la librería real de Supabase la app llega a la pantalla de login')
    page.wait_for_function("navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(()=>true)", timeout=10000)
    page.wait_for_timeout(1500)
    claves = page.evaluate("caches.keys()")
    ok(claves == [f'organizapp-v{VER}'], f'caché creada: {claves}')
    n = page.evaluate("caches.open('organizapp-v%s')" % VER + ".then(c => c.keys()).then(k => k.length)")
    ok(n == 18, f'archivos en caché: {n}')
    page.reload(); page.wait_for_selector('text=Entrar con Google')
    v = page.evaluate("""new Promise(res => { navigator.serviceWorker.addEventListener('message', e => res(e.data));
        navigator.serviceWorker.controller.postMessage('version'); setTimeout(() => res(null), 3000); })""")
    ok(v == {'version': VER}, f'el SW responde su versión: {v}')
    ctx.set_offline(True)
    page.reload()
    page.wait_for_selector('text=Entrar con Google', timeout=10000)
    ok(True, 'sin conexión la app abre desde la caché')
    page.goto('http://127.0.0.1:8124/privacidad.html')
    ok('Política de privacidad' in page.inner_text('body'), 'sin conexión abre también la página de privacidad')
    b.close()
ok(not errs, f'sin errores de JavaScript: {errs}')
print('RESULTADO:', 'TODO OK' if not fallos else f'{len(fallos)} FALLOS')
sys.exit(1 if fallos else 0)

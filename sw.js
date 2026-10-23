// Organizapp · service worker.
// IMPORTANTE: sube este número en CADA despliegue. Así los móviles descargan la versión nueva.
const VERSION = '26';

const CACHE = `organizapp-v${VERSION}`;
const ARCHIVOS = [
  './', 'index.html', 'privacidad.html', 'terminos.html', 'manifest.webmanifest',
  'css/estilos.css', 'js/app.js', 'js/datos.js', 'js/util.js', 'js/xlsx.js', 'js/config.js', 'js/supabase.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/logo-cabecera.png',
].map((a) => new URL(a, self.registration.scope).href);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k.startsWith('organizapp-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Primero la red (siempre lo último publicado); si no hay conexión, lo guardado.
// Lo de Supabase no pasa por aquí (otro dominio).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const clave = url.origin + url.pathname;
  e.respondWith((async () => {
    try {
      const r = await fetch(req.url, { cache: 'no-cache' });
      if (r.ok && ARCHIVOS.includes(clave)) (await caches.open(CACHE)).put(clave, r.clone());
      return r;
    } catch (err) {
      const guardado = (await caches.match(clave)) ||
        (req.mode === 'navigate' ? await caches.match(new URL('index.html', self.registration.scope).href) : null);
      if (guardado) return guardado;
      throw err;
    }
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'version' && e.source) e.source.postMessage({ version: VERSION });
});

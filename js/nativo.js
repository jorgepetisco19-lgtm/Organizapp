// Puente con la app de Android (hecha con Capacitor). En la web normal (navegador o PWA) nada de esto se usa:
// esNativa() es false y no se carga ningún archivo extra.
import { URL_APP } from './config.js';

export const esNativa = () => {
  try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); } catch { return false; }
};

// Capacitor solo reparte sus «plugins» a la página si se carga su código JS. Esos archivos los copia el workflow a nativo/.
// (synapse.js es una pieza que necesita el componente de archivos; va antes que él)
const ARCHIVOS = ['capacitor.js', 'app.js', 'browser.js', 'local-notifications.js', 'share.js', 'synapse.js', 'filesystem.js'];
let P = null;

function cargarScript(src) {
  return new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => mal(new Error(`No se pudo cargar ${src}`));
    document.head.append(s);
  });
}

export async function iniciarNativo() {
  if (!esNativa()) return null;
  if (P) return P;
  for (const f of ARCHIVOS) {
    await cargarScript(`nativo/${f}`);
    if (f === 'synapse.js') window.synapse = window.outsystemsSynapse;
  }
  const pl = (window.Capacitor && window.Capacitor.Plugins) || {};
  for (const n of ['App', 'Browser', 'LocalNotifications', 'Filesystem', 'Share']) {
    if (!pl[n]) throw new Error(`Falta el componente nativo ${n}`);
  }
  P = { App: pl.App, Browser: pl.Browser, LocalNotifications: pl.LocalNotifications, Filesystem: pl.Filesystem, Share: pl.Share };
  return P;
}
const plugins = () => { if (!P) throw new Error('La app nativa no está lista.'); return P; };

// ---------- entrar con Google: navegador del sistema (Google no deja hacerlo dentro de una app) ----------
export const abrirEnNavegador = async (url) => { await plugins().Browser.open({ url }); };
export const cerrarNavegador = async () => { try { await plugins().Browser.close(); } catch { /* en Android no hace falta */ } };

// cb(url) se llama cuando el navegador devuelve a la app (appUrlOpen), o si la app se abrió justo con ese enlace.
export async function alAbrirEnlace(cb) {
  const { App } = plugins();
  App.addListener('appUrlOpen', (d) => { if (d && d.url) cb(d.url); });
  try { const l = await App.getLaunchUrl(); if (l && l.url) cb(l.url); } catch { /* sin enlace de arranque */ }
}

// ---------- botón «atrás» del móvil ----------
export const alPulsarAtras = (cb) => { plugins().App.addListener('backButton', () => cb()); };
export const salirDeLaApp = () => plugins().App.exitApp();

// ---------- compartir y guardar archivos ----------
function aBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// Abre el menú «Compartir» de Android con el archivo (ahí se puede guardar, abrir con Excel, mandar por WhatsApp…)
export async function compartirArchivo(nombre, bytes, titulo) {
  const { Filesystem, Share } = plugins();
  const r = await Filesystem.writeFile({ path: nombre, data: aBase64(bytes), directory: 'CACHE' });
  await Share.share({ title: titulo || nombre, files: [r.uri], dialogTitle: titulo || nombre });
}
export async function compartirTexto({ title, text, url }) {
  await plugins().Share.share({ title, text, url, dialogTitle: title || 'Compartir' });
}

// ---------- avisos (notificaciones locales) ----------
const CANAL = 'avisos';
const ICONO = 'ic_stat_organizapp';

// 'granted' | 'denied' | 'prompt'. Con pedir=true, si aún no se ha decidido, pregunta al usuario.
export async function permisoAvisos(pedir = false) {
  const { LocalNotifications: LN } = plugins();
  let est = (await LN.checkPermissions()).display;
  if (est === 'prompt' && pedir) est = (await LN.requestPermissions()).display;
  return est === 'prompt-with-rationale' ? 'prompt' : est;
}

export async function cancelarAvisos() {
  const { LocalNotifications: LN } = plugins();
  const pend = await LN.getPending();
  if (pend.notifications && pend.notifications.length) await LN.cancel({ notifications: pend.notifications.map((n) => ({ id: n.id })) });
}

// Sustituye TODOS los avisos pendientes por la lista nueva (cada aviso tiene un id fijo por evento y día).
export async function programarAvisos(lista) {
  const { LocalNotifications: LN } = plugins();
  await cancelarAvisos();
  if (!lista.length) return 0;
  await LN.createChannel({ id: CANAL, name: 'Avisos de eventos', description: 'Aviso antes de tus eventos', importance: 4, vibration: true });
  // Si Android no deja usar alarmas exactas, se programa «aproximada» en vez de abrir una pantalla de ajustes.
  let exacto = false;
  try { exacto = (await LN.checkExactNotificationSetting()).exact_alarm === 'granted'; } catch { exacto = false; }
  await LN.schedule({
    notifications: lista.map((a) => ({
      id: a.id, title: a.titulo, body: a.cuerpo, channelId: CANAL, smallIcon: ICONO, iconColor: '#2563EB', autoCancel: true,
      schedule: { at: a.cuando, allowWhileIdle: true }, isExactNotification: exacto,
    })),
  });
  return lista.length;
}

// Aviso de prueba dentro de unos segundos
export async function avisoDePrueba(segundos = 5) {
  const { LocalNotifications: LN } = plugins();
  await LN.createChannel({ id: CANAL, name: 'Avisos de eventos', description: 'Aviso antes de tus eventos', importance: 4, vibration: true });
  await LN.schedule({ notifications: [{
    id: 2147483000, title: '🔔 Organizapp', body: 'Así te avisaré antes de tus eventos.', channelId: CANAL, smallIcon: ICONO, iconColor: '#2563EB', autoCancel: true,
    schedule: { at: new Date(Date.now() + segundos * 1000), allowWhileIdle: true }, isExactNotification: false,
  }] });
}

// ---------- versión nueva ----------
// Número de versión publicado en la web (sw.js). null si no se pudo leer.
export async function versionPublicada() {
  try {
    const t = await (await fetch(`${URL_APP}sw.js`, { cache: 'no-store' })).text();
    const m = t.match(/const VERSION = '([^']+)'/);
    return m ? m[1] : null;
  } catch { return null; }
}

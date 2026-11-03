// Pruebas de la función «notificar» de Supabase con un Google y un Firebase simulados (no se manda ningún aviso de verdad).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// index.ts no usa nada de TypeScript: se copia como .mjs para importarlo sin depender de la versión de Node
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notificar-'));
fs.copyFileSync(new URL('../supabase/functions/notificar/index.ts', import.meta.url), path.join(tmp, 'index.mjs'));
const F = await import(pathToFileURL(path.join(tmp, 'index.mjs')).href);

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cuenta = {
  type: 'service_account', project_id: 'organizapp-test', client_email: 'firebase-adminsdk@organizapp-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const ENV = { AVISOS_SECRET: 'clave-compartida', FIREBASE_SERVICE_ACCOUNT: JSON.stringify(cuenta) };
const T = (c) => c.repeat(40);

function simulador({ googleOk = true, estado = {} } = {}) {
  const s = { token: 0, fcm: [], jwt: null };
  s.fetch = async (url, init) => {
    url = String(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      s.token++;
      const p = new URLSearchParams(init.body);
      s.grant = p.get('grant_type');
      s.jwt = p.get('assertion');
      if (!googleOk) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT' }), { status: 400 });
      return new Response(JSON.stringify({ access_token: 'acceso-' + s.token, expires_in: 3600 }), { status: 200 });
    }
    const m = url.match(/^https:\/\/fcm\.googleapis\.com\/v1\/projects\/([^/]+)\/messages:send$/);
    if (m) {
      const cuerpo = JSON.parse(init.body);
      s.fcm.push({ proyecto: m[1], auth: init.headers.Authorization, ...cuerpo.message });
      const e = estado[cuerpo.message.token];
      if (e === 'caducado') return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
      if (e === 'error') return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ name: 'projects/x/messages/1' }), { status: 200 });
    }
    throw new Error('Llamada inesperada: ' + url);
  };
  return s;
}
const peticion = (cuerpo, { metodo = 'POST', secreto = 'clave-compartida', crudo = null } = {}) => new Request('https://x/functions/v1/notificar', {
  method: metodo, headers: secreto === null ? {} : { 'x-avisos-secret': secreto, 'Content-Type': 'application/json' },
  body: metodo === 'GET' ? undefined : (crudo ?? JSON.stringify(cuerpo)),
});

test('rechaza lo que no es POST, sin clave, con clave mala o con cuerpo roto', async () => {
  F._vaciarCache();
  const s = simulador();
  assert.equal((await F.procesar(peticion({}, { metodo: 'GET' }), ENV, s.fetch)).status, 405);
  assert.equal((await F.procesar(peticion({ avisos: [] }, { secreto: null }), ENV, s.fetch)).status, 401);
  assert.equal((await F.procesar(peticion({ avisos: [] }, { secreto: 'otra' }), ENV, s.fetch)).status, 401);
  assert.equal((await F.procesar(peticion({ avisos: [] }, { secreto: 'clave-compartida-' }), ENV, s.fetch)).status, 401);
  assert.equal((await F.procesar(peticion(null, { crudo: 'esto no es json' }), ENV, s.fetch)).status, 400);
  assert.equal(s.token, 0, 'sin clave correcta no se llama a Google');
  assert.equal(s.fcm.length, 0);
});

test('sin secretos configurados responde 500 y no llama a nadie', async () => {
  const s = simulador();
  assert.equal((await F.procesar(peticion({ avisos: [] }), { AVISOS_SECRET: 'clave-compartida' }, s.fetch)).status, 500);
  assert.equal((await F.procesar(peticion({ avisos: [] }), { FIREBASE_SERVICE_ACCOUNT: ENV.FIREBASE_SERVICE_ACCOUNT }, s.fetch)).status, 500);
  assert.equal((await F.procesar(peticion({ avisos: [] }), { ...ENV, FIREBASE_SERVICE_ACCOUNT: '{no json' }, s.fetch)).status, 200, 'sin avisos no hace falta Firebase');
  assert.equal((await F.procesar(peticion({ avisos: [{ token: T('a'), titulo: 'x' }] }), { ...ENV, FIREBASE_SERVICE_ACCOUNT: '{no json' }, s.fetch)).status, 500);
  assert.equal((await F.procesar(peticion({ avisos: [{ token: T('a'), titulo: 'x' }] }), { ...ENV, FIREBASE_SERVICE_ACCOUNT: '{"project_id":"x"}' }, s.fetch)).status, 500);
  assert.equal(s.token, 0);
});

test('manda cada aviso a Firebase con el canal «novedades» y prioridad alta', async () => {
  F._vaciarCache();
  const s = simulador();
  const r = await F.procesar(peticion({ avisos: [
    { token: T('a'), titulo: 'Paula añadió un evento · Casa', cuerpo: 'Cena · vie 20/11 21:30' },
    { token: T('b'), titulo: 'Paula añadió un evento · Casa', cuerpo: 'Cena · vie 20/11 21:30' },
  ] }), ENV, s.fetch);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { enviados: 2, caducados: 0, errores: 0 });
  assert.equal(s.fcm.length, 2);
  const a = s.fcm.find((x) => x.token === T('a'));
  assert.equal(a.proyecto, 'organizapp-test');
  assert.equal(a.auth, 'Bearer acceso-1');
  assert.deepEqual(a.notification, { title: 'Paula añadió un evento · Casa', body: 'Cena · vie 20/11 21:30' });
  assert.equal(a.android.priority, 'HIGH');
  assert.equal(a.android.notification.channel_id, 'novedades');
});

test('el permiso de Google se firma bien (RS256, cuenta de servicio, 1 hora) y se reutiliza', async () => {
  F._vaciarCache();
  const s = simulador();
  const lote = { avisos: [{ token: T('a'), titulo: 'x', cuerpo: 'y' }] };
  await F.procesar(peticion(lote), ENV, s.fetch, 1_800_000_000_000);
  await F.procesar(peticion(lote), ENV, s.fetch, 1_800_000_060_000);
  assert.equal(s.token, 1, 'dentro de la hora se reutiliza');
  assert.equal(s.grant, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [cab, cuerpo, firma] = s.jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(cab), { alg: 'RS256', typ: 'JWT' });
  const c = dec(cuerpo);
  assert.equal(c.iss, cuenta.client_email);
  assert.equal(c.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(c.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(c.iat, 1_800_000_000);
  assert.equal(c.exp - c.iat, 3600);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${cab}.${cuerpo}`), publicKey, Buffer.from(firma, 'base64url')), 'la firma no coincide con la clave');
  await F.procesar(peticion(lote), ENV, s.fetch, 1_800_000_000_000 + 3_700_000);
  assert.equal(s.token, 2, 'pasada la hora se pide otro');
});

test('cuenta móviles caducados y errores; un fallo no impide los demás', async () => {
  F._vaciarCache();
  const s = simulador({ estado: { [T('c')]: 'caducado', [T('e')]: 'error' } });
  const r = await F.procesar(peticion({ avisos: ['a', 'b', 'c', 'e'].map((k) => ({ token: T(k), titulo: 't', cuerpo: 'c' })) }), ENV, s.fetch);
  assert.deepEqual(await r.json(), { enviados: 2, caducados: 1, errores: 1 });
});

test('limpia y limita lo que recibe', async () => {
  F._vaciarCache();
  const s = simulador();
  const largo = 'x'.repeat(500);
  const avisos = [
    { token: 'corto', titulo: 'no debe salir' },
    { token: T('a') },
    null, 'texto', 7,
    { token: T('a'), titulo: largo, cuerpo: largo },
    ...Array.from({ length: 300 }, (_, i) => ({ token: String(i).padStart(3, '0').repeat(10), titulo: 't' })),
  ];
  const r = await F.procesar(peticion({ avisos }), ENV, s.fetch);
  assert.equal(r.status, 200);
  assert.ok(s.fcm.length <= 200, 'como mucho 200 avisos por llamada');
  const gordo = s.fcm.find((x) => x.token === T('a'));
  assert.equal(gordo.notification.title.length, 120);
  assert.equal(gordo.notification.body.length, 300);
  assert.ok(!s.fcm.some((x) => x.token === 'corto'));
  const vacia = await F.procesar(peticion({ avisos: 'no es lista' }), ENV, s.fetch);
  assert.deepEqual(await vacia.json(), { enviados: 0, caducados: 0, errores: 0 });
  const sinCuerpo = await F.procesar(peticion({}), ENV, s.fetch);
  assert.equal(sinCuerpo.status, 200);
});

test('si Google rechaza la firma responde 502 con el motivo', async () => {
  F._vaciarCache();
  const s = simulador({ googleOk: false });
  const r = await F.procesar(peticion({ avisos: [{ token: T('a'), titulo: 'x' }] }), ENV, s.fetch);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Invalid JWT/);
  assert.equal(s.fcm.length, 0);
});

test('iguales() compara bien', () => {
  assert.equal(F.iguales('abc', 'abc'), true);
  assert.equal(F.iguales('abc', 'abd'), false);
  assert.equal(F.iguales('abc', 'abcd'), false);
  assert.equal(F.iguales('', 'a'), false);
});

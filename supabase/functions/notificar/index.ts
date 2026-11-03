// Organizapp · función «notificar» de Supabase (Edge Function).
// La llama la base de datos (SQL 13) cuando alguien crea o cambia un evento, con la lista de avisos a mandar:
//   { "avisos": [ { "token": "<código del móvil>", "titulo": "…", "cuerpo": "…" }, … ] }
// y ella los entrega a Firebase Cloud Messaging (FCM), que es quien hace sonar el móvil.
// Solo se aceptan llamadas con la clave compartida «avisos_secret» (cabecera x-avisos-secret). No lee nada de tu base de datos.
//
// Secretos que necesita (Supabase → Edge Functions → Secrets):
//   AVISOS_SECRET           la misma clave que está en Vault con el nombre «avisos_secret»
//   FIREBASE_SERVICE_ACCOUNT el contenido del archivo JSON de la cuenta de servicio de Firebase (lo pegas tú; nadie más lo ve)
//
// Sin dependencias: solo funciones estándar de la web (fetch, crypto). Todo el código es JavaScript válido también como TypeScript.

const ALCANCE = 'https://www.googleapis.com/auth/firebase.messaging';
const URL_TOKEN_GOOGLE = 'https://oauth2.googleapis.com/token';
const MAX_AVISOS = 200;
const CANAL = 'novedades'; // el canal de notificaciones que crea la app en el móvil

const bytes = (s) => new TextEncoder().encode(s);
const b64url = (buf) => {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const pemABytes = (pem) => {
  const limpio = String(pem).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(limpio);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// Comparación que no se corta al primer carácter distinto (para no dar pistas sobre la clave)
export function iguales(a, b) {
  const x = bytes(String(a)), y = bytes(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

// Pide a Google un permiso temporal (1 hora) firmando con la cuenta de servicio de Firebase.
export async function tokenGoogle(cuenta, fetchFn, ahoraMs = Date.now()) {
  const iat = Math.floor(ahoraMs / 1000);
  const cab = b64url(bytes(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const cuerpo = b64url(bytes(JSON.stringify({ iss: cuenta.client_email, scope: ALCANCE, aud: URL_TOKEN_GOOGLE, iat, exp: iat + 3600 })));
  const clave = await crypto.subtle.importKey('pkcs8', pemABytes(cuenta.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', clave, bytes(`${cab}.${cuerpo}`));
  const r = await fetchFn(URL_TOKEN_GOOGLE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cab}.${cuerpo}.${b64url(firma)}` }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google no dio permiso (${r.status}): ${j.error_description || j.error || 'sin detalle'}`);
  return { token: j.access_token, caduca: ahoraMs + (Number(j.expires_in) || 3600) * 1000 - 60000 };
}

// Un aviso a un móvil. Devuelve 'ok', 'caducado' (el móvil ya no existe) o 'error'.
export async function enviarFCM({ proyecto, accesoGoogle, aviso, fetchFn }) {
  const r = await fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(proyecto)}/messages:send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accesoGoogle}` },
    body: JSON.stringify({
      message: {
        token: aviso.token,
        notification: { title: aviso.titulo, body: aviso.cuerpo },
        android: { priority: 'HIGH', notification: { channel_id: CANAL } },
        data: { tipo: 'evento' },
      },
    }),
  });
  if (r.ok) return 'ok';
  const j = await r.json().catch(() => ({}));
  const codigo = JSON.stringify(j).includes('UNREGISTERED') || r.status === 404 ? 'caducado' : 'error';
  return codigo;
}

const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

let cache = null; // permiso de Google reutilizado mientras la función siga «caliente»

export async function procesar(req, env, fetchFn = fetch, ahoraMs = Date.now()) {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  if (!env.AVISOS_SECRET || !env.FIREBASE_SERVICE_ACCOUNT) return json({ error: 'Faltan secretos en la función (AVISOS_SECRET, FIREBASE_SERVICE_ACCOUNT)' }, 500);
  if (!iguales(req.headers.get('x-avisos-secret') || '', env.AVISOS_SECRET)) return json({ error: 'No autorizado' }, 401);

  let cuerpo;
  try { cuerpo = await req.json(); } catch { return json({ error: 'JSON no válido' }, 400); }
  const avisos = (Array.isArray(cuerpo && cuerpo.avisos) ? cuerpo.avisos : []).slice(0, MAX_AVISOS)
    .map((a) => ({ token: texto(a && a.token, 4096), titulo: texto(a && a.titulo, 120), cuerpo: texto(a && a.cuerpo, 300) }))
    .filter((a) => a.token.length >= 20 && (a.titulo || a.cuerpo));
  if (!avisos.length) return json({ enviados: 0, caducados: 0, errores: 0 });

  let cuenta;
  try { cuenta = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); } catch { return json({ error: 'FIREBASE_SERVICE_ACCOUNT no es un JSON válido' }, 500); }
  if (!cuenta.project_id || !cuenta.client_email || !cuenta.private_key) return json({ error: 'FIREBASE_SERVICE_ACCOUNT está incompleto' }, 500);

  try {
    if (!cache || cache.caduca <= ahoraMs || cache.cuenta !== cuenta.client_email) cache = { ...(await tokenGoogle(cuenta, fetchFn, ahoraMs)), cuenta: cuenta.client_email };
  } catch (e) { return json({ error: String(e.message || e) }, 502); }

  const res = { enviados: 0, caducados: 0, errores: 0 };
  for (let i = 0; i < avisos.length; i += 10) {
    const trozo = await Promise.all(avisos.slice(i, i + 10).map((a) =>
      enviarFCM({ proyecto: cuenta.project_id, accesoGoogle: cache.token, aviso: a, fetchFn }).catch(() => 'error')));
    for (const t of trozo) { if (t === 'ok') res.enviados++; else if (t === 'caducado') res.caducados++; else res.errores++; }
  }
  return json(res);
}

export const _vaciarCache = () => { cache = null; };

// Dentro de Supabase (Deno) se pone en marcha solo; en las pruebas se importa y se llama a procesar().
if (typeof Deno !== 'undefined' && Deno.serve) Deno.serve((req) => procesar(req, Deno.env.toObject()));

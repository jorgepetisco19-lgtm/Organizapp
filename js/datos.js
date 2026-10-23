// Todo lo que habla con Supabase está aquí. La pantalla (app.js) no toca la base de datos directamente.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});
export const auth = sb.auth;

function traducir(error) {
  const m = String(error.message || error);
  if (error.code === '23505') return 'Eso ya existe.';
  if (/row-level security|permission denied/i.test(m)) return 'No tienes permiso para hacer eso.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Sin conexión. Inténtalo de nuevo.';
  return m;
}
function ok({ data, error }) {
  if (error) throw new Error(traducir(error));
  return data;
}
// Las reglas de acceso hacen que un cambio no permitido afecte a 0 filas sin dar error: lo detectamos.
function exactamente(data, n, mensaje) {
  if (!data || data.length !== n) throw new Error(mensaje || 'No se pudo guardar. Puede que no tengas permiso.');
  return data;
}

// ---------- sesión ----------
export const iniciarSesion = async () =>
  ok(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }));
export const cerrarSesion = async () => ok(await sb.auth.signOut());
export const alCambiarSesion = (cb) => sb.auth.onAuthStateChange(cb);

// ---------- contexto: perfil, calendarios, personas, invitaciones ----------
// Una persona puede estar en varios calendarios. Aquí se cargan los suyos; el detalle del que está
// abierto (personas, invitaciones enviadas) se carga con cargarEspacio().
export async function cargarContexto(user) {
  const md = user.user_metadata || {};
  const nombre = md.full_name || md.name || (user.email || '').split('@')[0] || 'Yo';
  const perfil = ok(await sb.rpc('iniciar_perfil', { p_nombre: nombre }));
  const mias = ok(await sb.from('miembros').select('espacio_id, relacion, color, unido').eq('user_id', user.id));
  const invitaciones = ok(await sb.rpc('mis_invitaciones'));
  const amistades = await misAmistades().catch(() => null); // null = la base aún no tiene el cambio 3 (la app sigue funcionando)
  let espacios = [];
  if (mias.length) {
    const es = ok(await sb.from('espacios').select('id, nombre, creado_por').in('id', mias.map((x) => x.espacio_id)));
    espacios = mias
      .map((m) => ({ ...(es.find((e) => e.id === m.espacio_id) || {}), relacion: m.relacion, color: m.color, unido: m.unido }))
      .filter((e) => e.id)
      .sort((x, y) => String(x.unido).localeCompare(String(y.unido)));
  }
  return { perfil, espacios, invitaciones, amistades };
}

export async function cargarEspacio(user, espacio) {
  const lista = ok(await sb.from('miembros').select('user_id, relacion, color').eq('espacio_id', espacio.id));
  const perfiles = ok(await sb.from('perfiles').select('id, nombre').in('id', lista.map((x) => x.user_id)));
  const miembros = lista
    .map((x) => ({ id: x.user_id, relacion: x.relacion, color: x.color, nombre: (perfiles.find((p) => p.id === x.user_id) || { nombre: 'Alguien' }).nombre }))
    .sort((a, b) => (a.id === user.id ? -1 : b.id === user.id ? 1 : a.nombre.localeCompare(b.nombre, 'es')));
  const enviadas = espacio.relacion === 'pareja' ? ok(await sb.rpc('invitaciones_enviadas', { p_espacio: espacio.id })) : [];
  return { miembros, enviadas };
}

export const crearEspacio = async (nombre) => ok(await sb.rpc('crear_espacio', { p_nombre: nombre }));
export const aceptarInvitacion = async (id) => ok(await sb.rpc('aceptar_invitacion', { p_id: id }));
export const rechazarInvitacion = async (id) => ok(await sb.rpc('rechazar_invitacion', { p_id: id }));
export const invitar = async (espacioId, email, relacion, userId) =>
  ok(await sb.from('invitaciones').insert({ espacio_id: espacioId, email, relacion, creada_por: userId }));
export const invitarAmigo = async (espacioId, amigoId, relacion) =>
  ok(await sb.rpc('invitar_amigo', { p_espacio: espacioId, p_amigo: amigoId, p_relacion: relacion }));
export const borrarInvitacion = async (id) =>
  exactamente(ok(await sb.from('invitaciones').delete().eq('id', id).select('id')), 1);
export const renombrarEspacio = async (espacioId, nombre) => ok(await sb.rpc('renombrar_espacio', { p_espacio: espacioId, p_nombre: nombre }));
export const quitarMiembro = async (espacioId, userId) => ok(await sb.rpc('quitar_miembro', { p_espacio: espacioId, p_user: userId }));
export const cambiarRol = async (espacioId, userId, relacion) => ok(await sb.rpc('cambiar_rol', { p_espacio: espacioId, p_user: userId, p_relacion: relacion }));
export const salirEspacio = async (espacioId) => ok(await sb.rpc('salir_espacio', { p_espacio: espacioId }));
export const eliminarEspacio = async (espacioId) => ok(await sb.rpc('eliminar_espacio', { p_espacio: espacioId }));
export const cambiarMiColor = async (espacioId, color) => ok(await sb.rpc('cambiar_mi_color', { p_espacio: espacioId, p_color: color }));
export const guardarPerfil = async (id, campos) =>
  exactamente(ok(await sb.from('perfiles').update(campos).eq('id', id).select('id')), 1);

// ---------- amigos ----------
export const misAmistades = async () => ok(await sb.rpc('mis_amistades'));
export const buscarCodigo = async (codigo) => ok(await sb.rpc('buscar_codigo', { p_codigo: codigo }));
export const pedirAmistad = async (codigo) => ok(await sb.rpc('pedir_amistad', { p_codigo: codigo }));
export const responderAmistad = async (id, aceptar) => ok(await sb.rpc('responder_amistad', { p_id: id, p_aceptar: aceptar }));
export const quitarAmistad = async (id) => ok(await sb.rpc('quitar_amistad', { p_id: id }));
export const regenerarCodigo = async () => ok(await sb.rpc('regenerar_codigo'));

// ---------- eventos y menú ----------
export async function cargarRango(espacioId, desde, hasta) {
  const [ev, mn] = await Promise.all([
    sb.from('eventos').select('*').eq('espacio_id', espacioId).lte('fecha', hasta)
      .or(`fecha.gte.${desde},repeticion.not.is.null`),
    sb.from('menu').select('*').eq('espacio_id', espacioId).gte('fecha', desde).lte('fecha', hasta),
  ]);
  return { eventos: ok(ev), menu: ok(mn) };
}
export async function cargarMenu(espacioId, desde, hasta) {
  return ok(await sb.from('menu').select('*').eq('espacio_id', espacioId).gte('fecha', desde).lte('fecha', hasta));
}

export const eventosDe = async (espacioId, ownerId) =>
  ok(await sb.from('eventos').select('*').eq('espacio_id', espacioId).eq('owner_id', ownerId));
export const crearEventos = async (filas) => ok(await sb.from('eventos').insert(filas));

// ---------- líneas: pasos de una tarea y lista de la compra ----------
const porOrden = (a, b) => (a.orden - b.orden) || String(a.creada).localeCompare(String(b.creada));
// Pasos de varias tareas, de 50 en 50 para no hacer la dirección demasiado larga.
export async function cargarPasos(ids) {
  const trozos = [];
  for (let i = 0; i < ids.length; i += 50) trozos.push(ids.slice(i, i + 50));
  const res = await Promise.all(trozos.map(async (t) => ok(await sb.from('lineas').select('*').in('evento_id', t))));
  return res.flat().sort(porOrden);
}
export const cargarCompra = async (espacioId) =>
  ok(await sb.from('lineas').select('*').eq('espacio_id', espacioId).is('evento_id', null)).sort(porOrden);
export const crearLineas = async (filas) => ok(await sb.from('lineas').insert(filas).select('*'));
export const guardarLinea = async (id, campos) =>
  exactamente(ok(await sb.from('lineas').update(campos).eq('id', id).select('id')), 1);
export const borrarLinea = async (id) =>
  exactamente(ok(await sb.from('lineas').delete().eq('id', id).select('id')), 1);
export const quitarMarcadasCompra = async (espacioId) =>
  ok(await sb.from('lineas').delete().eq('espacio_id', espacioId).is('evento_id', null).eq('hecha', true));
export const guardarEvento = async (id, campos) =>
  exactamente(ok(await sb.from('eventos').update(campos).eq('id', id).select('id')), 1);
export const borrarEvento = async (id) =>
  exactamente(ok(await sb.from('eventos').delete().eq('id', id).select('id')), 1);

export async function guardarMenu(filas) {
  for (let i = 0; i < filas.length; i += 200) {
    ok(await sb.from('menu').upsert(filas.slice(i, i + 200), { onConflict: 'espacio_id,owner_id,fecha,franja' }));
  }
}
export async function borrarMenu(espacioId, ownerId, fecha, franja) {
  ok(await sb.from('menu').delete().eq('espacio_id', espacioId).eq('owner_id', ownerId).eq('fecha', fecha).eq('franja', franja));
}

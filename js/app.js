// Organizapp · pantalla y lógica. Sin frameworks: todo el texto del usuario se pinta con
// textContent (nunca innerHTML), así que nadie puede colar código en un título o un menú.
import * as D from './datos.js';
import {
  FRANJAS, TIPOS, PALETA, hoyISO, sumarDias, inicioSemana, rejillaMes, finMes, sumarMeses,
  nombreMes, nombreDiaCorto, fechaLarga, fechaCorta, hhmm, esFechaISO, expandirEventos,
  repetirSemanas, leerImportacion, diffDias, diaSemana, plantillaMenu, primeraLinea,
} from './util.js';
import { crearXlsx, leerXlsx } from './xlsx.js';

// ---------- utilidades de pantalla ----------
const $ = (s, r = document) => r.querySelector(s);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pad2 = (n) => String(n).padStart(2, '0');

function el(tag, props, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') {
      for (const [p, val] of Object.entries(v)) (p.startsWith('--') ? n.style.setProperty(p, val) : (n.style[p] = val));
    } else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat(Infinity)) {
    if (h == null || h === false) continue;
    n.append(h.nodeType ? h : document.createTextNode(String(h)));
  }
  return n;
}

const guardarLocal = (k, v) => { try { localStorage.setItem('org_' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
const leerLocal = (k, def) => {
  try { const v = localStorage.getItem('org_' + k); return v == null ? def : JSON.parse(v); } catch { return def; }
};

let avisoT;
function aviso(texto, error = false) {
  const a = $('#aviso');
  a.textContent = texto;
  a.className = 'aviso visible' + (error ? ' error' : '');
  clearTimeout(avisoT);
  avisoT = setTimeout(() => { a.className = 'aviso'; }, error ? 5000 : 2500);
}

async function conCarga(boton, fn) {
  if (boton) boton.disabled = true;
  try { await fn(); } catch (e) { aviso(e.message || String(e), true); } finally { if (boton) boton.disabled = false; }
}

function modal(titulo, cuerpo, alCerrar) {
  const fondo = el('div', { class: 'modal-fondo', onclick: (e) => { if (e.target === fondo) cerrar(); } });
  const alTecla = (e) => { if (e.key === 'Escape') cerrar(); };
  function cerrar() {
    document.removeEventListener('keydown', alTecla);
    fondo.remove();
    document.body.classList.toggle('sin-scroll', $('#modales').children.length > 0);
    if (alCerrar) { const f = alCerrar; alCerrar = null; f(); }
  }
  fondo.append(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo },
    el('div', { class: 'modal-cab' },
      el('h2', {}, titulo),
      el('button', { type: 'button', class: 'icono', 'aria-label': 'Cerrar', onclick: cerrar }, '✕')),
    el('div', { class: 'modal-cuerpo' }, cuerpo)));
  document.addEventListener('keydown', alTecla);
  $('#modales').append(fondo);
  document.body.classList.add('sin-scroll');
  return cerrar;
}

// ---------- estado ----------
const hoyInicial = hoyISO();
const S = {
  cargando: true, error: null, errorLogin: null,
  user: null, perfil: null, espacio: null, relacion: null,
  espacios: [], miembros: [], enviadas: [], invitaciones: [], amistades: null,
  tab: 'inicio', inicioDia: 'manana',
  capas: new Set(), tipos: new Set(leerLocal('tipos', TIPOS.map((t) => t.id))),
  tiposInicio: new Set(leerLocal('tipos_inicio', TIPOS.map((t) => t.id))),
  vista: leerLocal('vista', 'lista'),
  calVista: leerLocal('cal_vista', 'mes'), semanaCal: inicioSemana(hoyInicial),
  diaSel: hoyInicial, mes: { y: Number(hoyInicial.slice(0, 4)), m: Number(hoyInicial.slice(5, 7)) },
  semana: inicioSemana(hoyInicial),
  eventos: [], menu: [], menuMap: new Map(), rango: null, cargandoDatos: false,
  version: '…', instalar: null,
};
const claveMenu = (fecha, owner, franja) => `${fecha}|${owner}|${franja}`;
const miembro = (id) => S.miembros.find((m) => m.id === id);
const colorDe = (id) => (miembro(id) || { color: '#888888' }).color;
// Los eventos "de todos" (compartido) llevan un color propio, distinto de los de cada persona (PALETA no lo incluye).
const COLOR_AMBOS = '#64748b';
const etiquetaTodos = () => (S.miembros.length === 2 ? 'Los dos' : 'Todos');
const colorEv = (ev) => (ev.compartido ? COLOR_AMBOS : colorDe(ev.owner_id));
const eventoVisible = (e) => e.compartido || S.capas.has(e.owner_id);
const puedeEditarCapa = (ownerId) => ownerId === S.user.id || S.relacion === 'pareja';
const editables = () => S.miembros.filter((m) => puedeEditarCapa(m.id));
const visiblesCapas = () => S.miembros.filter((m) => S.capas.has(m.id));

// ---------- tema ----------
function aplicarTema() {
  const t = leerLocal('tema', 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-tema');
  else document.documentElement.setAttribute('data-tema', t === 'oscuro' ? 'oscuro' : 'claro');
}

// ---------- carga de datos ----------
let token = 0;

function rangoVista() {
  if (S.tab === 'calendario' && S.calVista === 'semana') return { desde: S.semanaCal, hasta: sumarDias(S.semanaCal, 6) };
  if (S.tab === 'calendario') {
    const sem = rejillaMes(S.mes.y, S.mes.m);
    return { desde: sem[0][0], hasta: sem[sem.length - 1][6] };
  }
  if (S.tab === 'menu') return { desde: S.semana, hasta: sumarDias(S.semana, 6) };
  const hoy = hoyISO();
  return { desde: hoy, hasta: sumarDias(hoy, 1) };
}

async function cargarVista(forzar = false) {
  if (S.tab === 'mas') return render();
  const { desde, hasta } = rangoVista();
  const r = S.rango;
  if (!forzar && r && r.desde <= desde && r.hasta >= hasta && Date.now() - r.t < 60000) return render();
  const mio = ++token;
  S.cargandoDatos = true;
  render();
  try {
    const datos = await D.cargarRango(S.espacio.id, desde, hasta);
    if (mio !== token) return;
    S.eventos = datos.eventos;
    S.menu = datos.menu;
    S.menuMap = new Map(datos.menu.map((f) => [claveMenu(f.fecha, f.owner_id, f.franja), f]));
    S.rango = { desde, hasta, t: Date.now() };
  } catch (e) {
    if (mio !== token) return;
    S.rango = null;
    aviso(e.message || String(e), true);
  }
  S.cargandoDatos = false;
  render();
}

// Deja listo el calendario "esp": personas, invitaciones enviadas y qué capas se ven (se recuerda por calendario).
async function prepararEspacio(esp) {
  if (!esp) {
    Object.assign(S, { espacio: null, relacion: null, miembros: [], enviadas: [], capas: new Set(), eventos: [], menu: [], menuMap: new Map(), rango: null });
    return;
  }
  const d = await D.cargarEspacio(S.user, esp);
  Object.assign(S, { espacio: esp, relacion: esp.relacion, miembros: d.miembros, enviadas: d.enviadas, eventos: [], menu: [], menuMap: new Map(), rango: null });
  guardarLocal('espacio_actual', esp.id);
  const guardadas = leerLocal(`capas_${esp.id}`, null);
  const ids = new Set(S.miembros.map((m) => m.id));
  const validas = Array.isArray(guardadas) ? guardadas.filter((i) => ids.has(i)) : [];
  S.capas = new Set(validas.length ? validas : [...ids]);
}

async function cargarTodo(preferido = null) {
  S.cargando = true; S.error = null;
  render();
  try {
    const c = await D.cargarContexto(S.user);
    Object.assign(S, { perfil: c.perfil, espacios: c.espacios, invitaciones: c.invitaciones, amistades: c.amistades });
    const quiero = preferido || S.espacio?.id || leerLocal('espacio_actual', null);
    await prepararEspacio(S.espacios.find((e) => e.id === quiero) || S.espacios[0] || null);
    S.cargando = false;
    if (S.espacio) return await cargarVista(true);
  } catch (e) {
    S.error = e.message || String(e);
    S.cargando = false;
  }
  render();
}

async function cambiarEspacio(id) {
  const esp = S.espacios.find((e) => e.id === id);
  if (!esp || esp.id === S.espacio?.id) return;
  S.cargandoDatos = true; render();
  try { await prepararEspacio(esp); } catch (e) { aviso(e.message || String(e), true); }
  S.cargandoDatos = false;
  await cargarVista(true);
}

function reiniciarSesionLocal() {
  Object.assign(S, { user: null, perfil: null, espacio: null, espacios: [], relacion: null, miembros: [], enviadas: [], invitaciones: [], amistades: null, eventos: [], menu: [], menuMap: new Map(), rango: null, tab: 'inicio' });
}

async function alSesion(sesion) {
  if (!sesion) { reiniciarSesionLocal(); S.cargando = false; return render(); }
  if (S.user && S.user.id === sesion.user.id && (S.espacio || S.perfil)) { S.user = sesion.user; return; }
  S.user = sesion.user;
  await cargarTodo();
}

// ---------- pantallas ----------
function pantallaCarga() {
  return el('div', { class: 'centro' }, el('div', { class: 'girando', 'aria-label': 'Cargando' }), el('p', { class: 'suave' }, 'Cargando…'));
}

function enlacesLegales() {
  return el('p', { class: 'legal' }, el('a', { href: 'privacidad.html' }, 'Privacidad'), ' · ', el('a', { href: 'terminos.html' }, 'Condiciones'));
}

function pantallaLogin() {
  return el('div', { class: 'centro login' },
    el('img', { src: 'icons/icon-192.png', alt: '', width: 96, height: 96, class: 'logo' }),
    el('h1', {}, 'Organizapp'),
    el('p', { class: 'suave' }, 'Calendario compartido para planificar las comidas, el deporte y las tareas.'),
    S.errorLogin ? el('p', { class: 'error-txt', role: 'alert' }, S.errorLogin) : null,
    el('button', { class: 'primario grande', onclick: (e) => conCarga(e.currentTarget, () => D.iniciarSesion()) }, 'Entrar con Google'),
    enlacesLegales());
}

function pantallaError() {
  return el('div', { class: 'centro' },
    el('h1', {}, 'Algo ha fallado'),
    el('p', { class: 'error-txt', role: 'alert' }, S.error),
    el('div', { class: 'fila-botones' },
      el('button', { class: 'primario', onclick: () => cargarTodo() }, 'Reintentar'),
      el('button', { onclick: () => D.cerrarSesion() }, 'Cerrar sesión')));
}

function pantallaBienvenida() {
  const nombreIn = el('input', { type: 'text', maxLength: 80, value: 'Nuestro calendario', 'aria-label': 'Nombre del calendario' });
  return el('div', { class: 'bienvenida' },
    el('h1', {}, `Hola, ${S.perfil?.nombre || ''}`),
    S.invitaciones.length ? el('section', { class: 'tarjeta' },
      el('h2', {}, 'Tienes invitaciones'),
      S.invitaciones.map((inv) => el('div', { class: 'invitacion' },
        el('p', {}, `${inv.de_nombre} te ha invitado al calendario «${inv.espacio_nombre}».`),
        el('div', { class: 'fila-botones' },
          el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => { await cargarTodo(await D.aceptarInvitacion(inv.id)); }) }, 'Aceptar'),
          el('button', { onclick: (e) => conCarga(e.currentTarget, async () => { await D.rechazarInvitacion(inv.id); await cargarTodo(); }) }, 'Rechazar'))))) : null,
    el('section', { class: 'tarjeta' },
      el('h2', {}, S.invitaciones.length ? 'O crea uno nuevo' : 'Crea vuestro calendario'),
      el('label', {}, 'Nombre', nombreIn),
      el('p', { class: 'suave' }, 'Después podrás invitar a tu pareja o a tus amigos.'),
      el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => { await cargarTodo(await D.crearEspacio(nombreIn.value.trim() || 'Nuestro calendario')); }) }, 'Crear calendario')),
    tarjetaAmigos(),
    el('div', { class: 'fila-botones' },
      el('button', { onclick: (e) => conCarga(e.currentTarget, async () => { await cargarTodo(); }) }, '🔄 Comprobar invitaciones')),
    el('p', {}, el('button', { class: 'enlace', onclick: () => D.cerrarSesion() }, 'Cerrar sesión')),
    enlacesLegales());
}

function capasChips() {
  if (S.miembros.length < 2) return null;
  return el('div', { class: 'chips capas', role: 'group', 'aria-label': 'Qué personas ver' },
    S.miembros.map((m) => el('button', {
      type: 'button', class: 'chip-capa', 'aria-pressed': String(S.capas.has(m.id)), style: { '--c': m.color },
      onclick: () => {
        if (S.capas.has(m.id)) { if (S.capas.size > 1) S.capas.delete(m.id); } else S.capas.add(m.id);
        guardarLocal(`capas_${S.espacio.id}`, [...S.capas]);
        render();
      },
    }, el('span', { class: 'punto' }), m.nombre)));
}

// ---------- varios calendarios ----------
const etiquetaRol = (r) => (r === 'pareja' ? 'pareja' : 'amistad');

function selectorCalendario() {
  if (!S.espacio) return null;
  return el('button', { type: 'button', class: 'selector-cal', 'aria-haspopup': 'dialog', onclick: () => abrirSelectorCalendarios() },
    el('span', { class: 'sc-nombre' }, `📅 ${S.espacio.nombre}`),
    S.invitaciones.length ? el('span', { class: 'punto-aviso en-linea', 'aria-label': 'Tienes invitaciones' }) : null,
    el('span', { class: 'sc-flecha', 'aria-hidden': 'true' }, '▾'));
}

// Tarjeta/lista de invitaciones recibidas (a tu correo o de un amigo). Al aceptar se abre ese calendario.
function listaInvitaciones(alTerminar) {
  return S.invitaciones.map((inv) => el('div', { class: 'invitacion' },
    el('p', {}, `${inv.de_nombre} te ha invitado al calendario «${inv.espacio_nombre}» (como ${etiquetaRol(inv.relacion)}).`),
    el('div', { class: 'fila-botones' },
      el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
        const id = await D.aceptarInvitacion(inv.id);
        aviso(`Te has unido a «${inv.espacio_nombre}»`);
        if (alTerminar) alTerminar();
        await cargarTodo(id);
      }) }, 'Aceptar'),
      el('button', { onclick: (e) => conCarga(e.currentTarget, async () => {
        await D.rechazarInvitacion(inv.id);
        if (alTerminar) alTerminar();
        await cargarTodo();
      }) }, 'Rechazar'))));
}

function abrirSelectorCalendarios() {
  const cerrar = modal('Tus calendarios', el('div', { class: 'formulario' },
    S.invitaciones.length ? el('div', {}, el('span', { class: 'etq' }, 'Invitaciones'), listaInvitaciones(() => cerrar())) : null,
    el('ul', { class: 'lista-cals' }, S.espacios.map((e) => el('li', {},
      el('button', { type: 'button', class: 'fila-cal', 'aria-current': e.id === S.espacio.id ? 'true' : null,
        onclick: () => { cerrar(); cambiarEspacio(e.id); } },
        el('span', { class: 'punto', style: { '--c': e.color } }),
        el('span', { class: 'fc-nombre' }, e.nombre),
        el('span', { class: 'suave' }, e.id === S.espacio.id ? 'abierto' : etiquetaRol(e.relacion)))))),
    el('button', { class: 'primario', onclick: () => { cerrar(); abrirNuevoCalendario(); } }, '＋ Nuevo calendario')));
}

function abrirNuevoCalendario() {
  const nombreIn = el('input', { type: 'text', maxLength: 80, placeholder: 'Por ejemplo: Personal, Con mi pareja, Pádel…', 'aria-label': 'Nombre del nuevo calendario' });
  const cerrar = modal('Nuevo calendario', el('div', { class: 'formulario' },
    el('label', {}, 'Nombre', nombreIn),
    el('p', { class: 'suave' }, 'Empieza siendo solo tuyo: nadie lo ve hasta que invites a alguien. Luego puedes invitar a tu pareja o a tus amigos.'),
    el('div', { class: 'fila-botones fin' },
      el('button', { type: 'button', onclick: () => cerrar() }, 'Cancelar'),
      el('button', { type: 'button', class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
        const nombre = nombreIn.value.trim();
        if (!nombre) throw new Error('Ponle un nombre al calendario.');
        const id = await D.crearEspacio(nombre);
        cerrar(); aviso('Calendario creado');
        await cargarTodo(id);
      }) }, 'Crear'))));
  setTimeout(() => nombreIn.focus(), 50);
}

const TABS = [['inicio', '🏠', 'Inicio'], ['calendario', '🗓️', 'Calendario'], ['menu', '🍽️', 'Menú'], ['mas', '⚙️', 'Más']];

function marco() {
  const titulo = { inicio: 'Organizapp', calendario: 'Calendario', menu: 'Menú', mas: 'Más' }[S.tab];
  const fechaFab = S.tab === 'calendario' ? S.diaSel : (S.inicioDia === 'hoy' ? hoyISO() : sumarDias(hoyISO(), 1));
  return el('div', { class: 'marco' },
    el('header', { class: 'cab' },
      el('div', { class: 'cab-titulo' },
        el('img', { src: 'icons/logo-cabecera.png', alt: '', width: 32, height: 32, class: 'logo-cab' }),
        el('h1', {}, titulo),
        el('span', { class: 'version', title: 'Versión de la app' }, `v${S.version}`)),
      selectorCalendario(),
      S.tab === 'mas' ? null : capasChips()),
    el('main', { id: 'contenido', class: 'contenido' }, S.cargandoDatos ? el('p', { class: 'vacio' }, 'Cargando…') : vistaActual()),
    el('nav', { class: 'tabs', 'aria-label': 'Secciones' },
      TABS.map(([id, ico, nom]) => el('button', { type: 'button', 'aria-current': S.tab === id ? 'page' : null, onclick: () => { S.tab = id; if (id === 'mas') recargarAmistades(); cargarVista(); } },
        el('span', { class: 'ico' }, ico, id === 'mas' && (solicitudesRecibidas().length || S.invitaciones.length) ? el('span', { class: 'punto-aviso', role: 'status', 'aria-label': 'Tienes avisos pendientes' }) : null), el('span', {}, nom)))),
    (S.tab === 'inicio' || S.tab === 'calendario') && !S.cargandoDatos
      ? el('button', { class: 'fab', 'aria-label': 'Añadir evento', onclick: () => abrirEditorEvento({ fecha: fechaFab }) }, '＋') : null);
}

function vistaActual() {
  if (S.tab === 'inicio') return vistaInicio();
  if (S.tab === 'calendario') return vistaCalendario();
  if (S.tab === 'menu') return vistaMenu();
  return vistaMas();
}

// ---------- piezas comunes ----------
function filaEvento({ ev, fecha }, compacta = false) {
  const m = ev.compartido ? { nombre: etiquetaTodos(), color: COLOR_AMBOS } : (miembro(ev.owner_id) || { nombre: '?', color: '#888888' });
  const t = TIPOS.find((x) => x.id === ev.tipo);
  const hora = ev.hora_inicio ? hhmm(ev.hora_inicio) + (ev.hora_fin ? '–' + hhmm(ev.hora_fin) : '') : 'Todo el día';
  return el('button', { type: 'button', class: `fila-evento${compacta ? ' compacta' : ''}`, style: { '--c': m.color }, onclick: () => abrirEditorEvento({ ev, ocurrencia: fecha }) },
    el('span', { class: 'hora' }, hora),
    el('span', { class: 'cuerpo' },
      el('span', { class: 'tit' }, `${t.icono} ${ev.titulo}`, ev.repeticion ? el('span', { class: 'rep', title: 'Se repite cada semana' }, ' ↻') : null),
      ev.notas ? el('span', { class: 'notas' }, ev.notas) : null),
    S.miembros.length > 1 && !compacta ? el('span', { class: 'quien' }, m.nombre) : null);
}

// Lista de eventos de un día. Dos formas:
//  - una sola columna (por defecto), o
//  - (opción de Más) una columna por persona. Con hora: línea de tiempo proporcional, cada evento a su altura y con
//    la altura de su duración, de modo que lo que coincide en el tiempo queda a la misma altura. Los eventos de
//    "todos" ocupan todo el ancho (o salen en cada columna si coinciden con un plan de una persona).
//    Sin hora ("Todo el día"): arriba. Los huecos largos sin nada se recortan para no hacer la pantalla enorme.
const PX_MIN = 1.2;      // píxeles por minuto
const HUECO_MIN = 120;   // un hueco de 2 h o más sin eventos se acorta
const HUECO_PX = 34;
const EJE_PX = 40;       // ancho de la columna de horas
const aMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function rejillaPorHoras(items, cols) { // para eventos sin hora o tareas: una fila por tramo horario
  const hora = (x) => (x.ev.hora_inicio ? hhmm(x.ev.hora_inicio) : '');
  const horas = [...new Set(items.map(hora))].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  return horas.map((h) => {
    const delTramo = items.filter((x) => hora(x) === h);
    const comunes = delTramo.filter((x) => x.ev.compartido);
    const sueltos = delTramo.filter((x) => !x.ev.compartido);
    return el('div', { class: 'cols-tramo' },
      comunes.map((x) => filaEvento(x, true)),
      sueltos.length
        ? el('div', { class: 'cols-fila' }, cols.map((m) => el('div', { class: 'cols-celda' },
          sueltos.filter((x) => x.ev.owner_id === m.id).map((x) => filaEvento(x, true)))))
        : null);
  });
}

function lineaDeTiempo(conHora, cols) {
  const n = cols.length;
  const base = conHora.map((x) => {
    const a = aMin(hhmm(x.ev.hora_inicio));
    const b = Math.max(x.ev.hora_fin ? aMin(hhmm(x.ev.hora_fin)) : a + 45, a + 40); // los muy cortos o sin fin se ven con un mínimo
    return { x, a, b };
  });
  const solapa = (p, q) => p.a < q.b && q.a < p.b;
  const deUnaPersona = base.filter((i) => !i.x.ev.compartido);
  const piezas = [];
  for (const it of base) {
    if (!it.x.ev.compartido) {
      const k = cols.findIndex((m) => m.id === it.x.ev.owner_id);
      if (k >= 0) piezas.push({ ...it, col: k });
    } else if (deUnaPersona.some((p) => solapa(it, p))) cols.forEach((_, k) => piezas.push({ ...it, col: k })); // coincide con un plan: sale en cada columna
    else piezas.push({ ...it, col: 'todos' });
  }

  // carriles: dentro de una misma columna, los que coinciden en el tiempo se reparten el ancho
  const grupos = new Map();
  for (const g of piezas) { const k = String(g.col); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(g); }
  for (const lista of grupos.values()) {
    lista.sort((p, q) => p.a - q.a || p.b - q.b);
    let racimo = [], carriles = [], fin = -1;
    const cerrar = () => { racimo.forEach((g) => { g.total = carriles.length; }); racimo = []; carriles = []; fin = -1; };
    for (const g of lista) {
      if (racimo.length && g.a >= fin) cerrar();
      let c = carriles.findIndex((f) => f <= g.a);
      if (c < 0) { c = carriles.length; carriles.push(0); }
      carriles[c] = g.b; g.carril = c; racimo.push(g); fin = Math.max(fin, g.b);
    }
    if (racimo.length) cerrar();
  }

  // tramos de tiempo con eventos (de hora en hora); los huecos largos se acortan
  const tramos = [];
  for (const g of [...piezas].sort((p, q) => p.a - q.a)) {
    const a = Math.floor(g.a / 60) * 60, b = Math.ceil(g.b / 60) * 60;
    const ult = tramos[tramos.length - 1];
    if (ult && a - ult.b < HUECO_MIN) ult.b = Math.max(ult.b, b); else tramos.push({ a, b });
  }
  let y = 0;
  tramos.forEach((t, i) => { if (i) y += HUECO_PX; t.y = y; y += (t.b - t.a) * PX_MIN; });
  const alto = y;
  const yDe = (min) => { const t = tramos.find((t) => min >= t.a && min <= t.b); return t.y + (min - t.a) * PX_MIN; };
  // Geometría "expandida" (sin huecos acortados, de 6:00 a 24:00 como mínimo): se usa mientras se arrastra un evento
  const E0 = Math.min(360, tramos[0].a), E1 = Math.max(1440, tramos[tramos.length - 1].b);
  const yExp = (min) => (min - E0) * PX_MIN;

  const eje = [], lineas = [];
  tramos.forEach((t, i) => {
    for (let h = t.a; h <= t.b; h += 60) {
      const top = t.y + (h - t.a) * PX_MIN;
      eje.push(el('span', { class: 'tl-hora solo-comp', style: { top: `${top}px` } }, `${pad2(Math.floor(h / 60) % 24)}:00`));
      lineas.push(el('div', { class: 'tl-linea solo-comp', style: { top: `${top}px` } }));
    }
    if (i) eje.push(el('span', { class: 'tl-hueco solo-comp', style: { top: `${tramos[i - 1].y + (tramos[i - 1].b - tramos[i - 1].a) * PX_MIN}px`, height: `${HUECO_PX}px` } }, '⋯'));
  });
  for (let h = E0; h <= E1; h += 60) {
    eje.push(el('span', { class: 'tl-hora solo-exp', style: { top: `${yExp(h)}px` } }, `${pad2(Math.floor(h / 60) % 24)}:00`));
    lineas.push(el('div', { class: 'tl-linea solo-exp', style: { top: `${yExp(h)}px` } }));
  }
  const guias = cols.map((m, k) => el('div', { class: 'col-guia', 'data-col': k, style: { left: `${(k * 100) / n}%`, width: `calc(${100 / n}% - 4px)`, '--c': m.color } }));

  // ---- arrastrar para mover (mantener pulsado en el móvil; arrastrar directamente con ratón) ----
  const fmtMin = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  function activarArrastre(b, g) {
    const ev = g.x.ev;
    if (!puedeEditarCapa(ev.owner_id)) return; // solo quien puede editar ese evento
    const libreH = !ev.compartido && g.col !== 'todos'; // los de "todos" solo se mueven en el tiempo
    const origen = typeof g.col === 'number' ? g.col : 0;
    const permitidas = new Set();
    cols.forEach((m, k) => { if (libreH ? puedeEditarCapa(m.id) : k === origen) permitidas.add(k); });
    const durReal = ev.hora_fin ? aMin(hhmm(ev.hora_fin)) - aMin(hhmm(ev.hora_inicio)) : 0;
    const durVis = g.b - g.a;
    const st = { id: null, activo: false, timer: 0, x0: 0, y0: 0, cx: 0, cy: 0, tipo: '', min: g.a, col: origen, raf: 0, hubo: false };
    let tl, cuerpo, baseTop, tlTop, colW, grab, horaEl;

    const empezar = () => {
      if (st.activo || st.id === null) return;
      clearTimeout(st.timer);
      st.activo = true;
      try { b.setPointerCapture(st.id); } catch { /* sin captura */ }
      if (navigator.vibrate) navigator.vibrate(15);
      tl = b.closest('.tl'); cuerpo = tl.querySelector('.tl-cols'); horaEl = b.querySelector('.hora');
      const antes = b.getBoundingClientRect().top;
      tl.classList.add('expandido');
      document.body.classList.add('arrastrando');
      b.classList.add('arrastrando');
      window.scrollBy(0, b.getBoundingClientRect().top - antes); // el evento se queda bajo el dedo
      const rb = b.getBoundingClientRect(), rc = cuerpo.getBoundingClientRect();
      baseTop = rb.top + window.scrollY; tlTop = rc.top + window.scrollY; colW = rc.width / n;
      grab = Math.min(Math.max(st.cy - rb.top, 0), rb.height);
      tl.querySelectorAll('.col-guia').forEach((gd, k) => gd.classList.toggle('no', libreH && !permitidas.has(k)));
      bucle();
    };

    const bucle = () => {
      if (!st.activo) return;
      const sup = document.querySelector('.cab').getBoundingClientRect().bottom;
      const inf = document.querySelector('.tabs').getBoundingClientRect().top;
      if (st.cy < sup + 50) window.scrollBy(0, -Math.min(18, (sup + 50 - st.cy) / 3));
      else if (st.cy > inf - 50) window.scrollBy(0, Math.min(18, (st.cy - (inf - 50)) / 3));
      const topDoc = st.cy + window.scrollY - grab;
      let min = Math.round((E0 + (topDoc - tlTop) / PX_MIN) / 15) * 15;
      min = Math.max(E0, Math.min(min, Math.min(E1, 1440) - Math.max(durReal, 15)));
      st.min = min;
      let k = origen;
      if (libreH) {
        const kk = Math.max(0, Math.min(n - 1, Math.floor((st.cx - cuerpo.getBoundingClientRect().left) / colW)));
        if (permitidas.has(kk)) k = kk;
        tl.querySelectorAll('.col-guia').forEach((gd, j) => gd.classList.toggle('destino', j === k));
      }
      st.col = k;
      b.style.transform = `translate(${(k - origen) * colW}px, ${tlTop + yExp(min) - baseTop}px)`;
      if (horaEl) horaEl.textContent = durReal ? `${fmtMin(min)}–${fmtMin(min + durReal)}` : fmtMin(min);
      st.raf = requestAnimationFrame(bucle);
    };

    const terminar = (guardar) => {
      cancelAnimationFrame(st.raf);
      clearTimeout(st.timer);
      const eraActivo = st.activo;
      st.activo = false;
      const id = st.id; st.id = null;
      if (!eraActivo) return;
      try { b.releasePointerCapture(id); } catch { /* ya liberado */ }
      st.hubo = true; setTimeout(() => { st.hubo = false; }, 400); // el "clic" que sigue al soltar no abre el editor
      b.style.transform = '';
      b.classList.remove('arrastrando');
      document.body.classList.remove('arrastrando');
      const antes = b.getBoundingClientRect().top;
      tl.classList.remove('expandido');
      window.scrollBy(0, b.getBoundingClientRect().top - antes);
      tl.querySelectorAll('.col-guia').forEach((gd) => gd.classList.remove('destino', 'no'));
      if (horaEl) horaEl.textContent = ev.hora_inicio ? hhmm(ev.hora_inicio) + (ev.hora_fin ? '–' + hhmm(ev.hora_fin) : '') : '';
      if (!guardar) return;
      const cambioHora = st.min !== g.a;
      const nuevoDueno = libreH ? cols[st.col].id : ev.owner_id;
      const cambioDueno = nuevoDueno !== ev.owner_id;
      if (!cambioHora && !cambioDueno) return;
      const campos = {};
      if (cambioHora) { campos.hora_inicio = fmtMin(st.min); campos.hora_fin = ev.hora_fin ? fmtMin(st.min + durReal) : null; }
      if (cambioDueno) campos.owner_id = nuevoDueno;
      const nombreDestino = cols[st.col].nombre;
      const mensaje = cambioDueno ? `Pasado a ${nombreDestino}${cambioHora ? ` a las ${fmtMin(st.min)}` : ''}` : `Movido a las ${fmtMin(st.min)}`;
      const fechaOcurr = g.x.fecha;
      const aplicar = (alcance) => conCarga(null, async () => {
        if (alcance === 'uno') {
          // este día solo: se quita de la serie y se crea un evento suelto con el cambio
          await D.guardarEvento(ev.id, { excepciones: [...new Set([...(ev.excepciones || []), fechaOcurr])] });
          await D.crearEventos([{
            espacio_id: ev.espacio_id, owner_id: nuevoDueno, tipo: ev.tipo, titulo: ev.titulo, fecha: fechaOcurr,
            hora_inicio: campos.hora_inicio ?? ev.hora_inicio ?? null, hora_fin: 'hora_fin' in campos ? campos.hora_fin : (ev.hora_fin ?? null),
            notas: ev.notas ?? null, compartido: !!ev.compartido, creado_por: S.user.id,
          }]);
        } else await D.guardarEvento(ev.id, campos);
        aviso(mensaje);
        await cargarVista(true);
      });
      if (!ev.repeticion) { aplicar('serie'); return; }
      const semanas = ev.repite_hasta ? Math.floor(diffDias(ev.repite_hasta, ev.fecha) / 7) + 1 : null;
      let elegido = false;
      const cerrarPregunta = modal('Evento que se repite', el('div', { class: 'formulario' },
        el('p', {}, `«${ev.titulo}» se repite cada semana. ¿Qué quieres mover?`),
        el('div', { class: 'fila-botones columna' },
          el('button', { type: 'button', class: 'primario', onclick: () => { elegido = true; cerrarPregunta(); aplicar('uno'); } }, `Solo el ${fechaCorta(fechaOcurr)}`),
          el('button', { type: 'button', onclick: () => { elegido = true; cerrarPregunta(); aplicar('serie'); } },
            semanas ? `Toda la serie (${semanas} semanas, hasta el ${fechaCorta(ev.repite_hasta)})` : 'Toda la serie (todas las semanas)'),
          el('button', { type: 'button', onclick: () => cerrarPregunta() }, 'Cancelar'))),
        () => { if (!elegido) cargarVista(true); });
    };

    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || st.id !== null) return;
      st.id = e.pointerId; st.tipo = e.pointerType; st.x0 = st.cx = e.clientX; st.y0 = st.cy = e.clientY;
      if (e.pointerType !== 'mouse') st.timer = setTimeout(empezar, 450);
    });
    b.addEventListener('pointermove', (e) => {
      if (e.pointerId !== st.id) return;
      st.cx = e.clientX; st.cy = e.clientY;
      if (st.activo) return;
      const d = Math.hypot(e.clientX - st.x0, e.clientY - st.y0);
      if (st.tipo === 'mouse') { if (d > 5) empezar(); } else if (d > 10) { clearTimeout(st.timer); st.id = null; } // es un desplazamiento normal
    });
    b.addEventListener('pointerup', (e) => { if (e.pointerId === st.id) { if (st.activo) terminar(true); else { clearTimeout(st.timer); st.id = null; } } });
    b.addEventListener('pointercancel', (e) => { if (e.pointerId === st.id) { if (st.activo) terminar(false); else { clearTimeout(st.timer); st.id = null; } } });
    b.addEventListener('touchmove', (e) => { if (st.activo) e.preventDefault(); }, { passive: false });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { if (st.hubo) { e.preventDefault(); e.stopImmediatePropagation(); st.hubo = false; } }, true);
  }

  const eventos = piezas.map((g) => {
    const b = filaEvento(g.x, true);
    b.classList.add('tl-ev');
    const ancho = g.col === 'todos' ? 100 / g.total : 100 / (n * g.total);
    const izq = g.col === 'todos' ? (g.carril * 100) / g.total : ((g.col + g.carril / g.total) * 100) / n;
    Object.assign(b.style, { height: `${yDe(g.b) - yDe(g.a) - 2}px`, left: `${izq}%`, width: `calc(${ancho}% - 4px)` });
    b.style.setProperty('--t', `${yDe(g.a)}px`);
    b.style.setProperty('--te', `${yExp(g.a)}px`);
    activarArrastre(b, g);
    return b;
  });

  return el('div', { class: 'tl', style: { '--alto': `${alto}px`, '--alto-e': `${(E1 - E0) * PX_MIN}px` } },
    el('div', { class: 'tl-eje' }, eje),
    el('div', { class: 'tl-cols' }, guias, lineas, eventos));
}

function agendaEventos(lista, vacio, proporcional = true) {
  if (!lista.length) return el('p', { class: 'vacio' }, vacio);
  const cols = visiblesCapas();
  if (S.vista !== 'columnas' || cols.length < 2 || cols.length > 3) return lista.map((x) => filaEvento(x));
  const cab = el('div', { class: 'cols-fila cols-cab' }, cols.map((m) => el('span', { class: 'cols-nombre', style: { '--c': m.color } }, el('span', { class: 'punto' }), m.nombre)));
  if (!proporcional) return el('div', { class: 'agenda-cols', style: { '--n': cols.length } }, cab, rejillaPorHoras(lista, cols));
  const sinHora = lista.filter((x) => !x.ev.hora_inicio), conHora = lista.filter((x) => x.ev.hora_inicio);
  return el('div', { class: 'agenda-cols agenda-tl', style: { '--n': cols.length } },
    cab,
    sinHora.length ? el('div', { class: 'tl-todo-dia' }, el('span', { class: 'tl-hora-fija' }, 'Todo el día'), rejillaPorHoras(sinHora, cols)) : null,
    conHora.length ? lineaDeTiempo(conHora, cols) : null);
}

function chipsTipos(set, clave) {
  return el('div', { class: 'chips tipos', role: 'group', 'aria-label': 'Tipos de evento' },
    TIPOS.map((t) => el('button', {
      type: 'button', class: 'chip-tipo', 'aria-pressed': String(set.has(t.id)),
      onclick: () => {
        if (set.has(t.id)) { if (set.size > 1) set.delete(t.id); } else set.add(t.id);
        guardarLocal(clave, [...set]); render();
      },
    }, `${t.icono} ${t.nombre}`)));
}

function bloquePersonaMenu(fecha, m) {
  const filas = FRANJAS.map((f) => ({ f, r: S.menuMap.get(claveMenu(fecha, m.id, f.id)) })).filter((x) => x.r);
  return el('div', {
    class: 'persona', style: { '--c': m.color }, role: 'button', tabIndex: 0,
    onclick: () => abrirEditorMenu({ fecha, ownerId: m.id }),
    onkeydown: (e) => { if (e.key === 'Enter') abrirEditorMenu({ fecha, ownerId: m.id }); },
  },
    S.miembros.length > 1 ? el('div', { class: 'persona-nombre' }, m.nombre) : null,
    filas.length
      ? filas.map(({ f, r }) => el('div', { class: 'franja' },
        el('span', { class: 'franja-n' }, f.nombre + (r.hora ? ` · ${hhmm(r.hora)}` : '')),
        el('span', { class: 'franja-t' }, r.texto)))
      : el('div', { class: 'vacio' }, puedeEditarCapa(m.id) ? 'Sin menú · toca para añadir' : 'Sin menú'));
}

function bloqueMenuDia(fecha, titulo) {
  const vis = visiblesCapas();
  return el('section', { class: 'seccion' },
    el('h3', {}, titulo),
    vis.map((m) => bloquePersonaMenu(fecha, m)));
}

// ---------- vista: Inicio (hoy / mañana) ----------
function vistaInicio() {
  const hoy = hoyISO();
  const manana = sumarDias(hoy, 1);
  const esManana = S.inicioDia === 'manana';
  const dia = esManana ? manana : hoy;
  const mapa = expandirEventos(S.eventos.filter(eventoVisible), hoy, manana);
  const delDia = (mapa.get(dia) || []).filter((x) => S.tiposInicio.has(x.ev.tipo));
  const tareasHoy = (mapa.get(hoy) || []).filter((x) => x.ev.tipo === 'tarea');

  return el('div', {},
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Día' },
      [['hoy', 'Hoy'], ['manana', 'Mañana']].map(([id, nom]) =>
        el('button', { type: 'button', 'aria-pressed': String(S.inicioDia === id), onclick: () => { S.inicioDia = id; render(); } }, nom))),
    el('h2', { class: 'fecha-grande' }, cap(fechaLarga(dia))),
    (S.miembros.length === 1 && S.relacion === 'pareja' && S.espacios.length === 1) ? el('div', { class: 'tarjeta aviso-invitar' },
      el('p', {}, 'Ahora mismo estás solo en este calendario.'),
      el('button', { class: 'primario', onclick: () => { S.tab = 'mas'; render(); } }, 'Invitar a tu pareja')) : null,
    esManana ? el('section', { class: 'seccion preparar' },
      el('h3', {}, '🛠️ Para dejar preparado hoy'),
      agendaEventos(tareasHoy, 'Nada que preparar hoy.', false)) : null,
    bloqueMenuDia(dia, `🍽️ Comida de ${esManana ? 'mañana' : 'hoy'}`),
    el('section', { class: 'seccion' },
      el('h3', {}, `🗓️ Agenda de ${esManana ? 'mañana' : 'hoy'}`),
      chipsTipos(S.tiposInicio, 'tipos_inicio'),
      agendaEventos(delDia, 'Nada planificado.')));
}

// ---------- vista: Calendario ----------
function vistaCalendario() {
  const cambiar = (v) => {
    if (S.calVista === v) return;
    S.calVista = v; guardarLocal('cal_vista', v);
    if (v === 'semana') S.semanaCal = inicioSemana(S.diaSel);
    else S.mes = { y: Number(S.diaSel.slice(0, 4)), m: Number(S.diaSel.slice(5, 7)) };
    cargarVista();
  };
  return el('div', {},
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Ver por' },
      [['mes', 'Mes'], ['semana', 'Semana']].map(([id, nom]) =>
        el('button', { type: 'button', 'aria-pressed': String(S.calVista === id), onclick: () => cambiar(id) }, nom))),
    S.calVista === 'semana' ? vistaSemana() : vistaMes());
}

// Resumen del menú de un día: una línea por persona con su comida y su cena.
function resumenMenuDia(dia) {
  const filas = visiblesCapas().map((m) => {
    const partes = ['comida', 'cena'].map((f) => S.menuMap.get(claveMenu(dia, m.id, f))).filter(Boolean).map((r) => primeraLinea(r.texto));
    return partes.length ? el('div', { class: 'menu-resumen', style: { '--c': m.color } }, el('span', { class: 'punto' }), partes.join(' · ')) : null;
  }).filter(Boolean);
  return filas.length ? el('div', { class: 'menu-dia-sem' }, el('span', { class: 'suave' }, '🍽️'), el('div', {}, filas)) : null;
}

function vistaSemana() {
  const hoy = hoyISO();
  const dias = Array.from({ length: 7 }, (_, i) => sumarDias(S.semanaCal, i));
  const mapa = expandirEventos(S.eventos.filter((e) => eventoVisible(e) && S.tipos.has(e.tipo)), dias[0], dias[6]);
  const irSemana = (n) => {
    S.semanaCal = sumarDias(S.semanaCal, 7 * n);
    S.diaSel = (hoy >= S.semanaCal && hoy <= sumarDias(S.semanaCal, 6)) ? hoy : S.semanaCal;
    cargarVista();
  };
  return el('div', {},
    el('div', { class: 'barra-nav' },
      el('button', { type: 'button', class: 'icono', 'aria-label': 'Semana anterior', onclick: () => irSemana(-1) }, '‹'),
      el('h2', {}, `${fechaCorta(dias[0])} – ${fechaCorta(dias[6])}`),
      el('button', { type: 'button', class: 'icono', 'aria-label': 'Semana siguiente', onclick: () => irSemana(1) }, '›'),
      el('button', { type: 'button', class: 'pequeno', onclick: () => { S.semanaCal = inicioSemana(hoy); S.diaSel = hoy; cargarVista(); } }, 'Hoy')),
    chipsTipos(S.tipos, 'tipos'),
    dias.map((dia) => {
      const lista = mapa.get(dia) || [];
      return el('section', { class: `dia-sem${dia === hoy ? ' hoy' : ''}${dia === S.diaSel ? ' sel' : ''}`, 'data-dia': dia },
        el('button', { type: 'button', class: 'dia-sem-cab', 'aria-label': `Elegir ${fechaLarga(dia)}`, onclick: () => { S.diaSel = dia; render(); } },
          el('span', { class: 'dia-sem-nombre' }, `${cap(nombreDiaCorto(diaSemana(dia)))} ${Number(dia.slice(8))}`),
          el('span', { class: 'suave' }, lista.length ? `${lista.length} ${lista.length === 1 ? 'evento' : 'eventos'}` : 'Libre')),
        lista.map((x) => filaEvento(x)),
        resumenMenuDia(dia));
    }));
}

function vistaMes() {
  const { y, m } = S.mes;
  const hoy = hoyISO();
  const semanas = rejillaMes(y, m);
  const desde = semanas[0][0], hasta = semanas[semanas.length - 1][6];
  const filtrados = S.eventos.filter((e) => eventoVisible(e) && S.tipos.has(e.tipo));
  const mapa = expandirEventos(filtrados, desde, hasta);
  const delDia = mapa.get(S.diaSel) || [];

  const irMes = (n) => {
    S.mes = sumarMeses(y, m, n);
    const hoyEnMes = hoy.slice(0, 7) === `${S.mes.y}-${String(S.mes.m).padStart(2, '0')}`;
    S.diaSel = hoyEnMes ? hoy : `${S.mes.y}-${String(S.mes.m).padStart(2, '0')}-01`;
    cargarVista();
  };

  return el('div', {},
    el('div', { class: 'barra-nav' },
      el('button', { type: 'button', class: 'icono', 'aria-label': 'Mes anterior', onclick: () => irMes(-1) }, '‹'),
      el('h2', {}, `${cap(nombreMes(m))} ${y}`),
      el('button', { type: 'button', class: 'icono', 'aria-label': 'Mes siguiente', onclick: () => irMes(1) }, '›'),
      el('button', { type: 'button', class: 'pequeno', onclick: () => {
        S.mes = { y: Number(hoy.slice(0, 4)), m: Number(hoy.slice(5, 7)) }; S.diaSel = hoy; cargarVista();
      } }, 'Hoy')),
    chipsTipos(S.tipos, 'tipos'),
    el('div', { class: 'mes', role: 'grid' },
      ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => el('div', { class: 'cab-dia', role: 'columnheader' }, d)),
      semanas.flat().map((dia) => {
        const lista = mapa.get(dia) || [];
        const fuera = Number(dia.slice(5, 7)) !== m;
        return el('button', {
          type: 'button', role: 'gridcell',
          class: `dia${fuera ? ' fuera' : ''}${dia === hoy ? ' hoy' : ''}${dia === S.diaSel ? ' sel' : ''}`,
          'aria-label': `${fechaLarga(dia)}, ${lista.length} eventos`,
          onclick: () => { S.diaSel = dia; render(); },
        },
          el('span', { class: 'num' }, Number(dia.slice(8))),
          lista.slice(0, 3).map(({ ev }) => el('span', { class: 'chip', style: { '--c': colorEv(ev) } }, ev.titulo)),
          lista.length > 3 ? el('span', { class: 'mas' }, `+${lista.length - 3}`) : null);
      })),
    el('section', { class: 'agenda' },
      el('h2', { class: 'fecha-grande' }, cap(fechaLarga(S.diaSel))),
      agendaEventos(delDia, 'Nada planificado este día.'),
      bloqueMenuDia(S.diaSel, '🍽️ Comida')));
}

// ---------- vista: Menú (por semanas) ----------
function vistaMenu() {
  const hoy = hoyISO();
  const dias = Array.from({ length: 7 }, (_, i) => sumarDias(S.semana, i));
  const vis = visiblesCapas();
  const irSemana = (n) => { S.semana = sumarDias(S.semana, 7 * n); cargarVista(); };

  return el('div', {},
    el('div', { class: 'barra-nav' },
      el('button', { type: 'button', class: 'icono', 'aria-label': 'Semana anterior', onclick: () => irSemana(-1) }, '‹'),
      el('h2', {}, `${fechaCorta(dias[0])} – ${fechaCorta(dias[6])}`),
      el('button', { type: 'button', class: 'icono', 'aria-label': 'Semana siguiente', onclick: () => irSemana(1) }, '›'),
      el('button', { type: 'button', class: 'pequeno', onclick: () => { S.semana = inicioSemana(hoy); cargarVista(); } }, 'Hoy')),
    el('div', { class: 'fila-botones' },
      el('button', { type: 'button', onclick: () => abrirRepetir() }, '🔁 Repetir semanas')),
    dias.map((dia) => {
      const franjas = FRANJAS.filter((f) => vis.some((m) => S.menuMap.has(claveMenu(dia, m.id, f.id))));
      const primeraEditable = vis.find((m) => puedeEditarCapa(m.id)) || vis[0];
      return el('section', { class: `dia-menu${dia === hoy ? ' hoy' : ''}` },
        el('h3', {}, `${cap(nombreDiaCorto(diaSemana(dia)))} ${Number(dia.slice(8))}`),
        franjas.length
          ? el('div', { class: 'tabla-menu', style: { '--cols': vis.length } },
            franjas.map((f) => [
              el('div', { class: 'franja-etq' }, f.nombre),
              vis.map((m) => {
                const r = S.menuMap.get(claveMenu(dia, m.id, f.id));
                return el('div', {
                  class: `celda${r ? '' : ' vacia'}`, style: { '--c': m.color }, role: 'button', tabIndex: 0,
                  onclick: () => abrirEditorMenu({ fecha: dia, ownerId: m.id }),
                  onkeydown: (e) => { if (e.key === 'Enter') abrirEditorMenu({ fecha: dia, ownerId: m.id }); },
                }, r ? [
                  r.hora ? el('span', { class: 'h' }, hhmm(r.hora)) : null,
                  el('span', { class: 't' }, r.texto.split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''),
                  r.texto.split('\n').filter((s) => s.trim()).length > 1 ? el('span', { class: 'masl' }, ` +${r.texto.split('\n').filter((s) => s.trim()).length - 1}`) : null,
                ] : '—');
              }),
            ]))
          : el('button', { type: 'button', class: 'vacio-menu', onclick: () => abrirEditorMenu({ fecha: dia, ownerId: primeraEditable.id }) }, 'Sin menú · toca para añadir'));
    }));
}

// ---------- vista: Más ----------
// ---------- amigos ----------
const solicitudesRecibidas = () => (S.amistades || []).filter((a) => a.estado === 'pendiente' && a.direccion === 'recibida');
const verCodigo = (c) => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : '');

async function recargarAmistades(pintar = true) {
  if (!S.user || S.amistades === null) return; // sin sesión, o la base aún no tiene el cambio 3
  try {
    const nuevas = await D.misAmistades();
    const cambio = JSON.stringify(nuevas) !== JSON.stringify(S.amistades);
    S.amistades = nuevas;
    if (cambio && pintar && !document.querySelector('#modales .modal')) render();
  } catch { /* sin conexión: se queda lo que había */ }
}

function tarjetaAmigos() {
  if (S.amistades === null) return null;
  const codigo = S.perfil?.codigo_amigo || '';
  const codigoIn = el('input', { type: 'text', placeholder: 'XXXX-XXXX', autocomplete: 'off', autocapitalize: 'characters', maxLength: 12, 'aria-label': 'Código de amigo a buscar', class: 'entrada-codigo' });
  const resultado = el('div', { class: 'amigo-resultado', 'aria-live': 'polite' });
  const refrescar = async () => { S.amistades = await D.misAmistades(); render(); };

  const mostrar = (r) => {
    resultado.replaceChildren();
    if (!r) { resultado.append(el('p', { class: 'suave' }, 'No hay nadie con ese código. Revisa que esté bien escrito.')); return; }
    const caja = (...hijos) => resultado.append(el('div', { class: 'amigo-fila' }, ...hijos));
    if (r.estado === 'amigos') caja(el('span', {}, `${r.nombre}: ya sois amigos`));
    else if (r.estado === 'enviada') caja(el('span', {}, `${r.nombre}: ya le enviaste una solicitud`));
    else caja(el('span', {}, r.estado === 'recibida' ? `${r.nombre} ya te había enviado una solicitud` : r.nombre),
      el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
        await D.pedirAmistad(codigoIn.value);
        aviso(r.estado === 'recibida' ? 'Ya sois amigos' : 'Solicitud enviada');
        await refrescar();
      }) }, r.estado === 'recibida' ? 'Aceptar' : 'Enviar solicitud'));
  };

  const recibidas = solicitudesRecibidas();
  const enviadas = (S.amistades || []).filter((a) => a.estado === 'pendiente' && a.direccion === 'enviada');
  const amigos = (S.amistades || []).filter((a) => a.estado === 'aceptada');
  const accion = (texto, fn, clase = 'enlace') => el('button', { class: clase, onclick: (e) => conCarga(e.currentTarget, async () => { await fn(); await refrescar(); }) }, texto);

  return el('section', { class: 'tarjeta', id: 'amigos' },
    el('h2', {}, 'Amigos'),
    el('span', { class: 'etq' }, 'Tu código de amigo'),
    el('div', { class: 'codigo-amigo', 'aria-label': `Tu código de amigo es ${verCodigo(codigo)}` }, verCodigo(codigo)),
    el('p', { class: 'suave' }, 'Dáselo a quien quieras que te encuentre. Con él pueden pedirte amistad y ver tu nombre; nada más. Tú decides si aceptas.'),
    el('div', { class: 'fila-botones' },
      el('button', { onclick: async () => {
        try { await navigator.clipboard.writeText(verCodigo(codigo)); aviso('Código copiado'); } catch { aviso('No se pudo copiar.', true); }
      } }, '📋 Copiar'),
      el('button', { onclick: async () => {
        const texto = `Mi código de amigo en Organizapp: ${verCodigo(codigo)}\n${location.origin + location.pathname}`;
        try { if (navigator.share) await navigator.share({ text: texto }); else { await navigator.clipboard.writeText(texto); aviso('Mensaje copiado'); } } catch { /* cancelado */ }
      } }, '🔗 Compartir'),
      el('button', { onclick: (e) => {
        if (!confirm('Tu código actual dejará de funcionar y se creará otro. Tus amigos actuales no cambian. ¿Cambiarlo?')) return;
        conCarga(e.currentTarget, async () => { S.perfil = { ...S.perfil, codigo_amigo: await D.regenerarCodigo() }; aviso('Código nuevo creado'); render(); });
      } }, '♻️ Cambiar')),
    el('div', { class: 'separador' }),
    el('label', {}, 'Añadir un amigo con su código', codigoIn),
    el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
      const c = codigoIn.value.replace(/[^A-Za-z0-9]/g, '');
      if (c.length !== 8) throw new Error('El código tiene 8 letras y números (XXXX-XXXX).');
      mostrar((await D.buscarCodigo(c))[0] || null);
    }) }, 'Buscar'),
    resultado,
    recibidas.length ? el('div', {},
      el('span', { class: 'etq' }, 'Solicitudes recibidas'),
      el('ul', { class: 'personas' }, recibidas.map((a) => el('li', { class: 'amigo-fila' },
        el('span', {}, a.nombre),
        el('span', { class: 'fila-botones' },
          accion('Aceptar', () => D.responderAmistad(a.id, true), 'primario'),
          accion('Rechazar', () => D.responderAmistad(a.id, false))))))) : null,
    enviadas.length ? el('div', {},
      el('span', { class: 'etq' }, 'Solicitudes enviadas'),
      el('ul', { class: 'personas' }, enviadas.map((a) => el('li', { class: 'amigo-fila' },
        el('span', {}, `${a.nombre} · pendiente`), accion('Cancelar', () => D.quitarAmistad(a.id)))))) : null,
    el('div', {},
      el('span', { class: 'etq' }, 'Tus amigos'),
      amigos.length
        ? el('ul', { class: 'personas' }, amigos.map((a) => el('li', { class: 'amigo-fila' },
          el('span', {}, a.nombre),
          accion('Quitar', async () => { if (confirm(`¿Quitar a ${a.nombre} de tus amigos?`)) await D.quitarAmistad(a.id); }))))
        : el('p', { class: 'suave' }, 'Todavía no tienes amigos añadidos.'),
      el('p', { class: 'suave' }, S.espacio
        ? 'Para compartir un calendario con un amigo, ábrelo arriba y usa «Invitar a un amigo» en su ficha de esta pantalla.'
        : 'Cuando seáis amigos, esa persona podrá invitarte a su calendario y la invitación te saldrá aquí.')));
}

// ---------- ajustes del calendario abierto ----------
function tarjetaCalendario() {
  const esPareja = S.relacion === 'pareja';
  const yo = S.user.id;
  const soyCreador = S.espacio.creado_por === yo;
  const emailIn = el('input', { type: 'email', placeholder: 'correo de Google de tu pareja', autocomplete: 'off', 'aria-label': 'Correo a invitar' });
  const nombreCalIn = el('input', { type: 'text', maxLength: 80, value: S.espacio.nombre, 'aria-label': 'Nombre del calendario' });
  const libres = (S.amistades || []).filter((a) => a.estado === 'aceptada' && !S.miembros.some((m) => m.id === a.otro_id)
    && !S.enviadas.some((i) => i.es_amigo && i.destino === a.nombre));
  const amigoSel = el('select', { 'aria-label': 'Amigo a invitar' }, libres.map((a) => el('option', { value: a.otro_id }, a.nombre)));
  const rolSel = el('select', { 'aria-label': 'Rol del amigo' },
    el('option', { value: 'amigo' }, 'Amigo: ve todo y edita solo lo suyo'),
    el('option', { value: 'pareja' }, 'Pareja: puede editar todo'));
  const rolCorreoSel = el('select', { 'aria-label': 'Rol de la persona invitada por correo' },
    el('option', { value: 'pareja' }, 'Pareja: puede editar todo'),
    el('option', { value: 'amigo' }, 'Amigo: ve todo y edita solo lo suyo'));
  const hayHueco = S.miembros.length < 5;

  return el('section', { class: 'tarjeta', id: 'calendario-ajustes' },
    el('h2', {}, `Calendario «${S.espacio.nombre}»`),
    S.miembros.length === 1 ? el('p', { class: 'suave' }, 'Ahora mismo solo lo ves tú.') : null,
    el('ul', { class: 'personas' }, S.miembros.map((m) => el('li', { class: 'amigo-fila', style: { '--c': m.color } },
      el('span', {}, el('span', { class: 'punto' }), ` ${m.nombre}${m.id === yo ? ' (tú)' : ''}`, soyCreador && m.id !== yo ? null : el('span', { class: 'suave' }, ` · ${etiquetaRol(m.relacion)}`)),
      soyCreador && m.id !== yo
        ? el('select', { class: 'rol-miembro', 'aria-label': `Rol de ${m.nombre}`, onchange: (e) => {
          const sel = e.currentTarget, nuevo = sel.value;
          conCarga(sel, async () => {
            try { await D.cambiarRol(S.espacio.id, m.id, nuevo); } catch (x) { sel.value = m.relacion; throw x; }
            aviso(`${m.nombre} ahora es ${etiquetaRol(nuevo)}`); await cargarTodo();
          });
        } }, el('option', { value: 'pareja', selected: m.relacion === 'pareja' }, 'Pareja'), el('option', { value: 'amigo', selected: m.relacion === 'amigo' }, 'Amigo')) : null,
      esPareja && m.id !== yo && m.id !== S.espacio.creado_por
        ? el('button', { class: 'enlace', onclick: (e) => {
          if (!confirm(`¿Quitar a ${m.nombre} de «${S.espacio.nombre}»? Se borrarán sus eventos y menús en este calendario.`)) return;
          conCarga(e.currentTarget, async () => { await D.quitarMiembro(S.espacio.id, m.id); aviso('Persona quitada'); await cargarTodo(); });
        } }, 'Quitar') : null))),
    esPareja ? el('div', {},
      el('label', {}, 'Nombre del calendario', nombreCalIn),
      el('button', { onclick: (e) => conCarga(e.currentTarget, async () => {
        const n = nombreCalIn.value.trim();
        if (!n) throw new Error('Ponle un nombre al calendario.');
        await D.renombrarEspacio(S.espacio.id, n); aviso('Nombre guardado'); await cargarTodo();
      }) }, 'Cambiar nombre')) : null,
    esPareja && hayHueco ? el('details', { class: 'bloque plegable' },
      el('summary', {}, '¿Aún no tiene la app? Invitar por correo'),
      el('label', {}, 'Correo de Google', emailIn),
      el('label', {}, 'Cómo entra', rolCorreoSel),
      el('p', { class: 'suave' }, 'Escribe el correo de la cuenta con la que entrará. Cuando abra la app con esa cuenta verá la invitación.'),
      el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
        const mail = emailIn.value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('Ese correo no parece válido.');
        if (mail === (S.user.email || '').toLowerCase()) throw new Error('Ese es tu propio correo.');
        await D.invitar(S.espacio.id, mail, rolCorreoSel.value, S.user.id);
        aviso('Invitación creada');
        await cargarTodo();
      }) }, 'Invitar por correo')) : null,
    esPareja && hayHueco && S.amistades !== null ? el('div', { class: 'bloque' },
      el('span', { class: 'etq' }, 'Invitar a un amigo'),
      libres.length ? [
        amigoSel, rolSel,
        el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
          await D.invitarAmigo(S.espacio.id, amigoSel.value, rolSel.value);
          aviso('Invitación enviada');
          await cargarTodo();
        }) }, 'Invitar al calendario'),
      ] : el('p', { class: 'suave' }, (S.amistades || []).some((a) => a.estado === 'aceptada')
        ? 'Todos tus amigos ya están en este calendario o tienen una invitación pendiente.'
        : 'Añade amigos con su código (más abajo) para poder invitarles aquí sin pedirles el correo.')) : null,
    esPareja && !hayHueco ? el('p', { class: 'suave' }, 'Este calendario ya tiene 5 personas, el máximo.') : null,
    esPareja && S.enviadas.length ? el('div', { class: 'bloque' },
      el('span', { class: 'etq' }, 'Invitaciones pendientes'),
      el('ul', { class: 'personas' }, S.enviadas.map((i) => el('li', { class: 'amigo-fila' },
        el('span', {}, `${i.destino} · ${etiquetaRol(i.relacion)}`),
        el('button', { class: 'enlace', onclick: (e) => conCarga(e.currentTarget, async () => { await D.borrarInvitacion(i.id); await cargarTodo(); }) }, 'Quitar'))))) : null,
    S.espacios.length > 1 ? el('div', { class: 'bloque' },
      el('button', { onclick: () => abrirImportarEventos() }, '📋 Importar mis eventos de otro calendario')) : null,
    el('div', { class: 'bloque' },
      soyCreador
        ? el('button', { class: 'peligro', onclick: (e) => {
          if (!confirm(`¿Borrar «${S.espacio.nombre}»? Se borra para todas las personas, con todos sus eventos y menús. No se puede deshacer.`)) return;
          conCarga(e.currentTarget, async () => { await D.eliminarEspacio(S.espacio.id); aviso('Calendario borrado'); S.espacio = null; await cargarTodo(); });
        } }, 'Borrar este calendario')
        : el('button', { class: 'peligro', onclick: (e) => {
          if (!confirm(`¿Salir de «${S.espacio.nombre}»? Se borrarán tus eventos y menús de este calendario.`)) return;
          conCarga(e.currentTarget, async () => { await D.salirEspacio(S.espacio.id); aviso('Has salido del calendario'); S.espacio = null; await cargarTodo(); });
        } }, 'Salir de este calendario')));
}

function vistaMas() {
  const nombreIn = el('input', { type: 'text', maxLength: 60, value: S.perfil?.nombre || '', 'aria-label': 'Tu nombre' });
  let colorSel = (miembro(S.user.id) || S.perfil || {}).color || PALETA[0];
  const swatches = PALETA.map((c) => el('button', {
    type: 'button', class: 'muestra', style: { '--c': c }, 'aria-label': `Color ${c}`, 'aria-pressed': String(c === colorSel),
    onclick: () => { colorSel = c; swatches.forEach((b, i) => b.setAttribute('aria-pressed', String(PALETA[i] === colorSel))); },
  }));
  const temaSel = el('select', { 'aria-label': 'Aspecto', onchange: () => { guardarLocal('tema', temaSel.value); aplicarTema(); aviso('Ajuste guardado'); } },
    [['auto', 'Automático (como tu móvil)'], ['claro', 'Claro'], ['oscuro', 'Oscuro']].map(([v, n]) => el('option', { value: v, selected: leerLocal('tema', 'auto') === v }, n)));

  const vistaSel = el('select', { 'aria-label': 'Cómo se ve la agenda', onchange: () => { S.vista = vistaSel.value; guardarLocal('vista', S.vista); aviso('Ajuste guardado'); } },
    [['lista', 'Lista (una sola columna)'], ['columnas', 'Una columna por persona']].map(([v, n]) => el('option', { value: v, selected: S.vista === v }, n)));

  return el('div', { class: 'mas' },
    S.invitaciones.length ? el('section', { class: 'tarjeta resaltada', id: 'invitaciones' },
      el('h2', {}, 'Tienes invitaciones'), listaInvitaciones()) : null,
    el('section', { class: 'tarjeta' },
      el('h2', {}, 'Tú'),
      el('label', {}, 'Nombre', nombreIn),
      el('div', {}, el('span', { class: 'etq' }, `Tu color en «${S.espacio.nombre}»`), el('div', { class: 'muestras' }, swatches)),
      el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
        const n = nombreIn.value.trim();
        if (!n) throw new Error('Pon un nombre.');
        if (n !== S.perfil?.nombre) await D.guardarPerfil(S.user.id, { nombre: n });
        if (colorSel !== (miembro(S.user.id) || {}).color) await D.cambiarMiColor(S.espacio.id, colorSel);
        aviso('Guardado');
        await cargarTodo();
      }) }, 'Guardar')),
    tarjetaCalendario(),
    tarjetaAmigos(),
    el('section', { class: 'tarjeta' },
      el('h2', {}, 'Menú'),
      el('p', { class: 'suave' }, 'Importa comidas desde un Excel. Descarga la plantilla, rellénala y súbela.'),
      el('div', { class: 'fila-botones' },
        el('button', { onclick: () => abrirImportar() }, '📥 Importar menú'),
        el('button', { onclick: () => descargarPlantilla() }, '📄 Descargar plantilla'))),
    el('section', { class: 'tarjeta' },
      el('h2', {}, 'La app'),
      el('label', {}, 'Aspecto', temaSel),
      el('label', {}, 'Cómo se ve la agenda', vistaSel),
      botonInstalar(),
      el('div', { class: 'fila-botones' },
        el('button', { onclick: async () => {
          const url = location.origin + location.pathname;
          try {
            if (navigator.share) await navigator.share({ title: 'Organizapp', url });
            else { await navigator.clipboard.writeText(url); aviso('Enlace copiado'); }
          } catch { /* cancelado */ }
        } }, '🔗 Compartir enlace'),
        el('button', { onclick: async () => {
          try { const reg = await navigator.serviceWorker.getRegistration(); await reg?.update(); aviso('Buscando actualización…'); } catch { aviso('No se pudo comprobar.', true); }
        } }, '🔄 Buscar actualización')),
      el('p', { class: 'suave' }, 'Versión ', el('span', { class: 'version-txt' }, S.version)),
      el('button', { class: 'peligro', onclick: () => D.cerrarSesion() }, 'Cerrar sesión'),
      enlacesLegales()));
}

// ---------- instalar como app ----------
const estaInstalada = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function botonInstalar() {
  if (estaInstalada()) return el('p', { class: 'suave' }, '✅ Estás usando la app instalada.');
  return el('div', { class: 'fila-botones' }, el('button', { class: 'primario', onclick: async () => {
    if (S.instalar) {
      const ev = S.instalar; S.instalar = null;
      try { await ev.prompt(); await ev.userChoice; } catch { /* cancelado */ }
      render();
      return;
    }
    const cerrar = modal('Instalar la app', el('div', { class: 'formulario' },
      el('p', {}, 'Tu navegador no ofrece la instalación con un solo toque ahora mismo. Puedes hacerlo a mano:'),
      el('p', {}, el('strong', {}, 'Android (Chrome): '), 'menú ⋮ → «Instalar aplicación» (o «Añadir a pantalla de inicio»).'),
      el('p', {}, el('strong', {}, 'iPhone (Safari): '), 'botón Compartir → «Añadir a pantalla de inicio».'),
      el('p', { class: 'suave' }, 'Si Chrome dice que ya está instalada pero no la encuentras, mira en Ajustes → Aplicaciones si hay una instalación a medias y desinstálala.'),
      el('div', { class: 'fila-botones fin' }, el('button', { type: 'button', onclick: () => cerrar() }, 'Entendido'))));
  } }, '📲 Instalar en este móvil'));
}

function ponerVersion(v) {
  if (!v || v === S.version) return;
  S.version = String(v);
  document.querySelectorAll('.version').forEach((n) => { n.textContent = `v${S.version}`; });
  document.querySelectorAll('.version-txt').forEach((n) => { n.textContent = S.version; });
}

// Si el service worker aún no ha contestado, se lee la versión publicada en sw.js.
async function leerVersionPublicada() {
  try {
    const t = await (await fetch('sw.js', { cache: 'no-store' })).text();
    const m = t.match(/const VERSION = '([^']+)'/);
    if (m) ponerVersion(m[1]);
  } catch { /* sin conexión: se queda como está */ }
}

// ---------- editor de eventos ----------
function abrirEditorEvento({ ev = null, fecha = null, ocurrencia = null }) {
  const nuevo = !ev;
  const editable = nuevo || puedeEditarCapa(ev.owner_id);
  let tipo = ev?.tipo || 'plan';
  let para = ev ? (ev.compartido ? 'todos' : ev.owner_id) : S.user.id; // id de persona o 'todos'

  const tipoBtns = TIPOS.map((t) => el('button', {
    type: 'button', class: 'tipo-btn', 'aria-pressed': String(t.id === tipo), disabled: !editable,
    onclick: () => { tipo = t.id; tipoBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(TIPOS[i].id === tipo))); },
  }, el('span', { class: 'ico' }, t.icono), t.nombre));

  const titulo = el('input', { type: 'text', maxLength: 120, placeholder: 'Ej.: Pilates, Cine, Hacer la crema', value: ev?.titulo || '', disabled: !editable, 'aria-label': 'Título' });
  const fechaIn = el('input', { type: 'date', value: ev ? ev.fecha : (fecha || hoyISO()), disabled: !editable, 'aria-label': 'Fecha' });
  const iniIn = el('input', { type: 'time', value: hhmm(ev?.hora_inicio), disabled: !editable, 'aria-label': 'Hora de inicio' });
  const finIn = el('input', { type: 'time', value: hhmm(ev?.hora_fin), disabled: !editable, 'aria-label': 'Hora de fin' });
  const repSel = el('select', { disabled: !editable, 'aria-label': 'Repetición', onchange: () => { hastaWrap.hidden = repSel.value !== 'semanal'; } },
    [['', 'No se repite'], ['semanal', 'Cada semana']].map(([v, n]) => el('option', { value: v, selected: (ev?.repeticion || '') === v }, n)));
  const hastaIn = el('input', { type: 'date', value: ev?.repite_hasta || '', disabled: !editable, 'aria-label': 'Repetir hasta' });
  const hastaWrap = el('label', { hidden: (ev?.repeticion || '') !== 'semanal' }, 'Repetir hasta (opcional)', hastaIn);
  const notasIn = el('textarea', { rows: 2, maxLength: 1000, placeholder: 'Notas (opcional)', disabled: !editable, 'aria-label': 'Notas', value: ev?.notas || '' });

  // Al crear: copiar también a otros calendarios tuyos (como evento tuyo), para no apuntarlo dos veces.
  const otrosCals = nuevo ? S.espacios.filter((e) => e.id !== S.espacio.id) : [];
  const copiasChk = otrosCals.map(() => el('input', { type: 'checkbox' }));
  const copiasUI = otrosCals.length ? el('fieldset', { class: 'copiar-a' },
    el('legend', {}, 'Añadir también a (como evento tuyo)'),
    otrosCals.map((e, i) => el('label', { class: 'check-fila' }, copiasChk[i], el('span', {}, e.nombre)))) : null;

  let quienUI = null;
  if (S.miembros.length > 1) {
    if (editable) {
      const opciones = [...editables().map((m) => ({ id: m.id, nombre: m.nombre, color: m.color })), { id: 'todos', nombre: etiquetaTodos(), color: COLOR_AMBOS }];
      const paraBtns = opciones.map((o) => el('button', {
        type: 'button', class: 'chip-capa', 'aria-pressed': String(o.id === para), style: { '--c': o.color },
        onclick: () => { para = o.id; paraBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(opciones[i].id === para))); },
      }, el('span', { class: 'punto' }), o.nombre));
      quienUI = el('div', { class: 'quien-lista' }, el('span', { class: 'etq' }, 'Para'), el('div', { class: 'chips' }, paraBtns));
    } else quienUI = el('p', {}, el('span', { class: 'etq' }, 'De '), ev.compartido ? etiquetaTodos() : (miembro(ev.owner_id) || { nombre: '?' }).nombre);
  }

  const guardar = (btn) => {
    const t = titulo.value.trim(), f = fechaIn.value, hi = iniIn.value, hf = finIn.value;
    const rep = repSel.value, hasta = hastaIn.value;
    if (!t) return aviso('Ponle un título.', true);
    if (!esFechaISO(f)) return aviso('Elige una fecha.', true);
    if (hf && !hi) return aviso('Si pones hora de fin, pon también la de inicio.', true);
    if (hi && hf && hf < hi) return aviso('La hora de fin es anterior a la de inicio.', true);
    if (rep && hasta && hasta < f) return aviso('«Repetir hasta» es anterior a la fecha.', true);
    const campos = {
      tipo, titulo: t, fecha: f, hora_inicio: hi || null, hora_fin: hf || null,
      notas: notasIn.value.trim() || null, repeticion: rep || null, repite_hasta: rep && hasta ? hasta : null,
      compartido: para === 'todos',
    };
    const owner = para === 'todos' ? (nuevo ? S.user.id : ev.owner_id) : para;
    const destinos = otrosCals.filter((_, i) => copiasChk[i].checked);
    return conCarga(btn, async () => {
      if (nuevo) {
        await D.crearEventos([
          { ...campos, espacio_id: S.espacio.id, owner_id: owner, creado_por: S.user.id },
          ...destinos.map((e) => filaCopia({ ...campos, excepciones: [] }, e.id)),
        ]);
      } else await D.guardarEvento(ev.id, { ...campos, owner_id: owner });
      cerrar();
      aviso(destinos.length ? `Guardado y copiado a ${destinos.map((e) => e.nombre).join(', ')}` : 'Guardado');
      await cargarVista(true);
    });
  };

  const borrar = (btn) => {
    if (ev.repeticion) return abrirBorradoSerie(ev, ocurrencia || ev.fecha, cerrar);
    if (!confirm(`¿Borrar «${ev.titulo}»?`)) return null;
    return conCarga(btn, async () => { await D.borrarEvento(ev.id); cerrar(); aviso('Borrado'); await cargarVista(true); });
  };

  const cuerpo = el('div', { class: 'formulario' },
    !editable ? el('p', { class: 'suave' }, 'Solo lectura: este evento es de otra persona.') : null,
    el('div', { class: 'tipos-fila', role: 'group', 'aria-label': 'Tipo' }, tipoBtns),
    el('label', {}, 'Título', titulo),
    quienUI,
    el('label', {}, ev?.repeticion ? 'Empieza el' : 'Fecha', fechaIn),
    el('div', { class: 'dos' }, el('label', {}, 'Desde', iniIn), el('label', {}, 'Hasta', finIn)),
    el('label', {}, 'Repetir', repSel),
    hastaWrap,
    ev?.repeticion && editable ? el('p', { class: 'suave' }, 'Los cambios se aplican a toda la serie. Para quitar solo un día, usa «Borrar».') : null,
    notasIn,
    copiasUI,
    editable ? el('div', { class: 'fila-botones fin' },
      !nuevo ? el('button', { type: 'button', class: 'peligro', onclick: (e) => borrar(e.currentTarget) }, 'Borrar') : null,
      el('button', { type: 'button', class: 'primario', onclick: (e) => guardar(e.currentTarget) }, 'Guardar')) : null);
  const cerrar = modal(nuevo ? 'Nuevo evento' : (editable ? 'Editar evento' : 'Evento'), cuerpo);
  if (nuevo) setTimeout(() => titulo.focus(), 50);
}

// Una copia de un evento para otro calendario: siempre como evento TUYO (no "de todos").
function filaCopia(src, espacioId) {
  return {
    espacio_id: espacioId, owner_id: S.user.id, creado_por: S.user.id, compartido: false,
    tipo: src.tipo, titulo: src.titulo, fecha: src.fecha, hora_inicio: src.hora_inicio || null, hora_fin: src.hora_fin || null,
    notas: src.notas || null, repeticion: src.repeticion || null, repite_hasta: src.repite_hasta || null, excepciones: src.excepciones || [],
  };
}

// Importa TUS eventos de otro de tus calendarios al que tienes abierto (copias independientes).
function abrirImportarEventos() {
  const otros = S.espacios.filter((e) => e.id !== S.espacio.id);
  if (!otros.length) return aviso('Necesitas otro calendario para importar.', true);
  const clave = (e) => [e.tipo, String(e.titulo).trim().toLowerCase(), e.fecha, hhmm(e.hora_inicio), hhmm(e.hora_fin), e.repeticion || ''].join('|');
  const origenSel = el('select', { 'aria-label': 'Calendario de origen', onchange: () => cargarLista() }, otros.map((e) => el('option', { value: e.id }, e.nombre)));
  const lista = el('div', { class: 'lista-import', 'aria-live': 'polite' });
  const botonImportar = el('button', { type: 'button', class: 'primario', disabled: true });
  const otrasPersonas = S.miembros.filter((m) => m.id !== S.user.id).map((m) => m.nombre);
  let filas = [];

  const actualizar = () => {
    const n = filas.filter((f) => f.chk.checked).length;
    botonImportar.disabled = n === 0;
    botonImportar.textContent = n ? `Importar ${n} ${n === 1 ? 'evento' : 'eventos'}` : 'Importar';
  };
  async function cargarLista() {
    lista.replaceChildren(el('p', { class: 'suave' }, 'Cargando…')); botonImportar.disabled = true; filas = [];
    try {
      const [origen, destino] = await Promise.all([D.eventosDe(origenSel.value, S.user.id), D.eventosDe(S.espacio.id, S.user.id)]);
      const hoy = hoyISO();
      const yaEstan = new Set(destino.map(clave));
      const vigentes = origen
        .filter((e) => !e.compartido && (e.repeticion ? (!e.repite_hasta || e.repite_hasta >= hoy) : e.fecha >= hoy))
        .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.hora_inicio || '').localeCompare(String(b.hora_inicio || '')));
      if (!vigentes.length) { lista.replaceChildren(el('p', { class: 'suave' }, 'No tienes eventos de hoy en adelante en ese calendario.')); return; }
      filas = vigentes.map((ev) => {
        const ya = yaEstan.has(clave(ev));
        const chk = el('input', { type: 'checkbox', checked: !ya, disabled: ya, onchange: actualizar });
        const t = TIPOS.find((x) => x.id === ev.tipo);
        const cuando = ev.repeticion
          ? `Cada semana desde el ${fechaCorta(ev.fecha)}${ev.repite_hasta ? ` hasta el ${fechaCorta(ev.repite_hasta)}` : ''}`
          : cap(fechaCorta(ev.fecha));
        const hora = ev.hora_inicio ? ` · ${hhmm(ev.hora_inicio)}${ev.hora_fin ? '–' + hhmm(ev.hora_fin) : ''}` : '';
        return { ev, chk, nodo: el('label', { class: `check-fila fila-import${ya ? ' ya' : ''}` }, chk,
          el('span', {}, el('strong', {}, `${t.icono} ${ev.titulo}`), el('br'), el('span', { class: 'suave' }, `${cuando}${hora}${ya ? ' · ya está' : ''}`))) };
      });
      lista.replaceChildren(
        el('button', { type: 'button', class: 'enlace', onclick: () => { const todos = filas.every((f) => f.chk.disabled || f.chk.checked); filas.forEach((f) => { if (!f.chk.disabled) f.chk.checked = !todos; }); actualizar(); } }, 'Marcar / desmarcar todos'),
        ...filas.map((f) => f.nodo));
      actualizar();
    } catch (e) { lista.replaceChildren(el('p', { class: 'error-txt' }, e.message || String(e))); }
  }

  botonImportar.onclick = () => conCarga(botonImportar, async () => {
    const sel = filas.filter((f) => f.chk.checked).map((f) => filaCopia(f.ev, S.espacio.id));
    if (!sel.length) return;
    await D.crearEventos(sel);
    cerrar(); S.rango = null;
    aviso(`${sel.length} ${sel.length === 1 ? 'evento importado' : 'eventos importados'}`);
    await cargarVista(true);
  });
  const cerrar = modal('Importar mis eventos', el('div', { class: 'formulario' },
    el('label', {}, 'Traer desde', origenSel),
    lista,
    el('p', { class: 'suave' }, `Se copian como eventos tuyos a «${S.espacio.nombre}». ${otrasPersonas.length ? `Los verán: ${otrasPersonas.join(', ')}.` : 'Ahora solo los ves tú.'} Son copias: si cambias uno, el otro no se modifica.`),
    el('div', { class: 'fila-botones fin' }, el('button', { type: 'button', onclick: () => cerrar() }, 'Cancelar'), botonImportar)));
  cargarLista();
}

function abrirBorradoSerie(ev, fecha, cerrarEditor) {
  const cerrar = modal('Borrar evento que se repite', el('div', { class: 'formulario' },
    el('p', {}, `«${ev.titulo}» se repite cada semana. ¿Qué quieres borrar?`),
    el('div', { class: 'fila-botones columna' },
      el('button', { type: 'button', onclick: (e) => conCarga(e.currentTarget, async () => {
        await D.guardarEvento(ev.id, { excepciones: [...new Set([...(ev.excepciones || []), fecha])] });
        cerrar(); cerrarEditor(); aviso('Día quitado'); await cargarVista(true);
      }) }, `Solo el ${fechaCorta(fecha)}`),
      el('button', { type: 'button', class: 'peligro', onclick: (e) => conCarga(e.currentTarget, async () => {
        await D.borrarEvento(ev.id);
        cerrar(); cerrarEditor(); aviso('Serie borrada'); await cargarVista(true);
      }) }, 'Toda la serie'),
      el('button', { type: 'button', onclick: () => cerrar() }, 'Cancelar'))));
}

// ---------- editor del menú de un día ----------
function abrirEditorMenu({ fecha, ownerId }) {
  const personas = S.miembros;
  let actual = ownerId || (editables()[0] || personas[0]).id;
  const original = {}, borrador = {};
  for (const m of personas) {
    original[m.id] = {};
    for (const f of FRANJAS) {
      const r = S.menuMap.get(claveMenu(fecha, m.id, f.id));
      original[m.id][f.id] = { hora: r ? hhmm(r.hora) : '', texto: r ? r.texto : '' };
    }
    borrador[m.id] = JSON.parse(JSON.stringify(original[m.id]));
  }
  let campos = {};
  const tabs = el('div', { class: 'chips', role: 'group', 'aria-label': 'Persona' });
  const cuerpoFranjas = el('div', { class: 'franjas' });

  function leer() {
    if (!puedeEditarCapa(actual)) return;
    for (const f of FRANJAS) borrador[actual][f.id] = { hora: campos[f.id].hora.value, texto: campos[f.id].texto.value.trim() };
  }
  function mostrar(id) {
    actual = id;
    const editable = puedeEditarCapa(id);
    tabs.replaceChildren(...(personas.length > 1 ? personas.map((m) => el('button', {
      type: 'button', class: 'chip-capa', 'aria-pressed': String(m.id === id), style: { '--c': m.color },
      onclick: () => { leer(); mostrar(m.id); },
    }, el('span', { class: 'punto' }), m.nombre)) : []));
    campos = {};
    cuerpoFranjas.replaceChildren(...FRANJAS.map((f) => {
      const b = borrador[id][f.id];
      const hora = el('input', { type: 'time', value: b.hora, disabled: !editable, 'aria-label': `Hora de ${f.nombre}` });
      const texto = el('textarea', { rows: 2, maxLength: 1000, value: b.texto, disabled: !editable, placeholder: editable ? 'Un plato por línea' : '', 'aria-label': f.nombre });
      campos[f.id] = { hora, texto };
      return el('div', { class: 'franja-edit' }, el('div', { class: 'franja-cab' }, el('strong', {}, f.nombre), hora), texto);
    }));
  }
  mostrar(actual);

  const guardar = (btn) => conCarga(btn, async () => {
    leer();
    const subir = [], quitar = [];
    for (const m of personas) {
      if (!puedeEditarCapa(m.id)) continue;
      for (const f of FRANJAS) {
        const a = original[m.id][f.id], b = borrador[m.id][f.id];
        if (a.texto === b.texto && a.hora === b.hora) continue;
        if (!b.texto) { if (a.texto) quitar.push([m.id, f.id]); }
        else subir.push({ espacio_id: S.espacio.id, owner_id: m.id, fecha, franja: f.id, hora: b.hora || null, texto: b.texto.slice(0, 1000) });
      }
    }
    if (subir.length) await D.guardarMenu(subir);
    for (const [o, fr] of quitar) await D.borrarMenu(S.espacio.id, o, fecha, fr);
    cerrar(); aviso('Menú guardado'); await cargarVista(true);
  });

  const cerrar = modal(cap(fechaLarga(fecha)), el('div', { class: 'formulario' },
    tabs, cuerpoFranjas,
    el('div', { class: 'fila-botones fin' }, el('button', { type: 'button', class: 'primario', onclick: (e) => guardar(e.currentTarget) }, 'Guardar'))));
}

// ---------- repetir semanas del menú ----------
function abrirRepetir() {
  const quien = editables();
  const inicioIn = el('input', { type: 'date', value: S.semana, 'aria-label': 'Semana de origen' });
  const nSel = el('select', { 'aria-label': 'Semanas a copiar' }, [1, 2, 3, 4].map((n) => el('option', { value: n, selected: n === 2 }, n === 1 ? '1 semana' : `${n} semanas`)));
  const fin0 = finMes(Number(sumarDias(S.semana, 14).slice(0, 4)), Number(sumarDias(S.semana, 14).slice(5, 7)));
  const hastaIn = el('input', { type: 'date', value: fin0, 'aria-label': 'Repetir hasta' });
  const sustituir = el('input', { type: 'checkbox' });
  const elegidos = new Set(quien.filter((m) => S.capas.has(m.id)).map((m) => m.id));
  if (!elegidos.size) quien.forEach((m) => elegidos.add(m.id));

  const hacer = (btn) => conCarga(btn, async () => {
    if (!esFechaISO(inicioIn.value) || !esFechaISO(hastaIn.value)) throw new Error('Elige las fechas.');
    if (!elegidos.size) throw new Error('Elige al menos una persona.');
    const inicio = inicioSemana(inicioIn.value);
    const n = Number(nSel.value);
    const finOrigen = sumarDias(inicio, 7 * n - 1);
    const hasta = hastaIn.value;
    if (hasta <= finOrigen) throw new Error('«Hasta» tiene que ser posterior a las semanas que copias.');
    if (diffDias(hasta, finOrigen) > 200) throw new Error('Son demasiados días de golpe. Prueba con menos.');
    const origen = (await D.cargarMenu(S.espacio.id, inicio, finOrigen)).filter((f) => elegidos.has(f.owner_id));
    if (!origen.length) throw new Error('Esas semanas no tienen menú para copiar.');
    let nuevas = repetirSemanas(origen.map((f) => ({ fecha: f.fecha, owner_id: f.owner_id, franja: f.franja, hora: f.hora, texto: f.texto })), inicio, n, hasta);
    if (!sustituir.checked) {
      const ya = new Set((await D.cargarMenu(S.espacio.id, sumarDias(finOrigen, 1), hasta)).map((f) => claveMenu(f.fecha, f.owner_id, f.franja)));
      nuevas = nuevas.filter((f) => !ya.has(claveMenu(f.fecha, f.owner_id, f.franja)));
    }
    if (!nuevas.length) throw new Error('No hay nada nuevo que copiar (ya estaba todo relleno).');
    if (!confirm(`Se guardarán ${nuevas.length} comidas entre el ${fechaCorta(sumarDias(finOrigen, 1))} y el ${fechaCorta(hasta)}. ¿Seguimos?`)) return;
    await D.guardarMenu(nuevas.map((f) => ({ ...f, espacio_id: S.espacio.id, hora: f.hora ? hhmm(f.hora) : null })));
    cerrar(); aviso(`${nuevas.length} comidas guardadas`); await cargarVista(true);
  });

  const cerrar = modal('Repetir semanas del menú', el('div', { class: 'formulario' },
    el('p', { class: 'suave' }, 'Copia el menú de una o más semanas y lo repite, en el mismo orden, hasta la fecha que elijas.'),
    el('label', {}, 'Copiar desde la semana del', inicioIn),
    el('label', {}, 'Cuántas semanas copiar', nSel),
    el('label', {}, 'Repetir hasta', hastaIn),
    quien.length > 1 ? el('div', { class: 'quien-lista' }, el('span', { class: 'etq' }, 'De quién'),
      quien.map((m) => el('label', { class: 'check', style: { '--c': m.color } },
        el('input', { type: 'checkbox', checked: elegidos.has(m.id), onchange: (e) => { if (e.target.checked) elegidos.add(m.id); else elegidos.delete(m.id); } }),
        el('span', { class: 'punto' }), m.nombre))) : null,
    el('label', { class: 'check' }, sustituir, 'Sustituir lo que ya haya escrito'),
    el('div', { class: 'fila-botones fin' }, el('button', { type: 'button', class: 'primario', onclick: (e) => hacer(e.currentTarget) }, 'Repetir'))));
}

// ---------- importar menú desde Excel (o CSV) ----------
function descargarPlantilla() {
  const bytes = crearXlsx(plantillaMenu());
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = el('a', { href: url, download: 'plantilla-menu-organizapp.xlsx' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Devuelve el resultado de leerImportacion para un .xlsx o un .csv (UTF-8 o el CSV normal de Excel).
async function leerArchivoMenu(file) {
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf);
  if (b[0] === 0x50 && b[1] === 0x4b) return leerImportacion(await leerXlsx(buf)); // "PK": un .xlsx
  if (/\.xlsx$/i.test(file.name)) throw new Error('Este archivo no es un Excel (.xlsx) válido. Prueba a descargarlo o guardarlo de nuevo.');
  if (b[0] === 0xd0 && b[1] === 0xcf) throw new Error('Este es un Excel antiguo (.xls). Ábrelo en Excel y guárdalo como «Libro de Excel (.xlsx)».');
  let texto = new TextDecoder('utf-8').decode(buf);
  if (texto.includes('\uFFFD')) texto = new TextDecoder('windows-1252').decode(buf); // CSV guardado por Excel sin UTF-8
  return leerImportacion(texto);
}

function abrirImportar() {
  const cuerpo = el('div', { class: 'formulario' });
  const archivo = el('input', { type: 'file', accept: '.xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'aria-label': 'Archivo de Excel' });
  const zona = el('div', {});
  let leido = null;

  archivo.addEventListener('change', async () => {
    zona.replaceChildren();
    const f = archivo.files[0];
    if (!f) return;
    if (f.size > 5_000_000) return zona.append(el('p', { class: 'error-txt' }, 'El archivo es demasiado grande.'));
    try { leido = await leerArchivoMenu(f); } catch (e) {
      return zona.append(el('p', { class: 'error-txt', role: 'alert' }, e.message || 'No se pudo leer el archivo.'));
    }
    if (!leido.filas.length) {
      return zona.append(el('p', { class: 'error-txt' }, leido.errores[0]?.motivo || 'No hay comidas en el archivo.'));
    }
    const fechas = leido.filas.map((x) => x.fecha).sort();
    const mapeo = {};
    const selects = leido.personas.map((nombre) => {
      const coincide = S.miembros.find((m) => m.nombre.trim().toLowerCase() === nombre.toLowerCase())
        || S.miembros.find((m) => m.nombre.toLowerCase().startsWith(nombre.toLowerCase().split(' ')[0]));
      mapeo[nombre] = coincide && puedeEditarCapa(coincide.id) ? coincide.id : '';
      const sel = el('select', { 'aria-label': `Quién es ${nombre}`, onchange: () => { mapeo[nombre] = sel.value; } },
        el('option', { value: '' }, 'No importar'),
        editables().map((m) => el('option', { value: m.id, selected: m.id === mapeo[nombre] }, m.nombre)));
      return el('label', {}, `«${nombre}» en el archivo es…`, sel);
    });
    zona.append(
      el('p', {}, `Hay ${leido.filas.length} comidas, del ${fechaCorta(fechas[0])} al ${fechaCorta(fechas[fechas.length - 1])}.`),
      leido.errores.length ? el('p', { class: 'suave' }, `${leido.errores.length} líneas se ignoran por errores (por ejemplo, línea ${leido.errores[0].linea}: ${leido.errores[0].motivo}).`) : null,
      ...selects,
      el('p', { class: 'suave' }, 'Lo que ya hubiera escrito en esas mismas franjas se sustituye.'),
      el('div', { class: 'fila-botones fin' }, el('button', { type: 'button', class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
        const filas = leido.filas.filter((x) => mapeo[x.persona]).map((x) => ({
          espacio_id: S.espacio.id, owner_id: mapeo[x.persona], fecha: x.fecha, franja: x.franja, hora: x.hora, texto: x.texto,
        }));
        if (!filas.length) throw new Error('No has asignado ninguna persona.');
        await D.guardarMenu(filas);
        cerrar(); aviso(`${filas.length} comidas importadas`);
        S.tab = 'menu'; S.semana = inicioSemana(fechas[0]); await cargarVista(true);
      }) }, 'Importar')));
  });

  cuerpo.append(
    el('p', { class: 'suave' }, 'Elige el Excel (.xlsx) con tus comidas. Si no tienes uno, descarga la plantilla y rellénala.'),
    el('div', { class: 'fila-botones' }, el('button', { type: 'button', onclick: () => descargarPlantilla() }, '📄 Descargar plantilla')),
    archivo, zona);
  const cerrar = modal('Importar menú', cuerpo);
}

// ---------- arranque ----------
function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  const habiaControlador = !!navigator.serviceWorker.controller;
  let recargado = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (habiaControlador && !recargado) { recargado = true; location.reload(); }
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.version) ponerVersion(e.data.version);
  });
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready)
    .then((r) => r.active && r.active.postMessage('version')).catch(() => { /* sin SW: la app funciona igual */ });
}

function render() {
  const y = window.scrollY;
  const app = $('#app');
  app.replaceChildren();
  if (S.cargando) app.append(pantallaCarga());
  else if (S.error) app.append(pantallaError());
  else if (!S.user) app.append(pantallaLogin());
  else if (!S.espacio) app.append(pantallaBienvenida());
  else app.append(marco());
  window.scrollTo(0, y);
}

function leerErrorDeURL() {
  // Solo se LEE al arrancar. La URL se limpia después (limpiarURL), cuando Supabase ya ha usado el código.
  const p = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const desc = p.get('error_description') || h.get('error_description');
  if (desc) S.errorLogin = 'No se pudo iniciar sesión: ' + desc.replace(/\+/g, ' ');
}

function limpiarURL() {
  const p = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (p.has('code') || p.has('error') || h.has('error') || h.has('access_token')) {
    history.replaceState(null, '', location.pathname);
  }
}

function iniciar() {
  leerErrorDeURL();
  aplicarTema();
  registrarSW();
  leerVersionPublicada();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); S.instalar = e;
    if (S.tab === 'mas' && S.espacio && !document.querySelector('.modal-fondo')) render();
  });
  window.addEventListener('appinstalled', () => { S.instalar = null; if (S.tab === 'mas' && S.espacio) render(); });
  render();
  D.alCambiarSesion((evento, sesion) => {
    // No se llama a Supabase dentro de este aviso (podría bloquearse): se aplaza un instante.
    setTimeout(() => { limpiarURL(); alSesion(sesion); }, 0);
  });
  let oculta = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) oculta = Date.now();
    else if (S.espacio && Date.now() - oculta > 30000) { cargarVista(true); recargarAmistades(); }
    else if (S.user && !S.espacio && !S.cargando && Date.now() - oculta > 5000) cargarTodo(); // sin calendario: por si te han invitado
  });
}

iniciar();

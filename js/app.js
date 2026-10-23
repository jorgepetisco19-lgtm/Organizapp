// Organizapp · pantalla y lógica. Sin frameworks: todo el texto del usuario se pinta con
// textContent (nunca innerHTML), así que nadie puede colar código en un título o un menú.
import * as D from './datos.js';
import {
  FRANJAS, TIPOS, PALETA, hoyISO, sumarDias, inicioSemana, rejillaMes, finMes, sumarMeses,
  nombreMes, nombreDiaCorto, fechaLarga, fechaCorta, hhmm, esFechaISO, expandirEventos,
  repetirSemanas, leerImportacion, diffDias, diaSemana,
} from './util.js';

// ---------- utilidades de pantalla ----------
const $ = (s, r = document) => r.querySelector(s);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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

function modal(titulo, cuerpo) {
  const fondo = el('div', { class: 'modal-fondo', onclick: (e) => { if (e.target === fondo) cerrar(); } });
  const alTecla = (e) => { if (e.key === 'Escape') cerrar(); };
  function cerrar() {
    document.removeEventListener('keydown', alTecla);
    fondo.remove();
    document.body.classList.toggle('sin-scroll', $('#modales').children.length > 0);
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
  miembros: [], enviadas: [], invitaciones: [],
  tab: 'inicio', inicioDia: 'manana',
  capas: new Set(), tipos: new Set(leerLocal('tipos', TIPOS.map((t) => t.id))),
  diaSel: hoyInicial, mes: { y: Number(hoyInicial.slice(0, 4)), m: Number(hoyInicial.slice(5, 7)) },
  semana: inicioSemana(hoyInicial),
  eventos: [], menu: [], menuMap: new Map(), rango: null, cargandoDatos: false,
  version: '…', instalar: null,
};
const claveMenu = (fecha, owner, franja) => `${fecha}|${owner}|${franja}`;
const miembro = (id) => S.miembros.find((m) => m.id === id);
const colorDe = (id) => (miembro(id) || { color: '#888888' }).color;
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

async function cargarTodo() {
  S.cargando = true; S.error = null;
  render();
  try {
    const c = await D.cargarContexto(S.user);
    Object.assign(S, { perfil: c.perfil, espacio: c.espacio, relacion: c.relacion, miembros: c.miembros, enviadas: c.enviadas, invitaciones: c.invitaciones });
    const guardadas = leerLocal('capas', null);
    const ids = new Set(S.miembros.map((m) => m.id));
    const validas = Array.isArray(guardadas) ? guardadas.filter((i) => ids.has(i)) : [];
    S.capas = new Set(validas.length ? validas : [...ids]);
    S.cargando = false;
    S.rango = null;
    if (S.espacio) return await cargarVista(true);
  } catch (e) {
    S.error = e.message || String(e);
    S.cargando = false;
  }
  render();
}

function reiniciarSesionLocal() {
  Object.assign(S, { user: null, perfil: null, espacio: null, relacion: null, miembros: [], enviadas: [], invitaciones: [], eventos: [], menu: [], menuMap: new Map(), rango: null, tab: 'inicio' });
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
          el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => { await D.aceptarInvitacion(inv.id); await cargarTodo(); }) }, 'Aceptar'),
          el('button', { onclick: (e) => conCarga(e.currentTarget, async () => { await D.rechazarInvitacion(inv.id); await cargarTodo(); }) }, 'Rechazar'))))) : null,
    el('section', { class: 'tarjeta' },
      el('h2', {}, S.invitaciones.length ? 'O crea uno nuevo' : 'Crea vuestro calendario'),
      el('label', {}, 'Nombre', nombreIn),
      el('p', { class: 'suave' }, 'Después podrás invitar a tu pareja con su correo de Google.'),
      el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => { await D.crearEspacio(nombreIn.value.trim() || 'Nuestro calendario'); await cargarTodo(); }) }, 'Crear calendario')),
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
        guardarLocal('capas', [...S.capas]);
        render();
      },
    }, el('span', { class: 'punto' }), m.nombre)));
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
      S.tab === 'mas' ? null : capasChips()),
    el('main', { id: 'contenido', class: 'contenido' }, S.cargandoDatos ? el('p', { class: 'vacio' }, 'Cargando…') : vistaActual()),
    el('nav', { class: 'tabs', 'aria-label': 'Secciones' },
      TABS.map(([id, ico, nom]) => el('button', { type: 'button', 'aria-current': S.tab === id ? 'page' : null, onclick: () => { S.tab = id; cargarVista(); } },
        el('span', { class: 'ico' }, ico), el('span', {}, nom)))),
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
function filaEvento({ ev, fecha }) {
  const m = miembro(ev.owner_id) || { nombre: '?', color: '#888888' };
  const t = TIPOS.find((x) => x.id === ev.tipo);
  const hora = ev.hora_inicio ? hhmm(ev.hora_inicio) + (ev.hora_fin ? '–' + hhmm(ev.hora_fin) : '') : 'Todo el día';
  return el('button', { type: 'button', class: 'fila-evento', style: { '--c': m.color }, onclick: () => abrirEditorEvento({ ev, ocurrencia: fecha }) },
    el('span', { class: 'hora' }, hora),
    el('span', { class: 'cuerpo' },
      el('span', { class: 'tit' }, `${t.icono} ${ev.titulo}`, ev.repeticion ? el('span', { class: 'rep', title: 'Se repite cada semana' }, ' ↻') : null),
      ev.notas ? el('span', { class: 'notas' }, ev.notas) : null),
    S.miembros.length > 1 ? el('span', { class: 'quien' }, m.nombre) : null);
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
  const mapa = expandirEventos(S.eventos.filter((e) => S.capas.has(e.owner_id)), hoy, manana);
  const delDia = mapa.get(dia) || [];
  const tareasHoy = (mapa.get(hoy) || []).filter((x) => x.ev.tipo === 'tarea');

  return el('div', {},
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Día' },
      [['hoy', 'Hoy'], ['manana', 'Mañana']].map(([id, nom]) =>
        el('button', { type: 'button', 'aria-pressed': String(S.inicioDia === id), onclick: () => { S.inicioDia = id; render(); } }, nom))),
    el('h2', { class: 'fecha-grande' }, cap(fechaLarga(dia))),
    (S.miembros.length === 1 && S.relacion === 'pareja') ? el('div', { class: 'tarjeta aviso-invitar' },
      el('p', {}, 'Ahora mismo estás solo en este calendario.'),
      el('button', { class: 'primario', onclick: () => { S.tab = 'mas'; render(); } }, 'Invitar a tu pareja')) : null,
    esManana ? el('section', { class: 'seccion preparar' },
      el('h3', {}, '🛠️ Para dejar preparado hoy'),
      tareasHoy.length ? tareasHoy.map(filaEvento) : el('p', { class: 'vacio' }, 'Nada que preparar hoy.')) : null,
    bloqueMenuDia(dia, `🍽️ Comida de ${esManana ? 'mañana' : 'hoy'}`),
    el('section', { class: 'seccion' },
      el('h3', {}, `🗓️ Agenda de ${esManana ? 'mañana' : 'hoy'}`),
      delDia.length ? delDia.map(filaEvento) : el('p', { class: 'vacio' }, 'Nada planificado.')));
}

// ---------- vista: Calendario ----------
function vistaCalendario() {
  const { y, m } = S.mes;
  const hoy = hoyISO();
  const semanas = rejillaMes(y, m);
  const desde = semanas[0][0], hasta = semanas[semanas.length - 1][6];
  const filtrados = S.eventos.filter((e) => S.capas.has(e.owner_id) && S.tipos.has(e.tipo));
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
    el('div', { class: 'chips tipos', role: 'group', 'aria-label': 'Tipos de evento' },
      TIPOS.map((t) => el('button', {
        type: 'button', class: 'chip-tipo', 'aria-pressed': String(S.tipos.has(t.id)),
        onclick: () => {
          if (S.tipos.has(t.id)) { if (S.tipos.size > 1) S.tipos.delete(t.id); } else S.tipos.add(t.id);
          guardarLocal('tipos', [...S.tipos]); render();
        },
      }, `${t.icono} ${t.nombre}`))),
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
          lista.slice(0, 3).map(({ ev }) => el('span', { class: 'chip', style: { '--c': colorDe(ev.owner_id) } }, ev.titulo)),
          lista.length > 3 ? el('span', { class: 'mas' }, `+${lista.length - 3}`) : null);
      })),
    el('section', { class: 'agenda' },
      el('h2', { class: 'fecha-grande' }, cap(fechaLarga(S.diaSel))),
      delDia.length ? delDia.map(filaEvento) : el('p', { class: 'vacio' }, 'Nada planificado este día.'),
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
function vistaMas() {
  const nombreIn = el('input', { type: 'text', maxLength: 60, value: S.perfil?.nombre || '', 'aria-label': 'Tu nombre' });
  let colorSel = (miembro(S.user.id) || S.perfil || {}).color || PALETA[0];
  const swatches = PALETA.map((c) => el('button', {
    type: 'button', class: 'muestra', style: { '--c': c }, 'aria-label': `Color ${c}`, 'aria-pressed': String(c === colorSel),
    onclick: () => { colorSel = c; swatches.forEach((b, i) => b.setAttribute('aria-pressed', String(PALETA[i] === colorSel))); },
  }));
  const emailIn = el('input', { type: 'email', placeholder: 'correo de Google de tu pareja', autocomplete: 'off', 'aria-label': 'Correo a invitar' });
  const temaSel = el('select', { 'aria-label': 'Aspecto', onchange: () => { guardarLocal('tema', temaSel.value); aplicarTema(); } },
    [['auto', 'Automático (como tu móvil)'], ['claro', 'Claro'], ['oscuro', 'Oscuro']].map(([v, n]) => el('option', { value: v, selected: leerLocal('tema', 'auto') === v }, n)));

  return el('div', { class: 'mas' },
    el('section', { class: 'tarjeta' },
      el('h2', {}, 'Tú'),
      el('label', {}, 'Nombre', nombreIn),
      el('div', {}, el('span', { class: 'etq' }, 'Tu color en el calendario'), el('div', { class: 'muestras' }, swatches)),
      el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
        const n = nombreIn.value.trim();
        if (!n) throw new Error('Pon un nombre.');
        await D.guardarPerfil(S.user.id, { nombre: n, color: colorSel });
        aviso('Guardado');
        await cargarTodo();
      }) }, 'Guardar')),
    el('section', { class: 'tarjeta' },
      el('h2', {}, `Calendario «${S.espacio.nombre}»`),
      el('ul', { class: 'personas' }, S.miembros.map((m) => el('li', { style: { '--c': m.color } },
        el('span', { class: 'punto' }), `${m.nombre}${m.id === S.user.id ? ' (tú)' : ''}`,
        el('span', { class: 'suave' }, m.relacion === 'pareja' ? ' · pareja' : ' · amistad')))),
      S.relacion === 'pareja' ? [
        S.miembros.length < 5 ? el('div', {},
          el('label', {}, 'Invitar a tu pareja', emailIn),
          el('p', { class: 'suave' }, 'Escribe el correo de la cuenta de Google con la que entrará. Cuando abra la app con esa cuenta verá la invitación.'),
          el('button', { class: 'primario', onclick: (e) => conCarga(e.currentTarget, async () => {
            const mail = emailIn.value.trim().toLowerCase();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('Ese correo no parece válido.');
            if (mail === (S.user.email || '').toLowerCase()) throw new Error('Ese es tu propio correo.');
            await D.invitar(S.espacio.id, mail, 'pareja', S.user.id);
            aviso('Invitación creada');
            await cargarTodo();
          }) }, 'Invitar')) : null,
        S.enviadas.length ? el('div', {},
          el('span', { class: 'etq' }, 'Invitaciones pendientes'),
          el('ul', { class: 'personas' }, S.enviadas.map((i) => el('li', {},
            i.email, ' ',
            el('button', { class: 'enlace', onclick: (e) => conCarga(e.currentTarget, async () => { await D.borrarInvitacion(i.id); await cargarTodo(); }) }, 'Quitar'))))) : null,
      ] : null),
    el('section', { class: 'tarjeta' },
      el('h2', {}, 'Menú'),
      el('p', { class: 'suave' }, 'Importa comidas desde un archivo CSV (fecha, persona, franja, hora, texto).'),
      el('button', { onclick: () => abrirImportar() }, '📥 Importar menú desde CSV')),
    el('section', { class: 'tarjeta' },
      el('h2', {}, 'La app'),
      el('label', {}, 'Aspecto', temaSel),
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
  const owners = new Set([ev ? ev.owner_id : S.user.id]);

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

  let quienUI = null, ownerSel = null;
  if (nuevo && editables().length > 1) {
    quienUI = el('div', { class: 'quien-lista' }, el('span', { class: 'etq' }, 'Para'),
      editables().map((m) => el('label', { class: 'check', style: { '--c': m.color } },
        el('input', { type: 'checkbox', checked: owners.has(m.id), onchange: (e) => {
          if (e.target.checked) owners.add(m.id); else owners.delete(m.id);
        } }), el('span', { class: 'punto' }), m.nombre)));
  } else if (!nuevo && S.miembros.length > 1) {
    if (editable) {
      ownerSel = el('select', { 'aria-label': 'De quién es' }, editables().map((m) => el('option', { value: m.id, selected: m.id === ev.owner_id }, m.nombre)));
      quienUI = el('label', {}, 'De', ownerSel);
    } else quienUI = el('p', {}, el('span', { class: 'etq' }, 'De '), (miembro(ev.owner_id) || { nombre: '?' }).nombre);
  }

  const guardar = (btn) => {
    const t = titulo.value.trim(), f = fechaIn.value, hi = iniIn.value, hf = finIn.value;
    const rep = repSel.value, hasta = hastaIn.value;
    if (!t) return aviso('Ponle un título.', true);
    if (!esFechaISO(f)) return aviso('Elige una fecha.', true);
    if (hf && !hi) return aviso('Si pones hora de fin, pon también la de inicio.', true);
    if (hi && hf && hf < hi) return aviso('La hora de fin es anterior a la de inicio.', true);
    if (rep && hasta && hasta < f) return aviso('«Repetir hasta» es anterior a la fecha.', true);
    if (nuevo && !owners.size) return aviso('Elige para quién es.', true);
    const campos = {
      tipo, titulo: t, fecha: f, hora_inicio: hi || null, hora_fin: hf || null,
      notas: notasIn.value.trim() || null, repeticion: rep || null, repite_hasta: rep && hasta ? hasta : null,
    };
    return conCarga(btn, async () => {
      if (nuevo) await D.crearEventos([...owners].map((o) => ({ ...campos, espacio_id: S.espacio.id, owner_id: o, creado_por: S.user.id })));
      else await D.guardarEvento(ev.id, { ...campos, owner_id: ownerSel ? ownerSel.value : ev.owner_id });
      cerrar(); aviso('Guardado'); await cargarVista(true);
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
    editable ? el('div', { class: 'fila-botones fin' },
      !nuevo ? el('button', { type: 'button', class: 'peligro', onclick: (e) => borrar(e.currentTarget) }, 'Borrar') : null,
      el('button', { type: 'button', class: 'primario', onclick: (e) => guardar(e.currentTarget) }, 'Guardar')) : null);
  const cerrar = modal(nuevo ? 'Nuevo evento' : (editable ? 'Editar evento' : 'Evento'), cuerpo);
  if (nuevo) setTimeout(() => titulo.focus(), 50);
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

// ---------- importar CSV ----------
function abrirImportar() {
  const cuerpo = el('div', { class: 'formulario' });
  const archivo = el('input', { type: 'file', accept: '.csv,text/csv,text/plain', 'aria-label': 'Archivo CSV' });
  const zona = el('div', {});
  let leido = null;

  archivo.addEventListener('change', async () => {
    zona.replaceChildren();
    const f = archivo.files[0];
    if (!f) return;
    if (f.size > 2_000_000) return zona.append(el('p', { class: 'error-txt' }, 'El archivo es demasiado grande.'));
    leido = leerImportacion(await f.text());
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
    el('p', { class: 'suave' }, 'Elige el archivo CSV con las columnas: fecha, persona, franja, hora, texto.'),
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
    else if (S.espacio && Date.now() - oculta > 30000) cargarVista(true);
  });
}

iniciar();

// Funciones puras (fechas, repeticiones, CSV). No tocan la pantalla ni la base de datos,
// así se pueden probar solas con Node.

export const FRANJAS = [
  { id: 'desayuno', nombre: 'Desayuno' },
  { id: 'media_manana', nombre: 'Media mañana' },
  { id: 'comida', nombre: 'Comida' },
  { id: 'merienda', nombre: 'Merienda' },
  { id: 'cena', nombre: 'Cena' },
];

export const TIPOS = [
  { id: 'deporte', nombre: 'Deporte', icono: '🏃' },
  { id: 'plan', nombre: 'Plan', icono: '🎟️' },
  { id: 'tarea', nombre: 'Tarea', icono: '✅' },
  { id: 'compromiso', nombre: 'Compromiso', icono: '📌' },
];

export const PALETA = ['#3b82f6', '#f97316', '#10b981', '#a855f7', '#ef4444', '#eab308', '#06b6d4', '#ec4899'];

const MS_DIA = 86400000;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export const pad = (n) => String(n).padStart(2, '0');

// Las fechas se manejan como texto "AAAA-MM-DD" y se calculan en UTC para que
// el cambio de hora (verano/invierno) nunca desplace un día.
export function aUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
export function deUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export const sumarDias = (iso, n) => deUTC(aUTC(iso) + n * MS_DIA);
export const diffDias = (a, b) => Math.round((aUTC(a) - aUTC(b)) / MS_DIA);
export const diaSemana = (iso) => (new Date(aUTC(iso)).getUTCDay() + 6) % 7; // 0 = lunes
export const inicioSemana = (iso) => sumarDias(iso, -diaSemana(iso));
export const hoyISO = (ahora = new Date()) => `${ahora.getFullYear()}-${pad(ahora.getMonth() + 1)}-${pad(ahora.getDate())}`;
export const finMes = (y, m) => deUTC(Date.UTC(y, m, 0)); // m = 1..12
export const inicioMes = (y, m) => `${y}-${pad(m)}-01`;

export function sumarMeses(y, m, n) {
  const t = y * 12 + (m - 1) + n;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}

// Semanas (de lunes a domingo) que cubren el mes
export function rejillaMes(y, m) {
  const ini = inicioSemana(inicioMes(y, m));
  const fin = finMes(y, m);
  const semanas = Math.ceil((diffDias(fin, ini) + 1) / 7);
  return Array.from({ length: semanas }, (_, s) =>
    Array.from({ length: 7 }, (_, d) => sumarDias(ini, s * 7 + d)));
}

export const nombreMes = (m) => MESES[m - 1];
export const nombreDia = (i) => DIAS[i];
export const nombreDiaCorto = (i) => DIAS[i].slice(0, 3);
export function fechaLarga(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${DIAS[diaSemana(iso)]} ${d} de ${MESES[m - 1]}`;
}
export function fechaCorta(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES[m - 1].slice(0, 3)}`;
}
export const hhmm = (t) => (t ? String(t).slice(0, 5) : '');
export const esFechaISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && deUTC(aUTC(s)) === s;
export const esHora = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

// ---------- eventos y repeticiones ----------

// Fechas en las que ocurre un evento dentro de [desde, hasta]
export function ocurrencias(ev, desde, hasta) {
  if (!ev.repeticion) return ev.fecha >= desde && ev.fecha <= hasta ? [ev.fecha] : [];
  const fin = ev.repite_hasta && ev.repite_hasta < hasta ? ev.repite_hasta : hasta;
  const exc = new Set(ev.excepciones || []);
  const out = [];
  let f = ev.fecha;
  if (f < desde) f = sumarDias(f, Math.ceil(diffDias(desde, f) / 7) * 7);
  for (; f <= fin; f = sumarDias(f, 7)) if (!exc.has(f)) out.push(f);
  return out;
}

// Orden dentro de un día: primero los eventos sin hora, luego por hora
export function compararEventos(a, b) {
  const ha = hhmm(a.ev.hora_inicio), hb = hhmm(b.ev.hora_inicio);
  if (ha !== hb) return ha < hb ? -1 : 1; // '' (sin hora) queda primero
  const t = (a.ev.titulo || '').localeCompare(b.ev.titulo || '', 'es');
  return t !== 0 ? t : String(a.ev.id).localeCompare(String(b.ev.id));
}

// Devuelve un Map fecha -> [{ev, fecha}] ordenado
export function expandirEventos(eventos, desde, hasta) {
  const mapa = new Map();
  for (const ev of eventos) {
    for (const fecha of ocurrencias(ev, desde, hasta)) {
      if (!mapa.has(fecha)) mapa.set(fecha, []);
      mapa.get(fecha).push({ ev, fecha });
    }
  }
  for (const lista of mapa.values()) lista.sort(compararEventos);
  return mapa;
}

// ---------- menú ----------

export const primeraLinea = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
export const lineasExtra = (t) => Math.max(0, String(t || '').split('\n').map((s) => s.trim()).filter(Boolean).length - 1);

// Repite un bloque de "n" semanas que empieza en "inicio" (lunes) hasta la fecha "hasta".
// "filas" son las franjas del bloque original. Devuelve solo las filas NUEVAS.
export function repetirSemanas(filas, inicio, n, hasta) {
  const periodo = 7 * n;
  const finOrigen = sumarDias(inicio, periodo - 1);
  const porFecha = new Map();
  for (const f of filas) {
    if (!porFecha.has(f.fecha)) porFecha.set(f.fecha, []);
    porFecha.get(f.fecha).push(f);
  }
  const out = [];
  for (let d = sumarDias(finOrigen, 1); d <= hasta; d = sumarDias(d, 1)) {
    const k = ((diffDias(d, inicio) % periodo) + periodo) % periodo;
    for (const f of porFecha.get(sumarDias(inicio, k)) || []) out.push({ ...f, fecha: d });
  }
  return out;
}

// ---------- CSV ----------

export function parseCSV(texto) {
  texto = String(texto).replace(/^﻿/, '');
  const primera = texto.split(/\r?\n/)[0] || '';
  const delim = primera.split(';').length > primera.split(',').length ? ';' : ',';
  const filas = [];
  let fila = [], campo = '', comillas = false;
  const cerrarFila = () => {
    fila.push(campo);
    campo = '';
    if (fila.length > 1 || fila[0] !== '') filas.push(fila);
    fila = [];
  };
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else comillas = false;
      } else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === delim) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && texto[i + 1] === '\n') i++; cerrarFila(); }
    else campo += c;
  }
  if (campo !== '' || fila.length) cerrarFila();
  return filas;
}

const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const clave = (s) => sinTildes(String(s || '').trim().toLowerCase()).replace(/\s+/g, '_');

function fechaDeCSV(s) {
  s = String(s || '').trim();
  if (esFechaISO(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    if (esFechaISO(iso)) return iso;
  }
  return null;
}

// Lee el CSV de importación del menú. Columnas: fecha, persona, franja, hora, texto
export function leerImportacion(texto) {
  const filas = parseCSV(texto);
  const errores = [];
  if (!filas.length) return { filas: [], errores: [{ linea: 0, motivo: 'El archivo está vacío' }], personas: [] };
  const cab = filas[0].map(clave);
  const col = (n) => cab.indexOf(n);
  const iF = col('fecha'), iP = col('persona'), iFr = col('franja'), iH = col('hora'), iT = col('texto');
  if ([iF, iP, iFr, iT].some((i) => i < 0)) {
    return { filas: [], errores: [{ linea: 1, motivo: 'Faltan columnas. Tienen que ser: fecha, persona, franja, hora, texto' }], personas: [] };
  }
  const franjasValidas = new Set(FRANJAS.map((f) => f.id));
  const out = [];
  for (let i = 1; i < filas.length; i++) {
    const r = filas[i];
    const fecha = fechaDeCSV(r[iF]);
    const persona = String(r[iP] || '').trim();
    const franja = clave(r[iFr]);
    const hora = iH >= 0 ? String(r[iH] || '').trim() : '';
    const textoFila = String(r[iT] || '').replace(/\r/g, '').trim();
    if (!fecha) { errores.push({ linea: i + 1, motivo: 'Fecha no válida' }); continue; }
    if (!persona) { errores.push({ linea: i + 1, motivo: 'Falta la persona' }); continue; }
    if (!franjasValidas.has(franja)) { errores.push({ linea: i + 1, motivo: `Franja no válida: ${r[iFr]}` }); continue; }
    if (hora && !esHora(hora)) { errores.push({ linea: i + 1, motivo: `Hora no válida: ${hora}` }); continue; }
    if (!textoFila) continue; // franja vacía: se ignora
    out.push({ fecha, persona, franja, hora: hora || null, texto: textoFila.slice(0, 1000) });
  }
  return { filas: out, errores, personas: [...new Set(out.map((f) => f.persona))] };
}

// ---------- color ----------
export function colorSuave(hex, alfa = 0.18) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

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
  { id: 'compromiso', nombre: 'Cita', icono: '📌' },
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
  if (ev.dias_semana && ev.dias_semana.length) { // varios días a la semana: se mira día a día desde la fecha de inicio
    const dias = new Set(ev.dias_semana.map(Number));
    for (let d = ev.fecha > desde ? ev.fecha : desde; d <= fin; d = sumarDias(d, 1)) if (dias.has(diaSemana(d)) && !exc.has(d)) out.push(d);
    return out;
  }
  let f = ev.fecha;
  if (f < desde) f = sumarDias(f, Math.ceil(diffDias(desde, f) / 7) * 7);
  for (; f <= fin; f = sumarDias(f, 7)) if (!exc.has(f)) out.push(f);
  return out;
}

// Días de la semana elegidos para repetir (0 = lunes … 6 = domingo). Devuelve null si equivale a «el día de su fecha».
export function normalizarDias(dias, fecha) {
  const u = [...new Set((dias || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  return !u.length || (u.length === 1 && u[0] === diaSemana(fecha)) ? null : u;
}
const DIAS_CORTOS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
// «cada semana» o «cada semana (lun, mié y vie)»
export function descripcionRepeticion(ev) {
  const d = (ev.dias_semana || []).map(Number).filter((x) => x >= 0 && x <= 6);
  if (!d.length) return 'cada semana';
  const n = d.map((i) => DIAS_CORTOS[i]);
  return `cada semana (${n.length > 1 ? `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}` : n[0]})`;
}

// Días que dura un evento además del primero (0 = acaba el mismo día; 1 = acaba al día siguiente…)
export const diasExtra = (ev) => Math.max(0, Number(ev && ev.dias_extra) || 0);
// Último día de la ocurrencia que empieza en «fecha»
export const fechaFinDe = (ev, fecha) => sumarDias(fecha || ev.fecha, diasExtra(ev));

const minDe = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
// Qué parte de un evento de varios días se ve en un día concreto:
//  'unico' (acaba el mismo día), 'primero', 'medio' o 'ultimo'
// Tramo horario de esa parte dentro del día (en minutos), o null si ocupa «todo el día».
export function tramoDia(x) {
  const hi = hhmm(x.ev.hora_inicio), hf = hhmm(x.ev.hora_fin);
  if (!hi) return null;
  if (x.parte === 'primero') return { a: minDe(hi), b: 1440 };
  if (x.parte === 'medio') return null;
  if (x.parte === 'ultimo') return hf ? { a: 0, b: minDe(hf) } : null;
  return { a: minDe(hi), b: hf ? minDe(hf) : null };
}
// Texto de la hora de una parte: «19:30–21:00», «22:00 →», «→ 06:00» o «Todo el día»
export function textoHora(x) {
  const hi = hhmm(x.ev.hora_inicio), hf = hhmm(x.ev.hora_fin);
  if (!hi) return 'Todo el día';
  if (x.parte === 'primero') return `${hi} →`;
  if (x.parte === 'medio') return 'Todo el día';
  if (x.parte === 'ultimo') return hf ? `→ ${hf}` : 'Todo el día';
  return hi + (hf ? '–' + hf : '');
}

// Orden dentro de un día: primero los eventos sin hora (y los que vienen de ayer), luego por hora
export function compararEventos(a, b) {
  const clave = (x) => { const t = tramoDia(x); return t ? `${String(Math.floor(t.a / 60)).padStart(2, '0')}:${String(t.a % 60).padStart(2, '0')}` : ''; };
  const ha = clave(a), hb = clave(b);
  if (ha !== hb) return ha < hb ? -1 : 1; // '' (sin hora) queda primero
  const t = (a.ev.titulo || '').localeCompare(b.ev.titulo || '', 'es');
  return t !== 0 ? t : String(a.ev.id).localeCompare(String(b.ev.id));
}

// Devuelve un Map día -> [{ev, fecha, dia, parte}] ordenado.
// «fecha» es el día en que EMPIEZA esa ocurrencia (sirve para identificarla: hechas, excepciones…) y «dia» el día en que se muestra.
export function expandirEventos(eventos, desde, hasta) {
  const mapa = new Map();
  for (const ev of eventos) {
    const extra = diasExtra(ev);
    for (const fecha of ocurrencias(ev, sumarDias(desde, -extra), hasta)) {
      for (let k = 0; k <= extra; k++) {
        const dia = sumarDias(fecha, k);
        if (dia < desde || dia > hasta) continue;
        if (!mapa.has(dia)) mapa.set(dia, []);
        mapa.get(dia).push({ ev, fecha, dia, parte: extra === 0 ? 'unico' : k === 0 ? 'primero' : k === extra ? 'ultimo' : 'medio' });
      }
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
  // Excel guarda las fechas como número de días desde el 30/12/1899
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n >= 36526 && n <= 73050) return sumarDias('1899-12-30', n); // años 2000-2099
  }
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    if (esFechaISO(iso)) return iso;
  }
  return null;
}

// Hora escrita a mano ("8:30", "08:30:00") o guardada por Excel (fracción del día: 0.354166…)
function horaDeCelda(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) < 1) {
    const min = Math.round(Number(s) * 1440) % 1440;
    return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  }
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return m ? `${pad(m[1])}:${m[2]}` : s;
}

// Lee la importación del menú desde un CSV (texto) o desde las filas de un Excel (lista de listas).
// Columnas: fecha, persona, franja, hora, texto
export function leerImportacion(entrada) {
  const filas = Array.isArray(entrada) ? entrada : parseCSV(entrada);
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
    const hora = iH >= 0 ? horaDeCelda(r[iH]) : '';
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

// Plantilla del plan semanal: una fila por plato, con cantidades y trabajo previo. Los nombres de ejemplo no coinciden con nadie.
export function plantillaPlanSemanal() {
  const dias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  return [
    {
      nombre: 'Plan semanal',
      anchos: [9, 12, 15, 8, 14, 38, 10, 9, 16],
      listas: [
        { columna: 1, valores: dias },
        { columna: 2, valores: FRANJAS.map((f) => f.nombre) },
        { columna: 7, valores: ['g', 'ml', 'ración', 'ud'] },
        { columna: 8, valores: ['Sí', 'No'] },
      ],
      filas: [
        ['Semana', 'Día', 'Momento', 'Hora', 'Persona', 'Plato', 'Cantidad', 'Unidad', 'Trabajo previo día anterior'],
        [1, 'Lunes', 'Desayuno', '08:30', 'Nombre 1', 'Overnight oats', 1, 'ración', 'Sí'],
        [1, 'Lunes', 'Desayuno', '09:00', 'Nombre 2', 'Tostada con tomate', 2, 'ud', 'No'],
        [1, 'Lunes', 'Comida', '14:00', 'Nombre 1', 'Lentejas', 350, 'g', 'Sí'],
        [1, 'Lunes', 'Comida', '14:00', 'Nombre 1', 'Fruta del tiempo', 1, 'ud', 'No'],
        [1, 'Lunes', 'Comida', '14:00', 'Nombre 2', 'Lentejas', 250, 'g', 'Sí'],
        [1, 'Martes', 'Cena', '21:30', 'Nombre 1', 'Tortilla francesa', 0.75, 'ración', 'No'],
        [2, 'Lunes', 'Comida', '14:00', 'Nombre 1', 'Arroz con pollo', 400, 'g', 'No'],
      ],
    },
    {
      nombre: 'Cómo rellenar',
      anchos: [105],
      filas: [
        ['Cómo rellenar el plan semanal'],
        ['Esta plantilla sirve para planes de varias semanas, con cantidades y avisos de preparación. Si solo quieres apuntar comidas con su fecha, usa la plantilla sencilla.'],
        ['1. Una fila por plato. Todas las filas con la misma semana, día, momento y persona se juntan en una sola comida. Puedes borrar las filas de ejemplo.'],
        ['2. Semana: 1, 2, 3… No hace falta poner fechas: al importar eliges con qué lunes empieza la primera semana.'],
        ['3. Día y Momento: elígelos de la lista (de lunes a domingo; desayuno, media mañana, comida, merienda o cena).'],
        ['4. Hora: opcional, por ejemplo 14:00. Si pones horas distintas en un mismo momento, la primera es la de la comida.'],
        ['5. Persona: el nombre de quien come. Puede haber una o varias personas, con los nombres que quieras. Al importar eliges quién es quién en la app.'],
        ['6. Plato, Cantidad y Unidad: por ejemplo «Lentejas · 350 g». En «ración» puedes poner 0,5 (media), 0,75 (tres cuartos), 1…'],
        ['7. Trabajo previo día anterior: pon Sí si ese plato hay que dejarlo hecho la víspera (overnight oats, marinar, guisos largos…). Al importar, la app puede crear una tarea el día anterior con la lista de platos.'],
        ['8. Guarda el archivo como Excel (.xlsx) y súbelo en Organizapp: Más → Importar menú.'],
      ],
    },
  ];
}

// ---------- plan semanal (hoja plana «Menú simple» de un plan de alimentación) ----------
// Una fila por semana, día, momento, persona y plato, con cantidad, unidad y «trabajo previo el día anterior» (Sí/No).
const DIAS_PLAN = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const afirmativo = (s) => ['si', 's', '1', 'x', 'true', 'verdadero', 'yes'].includes(clave(s));
const FRACCIONES = [[1 / 5, '1/5'], [1 / 4, '1/4'], [1 / 3, '1/3'], [2 / 5, '2/5'], [1 / 2, '1/2'], [3 / 5, '3/5'], [2 / 3, '2/3'], [3 / 4, '3/4'], [4 / 5, '4/5']];

export function esPlanSemanal(filas) {
  if (!Array.isArray(filas) || !filas.length) return false;
  const c = filas[0].map(clave);
  return ['semana', 'dia', 'momento', 'persona', 'plato'].every((n) => c.includes(n));
}

export function cantidadTexto(valor, unidad) {
  const c = Number(String(valor ?? '').replace(',', '.'));
  const u = String(unidad || '').trim();
  if (!Number.isFinite(c) || c <= 0) return u;
  if (clave(u) === 'racion') {
    const ent = Math.floor(c + 0.02), resto = c - ent;
    if (Math.abs(c - Math.round(c)) < 0.02) return `${Math.round(c)} ${Math.round(c) === 1 ? 'ración' : 'raciones'}`;
    const f = FRACCIONES.find(([v]) => Math.abs(resto - v) < 0.02);
    if (f) return ent ? `${ent} ${f[1]} raciones` : `${f[1]} ración`;
    return `${String(Math.round(c * 10) / 10).replace('.', ',')} raciones`;
  }
  const n = Math.abs(c - Math.round(c)) < 0.05 ? String(Math.round(c)) : String(Math.round(c * 10) / 10).replace('.', ',');
  return `${n} ${u}`.trim();
}

export function leerPlanSemanal(filas) {
  const c = filas[0].map(clave);
  const ix = (n) => c.indexOf(n);
  const iPrevio = c.findIndex((x) => x.startsWith('trabajo_previo') || x === 'tarea' || x === 'previo');
  const [iS, iD, iM, iH, iP, iPl, iC, iU] = ['semana', 'dia', 'momento', 'hora', 'persona', 'plato', 'cantidad', 'unidad'].map(ix);
  const franjas = new Set(FRANJAS.map((f) => f.id));
  const out = [], errores = [];
  const nombres = new Map(); // «ana», «Ana » y «ANA» son la misma persona: se queda la primera forma escrita
  for (let i = 1; i < filas.length; i++) {
    const r = filas[i];
    if (!r || r.every((x) => String(x ?? '').trim() === '')) continue;
    const semana = parseInt(String(r[iS]).trim(), 10);
    const dia = DIAS_PLAN.indexOf(clave(r[iD]));
    const franja = clave(r[iM]);
    const hora = iH >= 0 ? horaDeCelda(r[iH]) : '';
    const personaCruda = String(r[iP] || '').replace(/\s+/g, ' ').trim();
    const kp = sinTildes(personaCruda.toLowerCase());
    if (personaCruda && !nombres.has(kp)) nombres.set(kp, personaCruda);
    const persona = nombres.get(kp) || '';
    const plato = String(r[iPl] || '').replace(/\s+/g, ' ').trim();
    if (!Number.isInteger(semana) || semana < 1) { errores.push({ linea: i + 1, motivo: 'Semana no válida' }); continue; }
    if (dia < 0) { errores.push({ linea: i + 1, motivo: `Día no válido: ${r[iD]}` }); continue; }
    if (!franjas.has(franja)) { errores.push({ linea: i + 1, motivo: `Momento no válido: ${r[iM]}` }); continue; }
    if (hora && !esHora(hora)) { errores.push({ linea: i + 1, motivo: `Hora no válida: ${hora}` }); continue; }
    if (!persona) { errores.push({ linea: i + 1, motivo: 'Falta la persona' }); continue; }
    if (!plato) continue;
    out.push({
      semana, dia, franja, hora: hora || null, persona, plato,
      cantidad: cantidadTexto(iC >= 0 ? r[iC] : '', iU >= 0 ? r[iU] : ''),
      previo: iPrevio >= 0 && afirmativo(r[iPrevio]),
    });
  }
  return {
    filas: out, errores,
    personas: [...new Set(out.map((f) => f.persona))],
    semanas: [...new Set(out.map((f) => f.semana))].sort((a, b) => a - b),
  };
}

export const PREFIJO_PREPARAR = 'Preparar para mañana';

// Pone fechas al plan. `lunes` = lunes de la primera semana del archivo; `semanas` = las que se importan;
// `personas` = quiénes se importan (null = todas). Devuelve las comidas y las tareas de preparación del día anterior.
export function planAFechas(plan, lunes, semanas, { personas = null, horaTarea = '21:00', hoy = null } = {}) {
  const base = plan.semanas[0];
  const elegidas = new Set(semanas);
  const grupos = new Map();
  const previos = new Map(); // fecha de la comida → platos que necesitan trabajo previo
  for (const f of plan.filas) {
    if (!elegidas.has(f.semana) || (personas && !personas.has(f.persona))) continue;
    const fecha = sumarDias(lunes, (f.semana - base) * 7 + f.dia);
    const k = `${fecha}|${f.franja}|${f.persona}`;
    if (!grupos.has(k)) grupos.set(k, { fecha, franja: f.franja, persona: f.persona, hora: f.hora, lineas: [] });
    const g = grupos.get(k);
    const linea = `${f.plato}${f.cantidad ? ' · ' + f.cantidad : ''}`;
    g.lineas.push(f.hora && g.hora && f.hora !== g.hora ? `${f.hora} ${linea}` : linea);
    if (f.previo) { if (!previos.has(fecha)) previos.set(fecha, []); previos.get(fecha).push(f); }
  }
  const filas = [...grupos.values()].map((g) => ({ fecha: g.fecha, persona: g.persona, franja: g.franja, hora: g.hora, texto: g.lineas.join('\n').slice(0, 1000) }));
  const tareas = [];
  let omitidas = 0;
  for (const [fecha, lista] of [...previos].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dia = sumarDias(fecha, -1);
    if (hoy && dia < hoy) { omitidas++; continue; }
    const nombres = [...new Set(lista.map((f) => f.plato))];
    // título corto (cabe en cualquier vista); la lista completa de platos va en las notas
    const titulo = nombres.length === 1 ? `${PREFIJO_PREPARAR}: ${nombres[0]}`.slice(0, 120) : `${PREFIJO_PREPARAR} (${nombres.length} platos)`;
    const porPlato = new Map();
    for (const f of lista) {
      const k = `${f.franja}|${f.plato}`;
      if (!porPlato.has(k)) porPlato.set(k, { franja: FRANJAS.find((x) => x.id === f.franja).nombre, plato: f.plato, quien: [] });
      if (!porPlato.get(k).quien.includes(f.persona)) porPlato.get(k).quien.push(f.persona);
    }
    // cada plato es un paso de la tarea (se marca al dejarlo hecho)
    const lineas = [...porPlato.values()].map((p) => `${p.franja}: ${p.plato} (${p.quien.join(', ')})`.slice(0, 200)).slice(0, 100);
    tareas.push({ fecha: dia, hora: horaTarea, titulo, lineas });
  }
  return { filas, tareas, omitidas };
}

// Entrada: filas (de un .xlsx) o texto CSV. Devuelve { plan } si es la hoja plana de un plan semanal, o el resultado normal.
export function analizarImportacion(entrada) {
  const filas = Array.isArray(entrada) ? entrada : parseCSV(entrada);
  return esPlanSemanal(filas) ? { plan: leerPlanSemanal(filas) } : leerImportacion(filas);
}

// ---------- color ----------
export function colorSuave(hex, alfa = 0.18) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

// ---------- plantilla de importación (para generar el Excel) ----------
export function plantillaMenu() {
  return [
    {
      nombre: 'Menú',
      anchos: [14, 14, 16, 8, 60],
      lista: { columna: 2, valores: FRANJAS.map((f) => f.nombre) },
      filas: [
        ['Fecha', 'Persona', 'Franja', 'Hora', 'Texto'],
        ['26/10/2026', 'Ejemplo', 'Desayuno', '08:30', 'Avena con leche\nFruta del tiempo'],
        ['26/10/2026', 'Ejemplo', 'Comida', '14:00', 'Lentejas con verduras\nEnsalada'],
        ['27/10/2026', 'Ejemplo', 'Cena', '21:30', 'Tortilla francesa y pan'],
      ],
    },
    {
      nombre: 'Cómo rellenar',
      anchos: [100],
      filas: [
        ['Cómo rellenar la plantilla'],
        ['1. Escribe cada comida en una fila de la hoja «Menú». Puedes borrar las filas de ejemplo (las de persona «Ejemplo» no se importan).'],
        ['2. Fecha: el día de la comida, por ejemplo 26/10/2026.'],
        ['3. Persona: el nombre de quien come. Si no coincide con el de la app, al importar podrás elegir quién es quién.'],
        ['4. Franja: elige de la lista (Desayuno, Media mañana, Comida, Merienda, Cena).'],
        ['5. Hora: opcional, por ejemplo 14:00.'],
        ['6. Texto: lo que se come. Puedes poner varias líneas en la misma celda (Alt + Intro en Excel).'],
        ['7. Guarda el archivo como Excel (.xlsx) y súbelo en Organizapp: Más → Importar menú.'],
      ],
    },
  ];
}

// ---------- calendario .ics (iCalendar) ----------
// Lee un archivo .ics y devuelve los eventos de hoy en adelante, ya en el formato de la app. Función pura (no toca pantalla ni red).
// Las repeticiones semanales pasan a ser una serie (con sus días); el resto (diaria, mensual, anual, cada N semanas)
// se convierte en fechas sueltas de los próximos meses. Lo que no se puede traducir se cuenta en «omitidos».
export const LIMITES_ICS = { eventos: 500, dias: 120, porSerie: 60, diasEvento: 30 };

function desdoblarICS(texto) {
  const out = [];
  for (const l of String(texto).replace(/\r\n?/g, '\n').split('\n')) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && out.length) out[out.length - 1] += l.slice(1);
    else if (l) out.push(l);
  }
  return out;
}
function propICS(linea) {
  let comillas = false, i = 0;
  for (; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') comillas = !comillas; else if (c === ':' && !comillas) break;
  }
  if (i >= linea.length) return null;
  const [nombre, ...ps] = linea.slice(0, i).split(';');
  const params = {};
  for (const p of ps) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); }
  return { nombre: nombre.toUpperCase(), params, valor: linea.slice(i + 1) };
}
const desescaparICS = (s) => String(s).replace(/\\(.)/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

function partesZona(ms, zona) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zona || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
const aFechaHoraZona = (ms, zona) => {
  const p = partesZona(ms, zona);
  return { fecha: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, hora: `${pad(p.h)}:${pad(p.mi)}` };
};
function zonaAUTC(y, mo, d, h, mi, tz) { // hora «de pared» en la zona tz → milisegundos UTC (lanza error si tz no existe)
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let res = guess;
  for (let i = 0; i < 2; i++) {
    const p = partesZona(res, tz);
    res = guess - (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - res);
  }
  return res;
}
// «20261024», «20261024T200000», «20261024T180000Z», con TZID opcional. Devuelve { fecha, hora|null, todoElDia }
function fechaICS(valor, params, zona) {
  const v = String(valor).trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return { fecha: `${m[1]}-${m[2]}-${m[3]}`, hora: null, todoElDia: true };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
  if (m[7]) return { ...aFechaHoraZona(Date.UTC(y, mo - 1, d, h, mi), zona), todoElDia: false };
  if (params && params.TZID) {
    try { return { ...aFechaHoraZona(zonaAUTC(y, mo, d, h, mi, params.TZID), zona), todoElDia: false }; } catch { /* zona desconocida: se toma la hora tal cual */ }
  }
  return { fecha: `${m[1]}-${m[2]}-${m[3]}`, hora: `${m[4]}:${m[5]}`, todoElDia: false };
}
function textoLimpioICS(s) {
  return desescaparICS(s).replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}

const DIAS_ICS = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
function reglaICS(valor) {
  const r = {};
  for (const par of String(valor).split(';')) { const k = par.indexOf('='); if (k > 0) r[par.slice(0, k).toUpperCase()] = par.slice(k + 1); }
  return r;
}
// ¿Sabemos traducir esta regla de repetición?
function reglaSoportada(r, fecha) {
  const f = r.FREQ;
  const porDia = r.BYDAY ? r.BYDAY.split(',').map((s) => s.trim()) : [];
  if (porDia.some((x) => !(x in DIAS_ICS))) return false; // «el primer lunes del mes», etc.
  if (r.BYSETPOS || r.BYWEEKNO || r.BYYEARDAY || r.BYHOUR || r.BYMINUTE) return false;
  const [, m, d] = fecha.split('-').map(Number);
  if (f === 'DAILY' || f === 'WEEKLY') return !r.BYMONTHDAY && !r.BYMONTH;
  if (f === 'MONTHLY') return !porDia.length && !r.BYMONTH && (!r.BYMONTHDAY || Number(r.BYMONTHDAY) === d);
  if (f === 'YEARLY') return !porDia.length && (!r.BYMONTH || Number(r.BYMONTH) === m) && (!r.BYMONTHDAY || Number(r.BYMONTHDAY) === d);
  return false;
}
// Fechas en que ocurre (sin contar excepciones), en orden y sin fin: quien la use pone el límite.
function* instanciasICS(fecha, r) {
  const paso = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const dias = r.BYDAY ? [...new Set(r.BYDAY.split(',').map((s) => DIAS_ICS[s.trim()]))].sort((a, b) => a - b) : null;
  const [y, m, d] = fecha.split('-').map(Number);
  if (r.FREQ === 'DAILY') {
    for (let k = 0; ; k++) { const x = sumarDias(fecha, k * paso); if (!dias || dias.includes(diaSemana(x))) yield x; }
  } else if (r.FREQ === 'WEEKLY') {
    const dd = dias && dias.length ? dias : [diaSemana(fecha)];
    const lunes = inicioSemana(fecha);
    for (let k = 0; ; k++) for (const di of dd) { const x = sumarDias(lunes, k * 7 * paso + di); if (x >= fecha) yield x; }
  } else if (r.FREQ === 'MONTHLY') {
    for (let k = 0; ; k++) {
      const t = y * 12 + (m - 1) + k * paso, yy = Math.floor(t / 12), mm = (t % 12) + 1;
      if (d <= new Date(Date.UTC(yy, mm, 0)).getUTCDate()) yield `${yy}-${pad(mm)}-${pad(d)}`;
    }
  } else if (r.FREQ === 'YEARLY') {
    for (let k = 0; ; k++) {
      const yy = y + k * paso;
      if (d <= new Date(Date.UTC(yy, m, 0)).getUTCDate()) yield `${yy}-${pad(m)}-${pad(d)}`;
    }
  }
}

export function leerICS(texto, { desde = hoyISO(), zona } = {}) {
  const lineas = desdoblarICS(texto);
  const crudos = [];
  let actual = null;
  for (const l of lineas) {
    const u = l.toUpperCase();
    if (u === 'BEGIN:VEVENT') { actual = { props: [] }; continue; }
    if (u === 'END:VEVENT') { if (actual) crudos.push(actual); actual = null; continue; }
    if (actual) { const p = propICS(l); if (p) actual.props.push(p); }
  }
  const out = { eventos: [], omitidos: [], pasados: 0, truncado: false, encontrados: crudos.length };
  if (!lineas.some((l) => l.toUpperCase() === 'BEGIN:VCALENDAR')) return { ...out, error: 'Este archivo no parece un calendario .ics.' };

  // 1) cada VEVENT → un registro sencillo
  const regs = [];
  for (const c of crudos) {
    const una = (n) => c.props.find((p) => p.nombre === n);
    if ((una('STATUS')?.valor || '').toUpperCase() === 'CANCELLED') continue;
    const ini = una('DTSTART');
    const inicio = ini && fechaICS(ini.valor, ini.params, zona);
    const titulo = (textoLimpioICS(una('SUMMARY')?.valor || '').replace(/\s*\n\s*/g, ' ') || '(sin título)').slice(0, 120);
    if (!inicio) { out.omitidos.push({ titulo, motivo: 'sin fecha de inicio válida' }); continue; }
    let hora_fin = null, diasExtra = 0;
    const fin = una('DTEND') && fechaICS(una('DTEND').valor, una('DTEND').params, zona);
    if (fin) {
      const dif = diffDias(fin.fecha, inicio.fecha);
      if (inicio.todoElDia) diasExtra = Math.max(0, dif - 1); // en los de día completo, el fin del .ics no cuenta (es el día siguiente al último)
      else if (dif <= 0) { if (fin.hora && inicio.hora && fin.hora > inicio.hora) hora_fin = fin.hora; }
      else if (fin.hora && fin.hora !== '00:00') { diasExtra = dif; hora_fin = fin.hora; } // acaba otro día a una hora
      else diasExtra = dif - 1; // acaba justo a medianoche: el último día es el anterior
    }
    const lugar = una('LOCATION') ? textoLimpioICS(una('LOCATION').valor) : '';
    const desc = una('DESCRIPTION') ? textoLimpioICS(una('DESCRIPTION').valor) : '';
    const notas = [lugar ? `Lugar: ${lugar}` : '', desc].filter(Boolean).join('\n').slice(0, 1000) || null;
    const exd = [];
    for (const p of c.props.filter((x) => x.nombre === 'EXDATE')) for (const v of p.valor.split(',')) { const f = fechaICS(v, p.params, zona); if (f) exd.push(f.fecha); }
    const rid = una('RECURRENCE-ID') && fechaICS(una('RECURRENCE-ID').valor, una('RECURRENCE-ID').params, zona);
    regs.push({
      uid: una('UID')?.valor || '', titulo, fecha: inicio.fecha, hora_inicio: inicio.todoElDia ? null : inicio.hora, hora_fin, notas, diasExtra,
      regla: una('RRULE') ? reglaICS(una('RRULE').valor) : null, exd, rid: rid ? rid.fecha : null, zonaUntil: zona,
    });
  }
  // 2) una ocurrencia cambiada de una serie (RECURRENCE-ID) sustituye a la de la serie
  for (const r of regs.filter((x) => x.rid)) {
    const madre = regs.find((x) => !x.rid && x.uid && x.uid === r.uid);
    if (madre) madre.exd.push(r.rid);
  }

  const evs = [];
  const poner = (e) => evs.push({ uid: e.uid, notas: null, diasExtra: 0, excepciones: [], repeticion: null, dias_semana: null, repite_hasta: null, ...e });
  for (const r of regs) {
    const base = { uid: r.uid, titulo: r.titulo, hora_inicio: r.hora_inicio, hora_fin: r.hora_fin, notas: r.notas, diasExtra: r.diasExtra };
    if (r.diasExtra > LIMITES_ICS.diasEvento) { out.omitidos.push({ titulo: r.titulo, motivo: `dura más de ${LIMITES_ICS.diasEvento} días` }); continue; }
    if (!r.regla || r.rid) { // evento suelto
      if (sumarDias(r.fecha, r.diasExtra) < desde) { out.pasados++; continue; }
      poner({ ...base, fecha: r.fecha });
      continue;
    }
    const rg = r.regla;
    if (r.diasExtra > 6 && rg.FREQ === 'WEEKLY' && (parseInt(rg.INTERVAL, 10) || 1) === 1) { out.omitidos.push({ titulo: r.titulo, motivo: 'se repite cada semana y dura más de 6 días' }); continue; }
    if (!reglaSoportada(rg, r.fecha)) { out.omitidos.push({ titulo: r.titulo, motivo: 'repetición que la app no sabe hacer (por ejemplo, «el primer lunes de cada mes»)' }); continue; }
    const hastaUntil = rg.UNTIL ? (fechaICS(rg.UNTIL, {}, r.zonaUntil)?.fecha || null) : null;
    const cuenta = rg.COUNT ? parseInt(rg.COUNT, 10) : 0;
    const exd = new Set(r.exd);
    if (rg.FREQ === 'WEEKLY' && (parseInt(rg.INTERVAL, 10) || 1) === 1) {
      // serie semanal: se guarda como serie
      const dias = rg.BYDAY ? [...new Set(rg.BYDAY.split(',').map((s) => DIAS_ICS[s.trim()]))].sort((a, b) => a - b) : [diaSemana(r.fecha)];
      let ultima = null;
      if (cuenta) { let n = 0; for (const d of instanciasICS(r.fecha, rg)) { if (++n >= cuenta) { ultima = d; break; } if (n > 5000) break; } }
      const hasta = [hastaUntil, ultima].filter(Boolean).sort()[0] || null;
      if (hasta && hasta < desde) { out.pasados++; continue; }
      const tmp = { fecha: r.fecha, repeticion: 'semanal', dias_semana: dias, repite_hasta: hasta, excepciones: [] };
      let ini = r.fecha;
      if (r.fecha < desde) { const p = ocurrencias(tmp, desde, sumarDias(desde, 7))[0]; if (!p) { out.pasados++; continue; } ini = p; }
      poner({ ...base, fecha: ini, repeticion: 'semanal', dias_semana: normalizarDias(dias, ini), repite_hasta: hasta, excepciones: [...exd].filter((d) => d >= ini).sort() });
    } else {
      // el resto: fechas sueltas de los próximos meses
      const limite = sumarDias(desde, LIMITES_ICS.dias);
      const fechas = []; let n = 0, corta = false;
      for (const d of instanciasICS(r.fecha, rg)) {
        if (++n > 20000) break;
        if (cuenta && n > cuenta) break;
        if (hastaUntil && d > hastaUntil) break;
        if (d > limite) { corta = true; break; }
        if (d < desde || exd.has(d)) continue;
        if (fechas.length >= LIMITES_ICS.porSerie) { corta = true; break; }
        fechas.push(d);
      }
      if (!fechas.length) { out.pasados++; continue; }
      if (corta) out.truncado = true;
      poner({ ...base, fecha: fechas[0], fechas, expandido: true });
    }
  }
  evs.sort((a, b) => a.fecha.localeCompare(b.fecha) || String(a.hora_inicio || '').localeCompare(String(b.hora_inicio || '')) || a.titulo.localeCompare(b.titulo, 'es'));
  let total = 0;
  for (const e of evs) {
    const n = e.fechas ? e.fechas.length : 1;
    if (total + n > LIMITES_ICS.eventos) { out.truncado = true; continue; }
    total += n; out.eventos.push(e);
  }
  return out;
}

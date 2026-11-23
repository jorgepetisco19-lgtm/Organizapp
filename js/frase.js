// Organizapp · interpretar una frase («cita dentista el martes a las 12») y convertirla en los datos de un evento.
// Sin DOM y sin dependencias del navegador: se prueba con node y puede reutilizarse (p. ej. en una función de Supabase).
//
// Reglas (acordadas con Jorge):
//  · Tipo: solo si la frase EMPIEZA con «cita», «plan», «tarea» o «deporte» (tras «añade…», «apunta…», «una»…). Si no, «plan».
//  · Día: hoy, mañana, pasado mañana, «el martes» / «este martes» (el próximo que llegue), «el martes que viene» / «el próximo martes»
//    (el de la semana siguiente, de lunes a domingo), «el 25 de diciembre», «25/12», «el día 15», «en 3 días», «dentro de 2 semanas».
//    Sin día: hoy.
//  · Hora: «a las 12», «a las 17:30», «a las 8 y media de la noche», «de 17 a 18:30», «hasta las 19». Sin hora: evento sin hora.
//    Sin «de la mañana/tarde/noche»: de 1 a 6 se entiende de la tarde; de 7 a 12, tal cual.
//  · Repetición: «todos los martes», «los lunes y miércoles», «cada viernes», «todos los días», «entre semana», «los fines de semana»,
//    «todas las semanas»; «hasta el 30 de noviembre» pone el fin. «Cada dos semanas», «cada mes»… no existen en la app: se avisa y no se repite.
import { sumarDias, diaSemana, inicioSemana, normalizarDias, esFechaISO, pad, hoyISO } from './util.js';

const DIAS_N = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const MESES_N = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const NUM_PALABRA = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
const PALABRAS_NUM = Object.keys(NUM_PALABRA).sort((a, b) => b.length - a.length).join('|');
const RE_DIA = `(lunes|martes|miercoles|jueves|viernes|sabado|domingo)s?`;
const RE_MES = `(${MESES_N.join('|')})`;
const RE_NUM = `(\\d{1,2}|(?:${PALABRAS_NUM})(?![a-z]))`;
const num = (s) => (/^\d+$/.test(s) ? Number(s) : NUM_PALABRA[s]);
const TIPO_POR_PALABRA = { cita: 'compromiso', plan: 'plan', tarea: 'tarea', deporte: 'deporte' };

// Quita acentos sin cambiar la longitud (así las posiciones coinciden con el texto original).
const sinAcentos = (s) => Array.from(s.normalize('NFC')).map((c) => (c.length > 1 ? c : c.normalize('NFD')[0].toLowerCase())).join('');

function hora24(h, m, periodo) {
  if (periodo === 'tarde') { if (h < 12) h += 12; }
  else if (periodo === 'noche') { if (h === 12) h = 0; else if (h >= 6 && h < 12) h += 12; } // «las 3 de la noche» = 03:00
  else if (periodo === 'madrugada') { if (h === 12) h = 0; }
  else if (!periodo && h >= 1 && h <= 6) h += 12; // sin indicar: «a las 5» = 17:00
  return `${pad(h)}:${pad(m)}`;
}
const valida = (h, m) => Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;

export function interpretarFrase(texto, { hoy = hoyISO(), ahora = null } = {}) {
  const orig = String(texto || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const n = sinAcentos(orig);
  const usado = new Array(n.length).fill(false);
  const avisos = [];
  const libre = (i, f) => { for (let k = i; k < f; k++) if (usado[k]) return false; return true; };
  const tomar = (m) => { for (let k = m.index; k < m.index + m[0].length; k++) usado[k] = true; return m; };
  // Primera coincidencia de «re» que no pise lo ya usado
  const buscar = (re) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(n))) { if (libre(m.index, m.index + m[0].length)) return m; if (m[0].length === 0) g.lastIndex++; }
    return null;
  };

  let tipo = 'plan';
  let fecha = null, sinDia = true, hora_inicio = null, hora_fin = null;
  let dias = null, repite_hasta = null, repeticion = null;

  // ----- 1) Órdenes del principio («añade una cita …») y tipo -----
  let m = /^(?:(?:por favor|oye|vale|venga)[ ,]+)?(?:a[nñ]ade|a[nñ]adir|apunta(?:me)?|anota(?:me)?|crea|crear|pon(?:me)?|agrega|agregar|registra|nuevo|nueva)\b[ ,:]*/.exec(n);
  if (m) tomar(m);
  const ini = m ? m[0].length : 0;
  const mt = /^(?:(?:un|una|el|la|mi)\s+)?(?:(?:nuevo|nueva)\s+)?(?:(?:evento|cosa)\s+(?:de\s+tipo\s+|tipo\s+)?)?(cita|plan|tarea|deporte)\b[ ,:]*/.exec(n.slice(ini));
  if (mt) { tipo = TIPO_POR_PALABRA[mt[1]]; for (let k = ini; k < ini + mt[0].length; k++) usado[k] = true; }

  // ----- 2) Horas -----
  const periodoDe = (p) => p || null;
  const RE_PER = '(?:\\s+(?:de|por|en)\\s+la\\s+(manana|tarde|noche|madrugada))?';
  const T = `${RE_NUM}(?:[:.h]([0-5]\\d))?`;
  const HH = '(?:\\s*h(?:oras?)?\\b)?';
  // rango «de 17 a 18:30», «de las 5 a las 6 de la tarde»
  m = buscar(new RegExp(`\\bde(?:\\s+las?)?\\s+${T}${HH}\\s+a(?:\\s+las?)?\\s+${T}${HH}${RE_PER}`));
  if (m) {
    const h1 = num(m[1]), m1 = m[2] ? Number(m[2]) : 0, h2 = num(m[3]), m2 = m[4] ? Number(m[4]) : 0, per = periodoDe(m[5]);
    if (valida(h1, m1) && valida(h2, m2)) { tomar(m); hora_inicio = hora24(h1, m1, per); hora_fin = hora24(h2, m2, per); }
  }
  // «y media / y cuarto / menos cuarto / en punto»
  if (!hora_inicio) {
    m = buscar(new RegExp(`\\ba\\s+las?\\s+${RE_NUM}\\s+(y\\s+media|y\\s+cuarto|menos\\s+cuarto|en\\s+punto)${RE_PER}`));
    if (m) {
      let h = num(m[1]); const ex = m[2].replace(/\s+/g, ' '); const per = periodoDe(m[3]);
      const mi = ex === 'y media' ? 30 : ex === 'y cuarto' ? 15 : ex === 'menos cuarto' ? 45 : 0;
      if (ex === 'menos cuarto') h -= 1;
      if (valida(h, mi)) { tomar(m); hora_inicio = hora24(h, mi, per); }
    }
  }
  // «a las 12», «a las 17:30», «a la 1», «a las 12h30»
  if (!hora_inicio) {
    m = buscar(new RegExp(`\\ba\\s+las?\\s+${T}${HH}${RE_PER}`));
    if (m) {
      const h = num(m[1]), mi = m[2] ? Number(m[2]) : 0, per = periodoDe(m[3]);
      if (valida(h, mi)) { tomar(m); hora_inicio = hora24(h, mi, per); }
    }
  }
  if (!hora_inicio) { // «12:30» o «12.30» sin «a las»
    m = buscar(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b(?!\/)/);
    if (m) { tomar(m); hora_inicio = hora24(Number(m[1]), Number(m[2]), null); }
  }
  if (!hora_inicio && (m = buscar(/\b(?:a|al)\s+mediodia\b/))) { tomar(m); hora_inicio = '12:00'; }
  // «hasta las 19»
  if (hora_inicio && !hora_fin) {
    m = buscar(new RegExp(`\\bhasta\\s+las?\\s+${T}${HH}${RE_PER}`));
    if (m) {
      const h = num(m[1]), mi = m[2] ? Number(m[2]) : 0, per = periodoDe(m[3]);
      if (valida(h, mi)) { tomar(m); hora_fin = hora24(h, mi, per); }
    }
  }
  if (hora_fin && hora_inicio && hora_fin <= hora_inicio) { // «a las 7 de la tarde hasta las 8»: el 8 es de la tarde también
    const [hh, mm] = hora_fin.split(':').map(Number);
    if (hh < 12) { const alt = `${pad(hh + 12)}:${pad(mm)}`; if (alt > hora_inicio) hora_fin = alt; }
  }
  if (hora_fin && hora_inicio && hora_fin <= hora_inicio) { avisos.push('La hora de fin es anterior a la de inicio: la he quitado.'); hora_fin = null; }

  // ----- 3) Repetición -----
  const listaDias = (txt) => { const out = []; const g = new RegExp(RE_DIA, 'g'); let q; while ((q = g.exec(txt))) out.push(DIAS_N.indexOf(q[1])); return out; };
  const DIAS_LISTA = `${RE_DIA}(?:\\s*(?:,|y|e)\\s*${RE_DIA})*`;
  if ((m = buscar(/\b(?:cada\s+(?:dos|tres|\d+)\s+(?:semanas|dias|meses)|cada\s+(?:quince\s+dias|quincena|mes|ano)|quincenalmente|quincenal|mensualmente|mensual|anualmente|anual)\b/))) {
    tomar(m); avisos.push(`Solo sé repetir cada semana: «${m[0].trim()}» lo he dejado sin repetir.`);
  } else if ((m = buscar(/\b(?:todos\s+los\s+dias|cada\s+dia|diariamente|a\s+diario)\b/))) { tomar(m); dias = [0, 1, 2, 3, 4, 5, 6]; }
  else if ((m = buscar(/\b(?:entre\s+semana|de\s+lunes\s+a\s+viernes)\b/))) { tomar(m); dias = [0, 1, 2, 3, 4]; }
  else if ((m = buscar(/\b(?:todos\s+)?los\s+(?:fines?\s+de\s+semana|findes?)\b/))) { tomar(m); dias = [5, 6]; }
  else if ((m = buscar(new RegExp(`\\b(?:todos\\s+los|todas\\s+las|cada|los)\\s+${DIAS_LISTA}`)))) {
    tomar(m); dias = [...new Set(listaDias(m[0]))].sort((a, b) => a - b);
  } else if ((m = buscar(/\b(?:todas\s+las\s+semanas|cada\s+semana|semanalmente)\b/))) { tomar(m); repeticion = 'semanal'; }
  if (dias) repeticion = 'semanal';

  // ----- 4) Fechas -----
  const anoDe = (d, mes) => { // este año o el siguiente si ya pasó
    const y = Number(hoy.slice(0, 4));
    let f = `${y}-${pad(mes)}-${pad(d)}`;
    if (esFechaISO(f) && f < hoy) f = `${y + 1}-${pad(mes)}-${pad(d)}`;
    return f;
  };
  // dia, mes (número o nombre), año (opcional)
  const fechaDe = (dia, mes, anio) => {
    const d = Number(dia); const mm = /^\d+$/.test(mes) ? Number(mes) : MESES_N.indexOf(mes) + 1;
    const f = anio ? `${Number(anio.length === 2 ? '20' + anio : anio)}-${pad(mm)}-${pad(d)}` : anoDe(d, mm);
    return esFechaISO(f) ? f : null;
  };
  if (repeticion) { // «hasta el 30 de noviembre» / «hasta el 30/11»
    m = buscar(new RegExp(`\\bhasta\\s+(?:el\\s+)?(\\d{1,2})\\s+de\\s+${RE_MES}(?:\\s+de\\s+(\\d{4}))?`));
    if (m) { const f = fechaDe(m[1], m[2], m[3]); if (f) { tomar(m); repite_hasta = f; } }
    else if ((m = buscar(/\bhasta\s+(?:el\s+)?(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/))) {
      const f = fechaDe(m[1], m[2], m[3]); if (f) { tomar(m); repite_hasta = f; }
    }
  }
  const poner = (f) => { fecha = f; sinDia = false; };
  if ((m = buscar(new RegExp(`\\b(?:el\\s+(?:dia\\s+)?)?(\\d{1,2})\\s+de\\s+${RE_MES}(?:\\s+de\\s+(\\d{4}))?`)))) { // «25 de diciembre»
    const f = fechaDe(m[1], m[2], m[3]); if (f) { tomar(m); poner(f); }
  }
  if (!fecha && (m = buscar(/\b(?:el\s+(?:dia\s+)?)?(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/))) { // «25/12»
    const f = fechaDe(m[1], m[2], m[3]); if (f) { tomar(m); poner(f); }
  }
  if (!fecha && (m = buscar(/\bel\s+dia\s+(\d{1,2})\b/))) { // «el día 15»: de este mes o, si ya pasó, del siguiente
    const d = Number(m[1]); let y = Number(hoy.slice(0, 4)), mes = Number(hoy.slice(5, 7));
    let f = `${y}-${pad(mes)}-${pad(d)}`;
    if (esFechaISO(f) && f < hoy) { mes += 1; if (mes > 12) { mes = 1; y += 1; } f = `${y}-${pad(mes)}-${pad(d)}`; }
    if (esFechaISO(f)) { tomar(m); poner(f); }
  }
  if (!fecha && (m = buscar(/\b(?:hoy|esta\s+(?:tarde|noche|manana|madrugada))\b/))) { tomar(m); poner(hoy); }
  if (!fecha && (m = buscar(/\bpasado\s+manana\b/))) { tomar(m); poner(sumarDias(hoy, 2)); }
  if (!fecha && (m = buscar(/(?<!\bla )\bmanana\b/))) { tomar(m); poner(sumarDias(hoy, 1)); }
  if (!fecha && (m = buscar(new RegExp(`\\b(?:dentro\\s+de|en)\\s+${RE_NUM}\\s+(dias?|semanas?)\\b`)))) {
    const c = num(m[1]); if (c >= 1 && c <= 400) { tomar(m); poner(sumarDias(hoy, m[2].startsWith('semana') ? c * 7 : c)); }
  }
  // Día de la semana suelto (sin repetir): «el martes», «este martes», «el martes que viene», «el próximo martes»
  if (!fecha && !dias) {
    m = buscar(new RegExp(`\\b(?:(?:el|este|proximo|el\\s+proximo)\\s+)?${RE_DIA}(?:\\s+(?:que\\s+viene|proximo))?(?:\\s+de\\s+la\\s+semana\\s+que\\s+viene)?`));
    if (m) {
      const idx = DIAS_N.indexOf(m[1]); const t = m[0];
      let f;
      if (/que viene|proximo/.test(t)) f = sumarDias(inicioSemana(hoy), 7 + idx); // el de la semana siguiente (lunes a domingo)
      else if (/\beste\b/.test(t)) f = sumarDias(hoy, (idx - diaSemana(hoy) + 7) % 7); // «este martes»: hoy si es martes
      else { const d = (idx - diaSemana(hoy) + 7) % 7; f = sumarDias(hoy, d === 0 ? 7 : d); } // «el martes»: el próximo que llegue
      tomar(m); poner(f);
    }
  }
  // Con repetición: empieza en el primer día elegido que quede por delante (hoy solo si hay hora y aún no ha pasado)
  if (repeticion) {
    if (!fecha) {
      let f = hora_inicio && ahora && hora_inicio > ahora ? hoy : sumarDias(hoy, 1);
      if (dias) while (!dias.includes(diaSemana(f))) f = sumarDias(f, 1);
      fecha = f;
    } else if (dias && !dias.includes(diaSemana(fecha))) {
      let f = fecha; while (!dias.includes(diaSemana(f))) f = sumarDias(f, 1);
      fecha = f;
    }
  }
  if (!fecha) fecha = hoy;
  if (repite_hasta && repite_hasta < fecha) { avisos.push('«Hasta» es anterior al primer día: lo he quitado.'); repite_hasta = null; }

  // ----- 5) Título: lo que queda -----
  let titulo = '';
  for (let i = 0; i < orig.length; i++) titulo += usado[i] ? ' ' : orig[i];
  titulo = titulo.replace(/\s+/g, ' ').trim();
  const PAL = '(?:tengo|tenemos|tendre|hay|quiero|quedo|he\\s+quedado|que|con|de|del|para|a|al|el|la|los|las|un|una|y|e|en|por|o|desde)';
  // (el \b de JavaScript no entiende las letras con acento, así que se usan límites con letras Unicode)
  const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';
  const CONECT = new RegExp(`^(?:${PAL}${E}[\\s,:;.-]*)+`, 'iu');
  const CONECT_FIN = new RegExp(`[\\s,:;.-]*(?:${B}${PAL}${E}[\\s,:;.-]*)+$`, 'iu');
  for (let i = 0; i < 4; i++) {
    const s = titulo.replace(/^[\s,:;.-]+/, '').replace(/^(?:tengo\s+que|hay\s+que|tenemos\s+que)\s+/i, '').replace(CONECT, '').replace(CONECT_FIN, '').replace(/[\s,:;.-]+$/, '');
    if (s === titulo) break;
    titulo = s;
  }
  titulo = titulo.replace(/\s+/g, ' ').trim();
  if (titulo) titulo = titulo.charAt(0).toUpperCase() + titulo.slice(1);
  if (titulo.length > 120) { titulo = titulo.slice(0, 120).trim(); avisos.push('El título era muy largo: lo he cortado.'); }

  return {
    ok: !!titulo, sinTitulo: !titulo, sinDia,
    tipo, titulo, fecha, hora_inicio, hora_fin,
    repeticion,
    dias: repeticion ? (dias || [diaSemana(fecha)]) : null, // todos los días elegidos
    dias_semana: repeticion ? normalizarDias(dias || [diaSemana(fecha)], fecha) : null, // como se guarda (null = el día de la fecha)
    repite_hasta: repeticion ? repite_hasta : null,
    avisos,
  };
}

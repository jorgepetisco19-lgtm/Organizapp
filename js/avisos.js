// Avisos antes de los eventos (solo la app de Android los programa). Este archivo solo CALCULA qué avisos toca poner:
// no toca el móvil ni la base de datos, así se puede probar con node.
import { expandirEventos, hoyISO, sumarDias, hhmm, TIPOS } from './util.js';

export const AVISO_MIN_DEFECTO = 30; // minutos antes
export const AVISO_MINUTOS = [5, 10, 15, 30, 60];
export const AVISO_DIAS = 14;        // cuántos días por delante se programan
export const AVISO_MAX = 60;         // Android limita las alarmas por app: se programan las más próximas

// ¿Este evento es «mío»? De todos, mío o de un grupo en el que estoy.
export const participa = (ev, userId) =>
  !!userId && (ev.compartido === true || ev.owner_id === userId || (Array.isArray(ev.participantes) && ev.participantes.includes(userId)));

// Número estable (positivo, 31 bits) para el aviso de ESTE evento en ESTE día: así reprogramar no duplica nada.
export function idAviso(eventoId, fecha) {
  let h = 0x811c9dc5;
  const s = `${eventoId}|${fecha}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h & 0x7fffffff) || 1;
}

const textoAntes = (min) => (min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`);
const esHecha = (ev, fecha) => ev.tipo === 'tarea' && (ev.hechas || []).includes(ev.repeticion ? fecha : ev.fecha);

// Devuelve [{ id, cuando: Date, titulo, cuerpo }] ordenados por hora, solo de eventos con hora, aún por venir, no hechos.
export function planificarAvisos(eventos, { userId, ahora = new Date(), minutos = AVISO_MIN_DEFECTO, dias = AVISO_DIAS, max = AVISO_MAX } = {}) {
  const desde = hoyISO(ahora);
  const hasta = sumarDias(desde, dias);
  const mios = (eventos || []).filter((e) => participa(e, userId));
  const porDia = expandirEventos(mios, desde, hasta);
  const out = [];
  for (const lista of porDia.values()) {
    for (const x of lista) {
      if (x.dia !== x.fecha) continue; // solo el día en que EMPIEZA (un evento de varios días avisa una vez)
      const ev = x.ev;
      const hi = hhmm(ev.hora_inicio);
      if (!hi || esHecha(ev, x.fecha)) continue;
      const [y, m, d] = x.fecha.split('-').map(Number);
      const inicio = new Date(y, m - 1, d, Number(hi.slice(0, 2)), Number(hi.slice(3, 5)), 0, 0);
      const cuando = new Date(inicio.getTime() - minutos * 60000);
      if (cuando.getTime() <= ahora.getTime()) continue;
      const hf = hhmm(ev.hora_fin);
      const tipo = TIPOS.find((t) => t.id === ev.tipo);
      out.push({
        id: idAviso(ev.id, x.fecha),
        cuando,
        titulo: `${tipo && tipo.icono ? tipo.icono + ' ' : ''}${ev.titulo}`,
        cuerpo: `En ${textoAntes(minutos)} · ${hi}${hf ? '–' + hf : ''}`,
      });
    }
  }
  out.sort((a, b) => a.cuando - b.cuando || a.id - b.id);
  return out.slice(0, max);
}

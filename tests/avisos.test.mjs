// node --test tests/avisos.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { planificarAvisos, participa, idAviso, AVISO_MAX } from '../js/avisos.js';

const YO = 'u-yo', ELLA = 'u-ella', OTRO = 'u-otro';
const AHORA = new Date(2026, 9, 23, 10, 0, 0); // viernes 23 oct 2026, 10:00 (hora local)
const local = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi, 0, 0);
let n = 0;
const ev = (campos) => ({ id: `e${++n}`, tipo: 'plan', titulo: 'Cosa', fecha: '2026-10-23', hora_inicio: '12:00:00', hora_fin: null, repeticion: null,
  repite_hasta: null, excepciones: [], hechas: [], dias_semana: null, compartido: false, participantes: null, owner_id: YO, dias_extra: 0, ...campos });
const plan = (evs, extra = {}) => planificarAvisos(evs, { userId: YO, ahora: AHORA, ...extra });

test('participa: mío, de todos o de un grupo en el que estoy', () => {
  assert.equal(participa(ev({ owner_id: YO }), YO), true);
  assert.equal(participa(ev({ owner_id: ELLA, compartido: true }), YO), true);
  assert.equal(participa(ev({ owner_id: ELLA, participantes: [ELLA, YO] }), YO), true);
  assert.equal(participa(ev({ owner_id: ELLA, participantes: [ELLA, OTRO] }), YO), false);
  assert.equal(participa(ev({ owner_id: ELLA }), YO), false);
  assert.equal(participa(ev({ owner_id: YO }), null), false);
});

test('avisa 30 minutos antes con la hora en el texto', () => {
  const r = plan([ev({ titulo: 'Cena', hora_inicio: '12:00:00', hora_fin: '13:30:00' })]);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].cuando, local(2026, 10, 23, 11, 30));
  assert.equal(r[0].titulo, '🎟️ Cena');
  assert.equal(r[0].cuerpo, 'En 30 min · 12:00–13:30');
});

test('minutos configurables y texto "1 h"', () => {
  const r = plan([ev({ hora_inicio: '19:00:00' })], { minutos: 60 });
  assert.deepEqual(r[0].cuando, local(2026, 10, 23, 18, 0));
  assert.equal(r[0].cuerpo, 'En 1 h · 19:00');
  assert.equal(plan([ev({ hora_inicio: '19:00:00' })], { minutos: 10 })[0].cuerpo, 'En 10 min · 19:00');
});

test('no avisa de lo que ya pasó ni de lo que empieza en menos del margen', () => {
  assert.equal(plan([ev({ hora_inicio: '09:00:00' })]).length, 0);
  assert.equal(plan([ev({ hora_inicio: '10:20:00' })]).length, 0); // el aviso era a las 09:50
  assert.equal(plan([ev({ hora_inicio: '10:31:00' })]).length, 1);
});

test('solo lo mío: de todos y de mis grupos sí; lo de otra persona no', () => {
  const r = plan([
    ev({ titulo: 'mio' }),
    ev({ titulo: 'todos', owner_id: ELLA, compartido: true }),
    ev({ titulo: 'grupo-con-yo', owner_id: ELLA, participantes: [ELLA, YO] }),
    ev({ titulo: 'grupo-sin-yo', owner_id: ELLA, participantes: [ELLA, OTRO] }),
    ev({ titulo: 'de-ella', owner_id: ELLA }),
  ]);
  assert.deepEqual(r.map((x) => x.titulo.replace(/^\S+ /, '')).sort(), ['grupo-con-yo', 'mio', 'todos']);
});

test('sin hora no hay aviso', () => {
  assert.equal(plan([ev({ hora_inicio: null })]).length, 0);
});

test('tareas hechas no avisan (y una que se repite se marca día a día)', () => {
  assert.equal(plan([ev({ tipo: 'tarea', hechas: ['2026-10-23'] })]).length, 0);
  assert.equal(plan([ev({ tipo: 'tarea', hechas: [] })]).length, 1);
  const semanal = ev({ tipo: 'tarea', fecha: '2026-10-26', hora_inicio: '09:00:00', repeticion: 'semanal', hechas: ['2026-10-26'] });
  const r = plan([semanal]);
  assert.equal(r.length, 1); // el lunes 26 está hecho; queda el 2 nov
  assert.deepEqual(r[0].cuando, local(2026, 11, 2, 8, 30));
});

test('repeticiones semanales: solo los próximos 14 días y respetando excepciones', () => {
  const lunes = ev({ fecha: '2026-10-12', hora_inicio: '19:00:00', repeticion: 'semanal' });
  assert.deepEqual(plan([lunes]).map((x) => x.cuando.getTime()), [local(2026, 10, 26, 18, 30), local(2026, 11, 2, 18, 30)].map((d) => d.getTime()));
  const conExc = { ...lunes, excepciones: ['2026-10-26'] };
  assert.equal(plan([conExc]).length, 1);
  const hasta = { ...lunes, repite_hasta: '2026-10-27' };
  assert.equal(plan([hasta]).length, 1);
});

test('un evento de varios días avisa una sola vez, el día en que empieza', () => {
  assert.equal(plan([ev({ fecha: '2026-10-24', hora_inicio: '20:00:00', dias_extra: 2 })]).length, 1);
  assert.equal(plan([ev({ fecha: '2026-10-22', hora_inicio: '20:00:00', dias_extra: 3 })]).length, 0); // empezó ayer
});

test('ids estables, distintos por evento y por día, enteros de 31 bits', () => {
  const a = idAviso('abc', '2026-10-23'), b = idAviso('abc', '2026-10-24'), c = idAviso('abd', '2026-10-23');
  assert.equal(a, idAviso('abc', '2026-10-23'));
  assert.notEqual(a, b); assert.notEqual(a, c);
  for (const x of [a, b, c]) assert.ok(Number.isInteger(x) && x > 0 && x <= 0x7fffffff);
  const e = ev({ fecha: '2026-10-12', hora_inicio: '19:00:00', repeticion: 'semanal' });
  const r1 = plan([e]), r2 = plan([e]);
  assert.deepEqual(r1.map((x) => x.id), r2.map((x) => x.id));
  assert.equal(new Set(r1.map((x) => x.id)).size, r1.length);
});

test('ordenados por hora y limitados al máximo', () => {
  const muchos = Array.from({ length: 80 }, (_, i) => ev({ titulo: `e${i}`, fecha: `2026-10-${String(24 + (i % 5)).padStart(2, '0')}`, hora_inicio: `${String(8 + (i % 12)).padStart(2, '0')}:00:00` }));
  const r = plan(muchos);
  assert.equal(r.length, AVISO_MAX);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].cuando <= r[i].cuando);
  assert.equal(plan(muchos, { max: 5 }).length, 5);
});

test('entradas vacías o raras no rompen nada', () => {
  assert.deepEqual(plan([]), []);
  assert.deepEqual(planificarAvisos(undefined, { userId: YO, ahora: AHORA }), []);
  assert.deepEqual(plan([ev({ participantes: [] , owner_id: ELLA })]), []);
});

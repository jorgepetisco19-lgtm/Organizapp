import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leerXlsx, crearXlsx } from '../js/xlsx.js';
import { analizarImportacion, cantidadTexto, planAFechas, leerImportacion, plantillaPlanSemanal } from '../js/util.js';
import { writeFileSync } from 'node:fs';

const buf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// Libro como el del plan de alimentación: la primera hoja es un «Léeme» y la tabla plana está en «Menú simple».
function libroPlan() {
  const f = join(mkdtempSync(join(tmpdir(), 'plan-')), 'plan.xlsx');
  execFileSync('python3', ['-c', `
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Léeme'; ws.append(['Plan para dos'])
s = wb.create_sheet('Menú simple')
s.append(['Semana','Día','Momento','Hora','Persona','Plato','Cantidad','Unidad','Trabajo previo día anterior'])
s.append([1,'Lunes','Desayuno','08:00','Jorge','Avena con leche',0.67,'ración','Sí'])
s.append([1,'Lunes','Desayuno','09:30','Paula','Overnight oats',0.5,'ración','Sí'])
s.append([1,'Lunes','Comida','15:00','Jorge','Lentejas',350,'g','Sí'])
s.append([1,'Lunes','Comida','15:00','Jorge','Fruta',1,'ud','No'])
s.append([1,'Lunes','Comida','15:00','Paula','Lentejas',260,'g','Sí'])
s.append([1,'Martes','Cena','22:00','Jorge','Tortilla',0.75,'ración','No'])
s.append([2,'Lunes','Desayuno','06:35','Jorge','Batido',1,'ración','No'])
s.append([2,'Lunes','Desayuno','08:15','Jorge','Avena con yogur',0.33,'ración','No'])
s.append([2,'Miércoles','Comida','15:00','Paula','Pollo asado',1.5,'ración','Sí'])
s.append([2,'Domingo','Cena','22:00','Paula','Fajitas',2.5,'ud','No'])
wb.save(${JSON.stringify(f)})`]);
  return f;
}

test('de un libro con varias hojas se lee la hoja pedida, y sin pedir nada la primera', async () => {
  const b = buf(readFileSync(libroPlan()));
  assert.equal((await leerXlsx(b))[0][0], 'Plan para dos');
  assert.equal((await leerXlsx(b, ['menu simple']))[0][0], 'Semana');
  assert.equal((await leerXlsx(b, ['Hoja que no existe']))[0][0], 'Plan para dos');
});

test('el plan semanal se reconoce y se lee; un menú normal sigue leyéndose como antes', async () => {
  const filas = await leerXlsx(buf(readFileSync(libroPlan())), ['Menú simple']);
  const r = analizarImportacion(filas);
  assert.ok(r.plan);
  assert.equal(r.plan.errores.length, 0, JSON.stringify(r.plan.errores));
  assert.equal(r.plan.filas.length, 10);
  assert.deepEqual(r.plan.personas, ['Jorge', 'Paula']);
  assert.deepEqual(r.plan.semanas, [1, 2]);
  const normal = analizarImportacion([['Fecha', 'Persona', 'Franja', 'Hora', 'Texto'], ['2026-10-26', 'Jorge', 'Cena', '21:00', 'Sopa']]);
  assert.equal(normal.plan, undefined);
  assert.equal(normal.filas.length, 1);
  assert.deepEqual(normal, leerImportacion([['Fecha', 'Persona', 'Franja', 'Hora', 'Texto'], ['2026-10-26', 'Jorge', 'Cena', '21:00', 'Sopa']]));
});

test('cantidades: fracciones de ración, gramos y unidades', () => {
  assert.equal(cantidadTexto(0.67, 'ración'), '2/3 ración');
  assert.equal(cantidadTexto(0.33, 'ración'), '1/3 ración');
  assert.equal(cantidadTexto(0.5, 'ración'), '1/2 ración');
  assert.equal(cantidadTexto(0.75, 'ración'), '3/4 ración');
  assert.equal(cantidadTexto(0.4, 'ración'), '2/5 ración');
  assert.equal(cantidadTexto(1, 'ración'), '1 ración');
  assert.equal(cantidadTexto(2, 'ración'), '2 raciones');
  assert.equal(cantidadTexto(1.5, 'ración'), '1 1/2 raciones');
  assert.equal(cantidadTexto(335, 'g'), '335 g');
  assert.equal(cantidadTexto(2.5, 'ud'), '2,5 ud');
  assert.equal(cantidadTexto('', 'ud'), 'ud');
});

test('el plan se pone en fechas: comidas agrupadas, horas distintas y tareas del día anterior', async () => {
  const r = analizarImportacion(await leerXlsx(buf(readFileSync(libroPlan())), ['Menú simple']));
  const p = planAFechas(r.plan, '2026-11-02', [1, 2], { horaTarea: '21:30', hoy: '2026-10-23' });
  const comida = p.filas.find((f) => f.fecha === '2026-11-02' && f.franja === 'comida' && f.persona === 'Jorge');
  assert.equal(comida.texto, 'Lentejas · 350 g\nFruta · 1 ud');
  assert.equal(comida.hora, '15:00');
  assert.equal(p.filas.find((f) => f.fecha === '2026-11-03').franja, 'cena');
  // semana 2 = una semana después; dos horas distintas en el mismo desayuno: la primera es la hora y la otra va en el texto
  const d2 = p.filas.find((f) => f.fecha === '2026-11-09' && f.franja === 'desayuno');
  assert.equal(d2.hora, '06:35');
  assert.equal(d2.texto, 'Batido · 1 ración\n08:15 Avena con yogur · 1/3 ración');
  assert.equal(p.filas.find((f) => f.fecha === '2026-11-15').persona, 'Paula');
  // tareas: una por día con trabajo previo, el día anterior, sin repetir platos
  assert.deepEqual(p.tareas.map((t) => [t.fecha, t.hora]), [['2026-11-01', '21:30'], ['2026-11-10', '21:30']]);
  assert.equal(p.tareas[0].titulo, 'Preparar para mañana: Avena con leche, Overnight oats, Lentejas');
  assert.match(p.tareas[0].notas, /Comida: Lentejas \(Jorge, Paula\)/);
  assert.equal(p.tareas[1].titulo, 'Preparar para mañana: Pollo asado');
  assert.match(p.tareas[1].notas, /Comida: Pollo asado \(Paula\)/);
});

test('solo se importan las semanas y personas elegidas; las tareas de días pasados se omiten', async () => {
  const r = analizarImportacion(await leerXlsx(buf(readFileSync(libroPlan())), ['Menú simple']));
  const soloS2 = planAFechas(r.plan, '2026-11-02', [2], { personas: new Set(['Paula']), hoy: '2026-10-23' });
  assert.equal(soloS2.filas.length, 2);            // semana 1 no, y de la 2 solo lo de Paula
  assert.equal(soloS2.filas[0].fecha, '2026-11-11'); // el lunes indicado es el de la Semana 1: la 2 cae una semana después (miércoles 11)
  assert.equal(soloS2.tareas.length, 1);
  const pasado = planAFechas(r.plan, '2026-11-02', [1, 2], { hoy: '2026-11-05' });
  assert.equal(pasado.tareas.length, 1);
  assert.equal(pasado.omitidas, 1);
});

test('funciona con cualquier nombre y cualquier número de personas; mayúsculas y espacios no crean personas nuevas', () => {
  const cab = ['Semana', 'Día', 'Momento', 'Hora', 'Persona', 'Plato', 'Cantidad', 'Unidad', 'Trabajo previo día anterior'];
  const fila = (n) => [1, 'Lunes', 'Comida', '14:00', n, 'Lentejas', 300, 'g', 'Sí'];
  const una = analizarImportacion([cab, fila('Nombre 1')]);
  assert.deepEqual(una.plan.personas, ['Nombre 1']);
  const tres = analizarImportacion([cab, fila('Ana'), fila('Luis'), fila('Marta')]);
  assert.deepEqual(tres.plan.personas, ['Ana', 'Luis', 'Marta']);
  assert.equal(planAFechas(tres.plan, '2026-11-02', [1], { hoy: '2026-10-23' }).filas.length, 3);
  const raras = analizarImportacion([cab, fila('  ana '), fila('ANA'), fila('Álex'), fila('alex')]);
  assert.deepEqual(raras.plan.personas, ['ana', 'Álex']);
});

test('la plantilla de plan semanal: la abren openpyxl y LibreOffice, trae 4 desplegables y se importa sin errores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'));
  const f = join(dir, 'plantilla.xlsx');
  const bytes = crearXlsx(plantillaPlanSemanal());
  writeFileSync(f, bytes);
  const out = execFileSync('python3', ['-c', `
import openpyxl
wb = openpyxl.load_workbook(${JSON.stringify(f)})
ws = wb['Plan semanal']
print(wb.sheetnames, ws.max_row, [str(d.sqref) for d in ws.data_validations.dataValidation])`]).toString();
  assert.match(out, /\['Plan semanal', 'Cómo rellenar'\] 8 \['B2:B1000', 'C2:C1000', 'H2:H1000', 'I2:I1000'\]/);
  execFileSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', dir, f], { stdio: 'ignore' });
  assert.match(readFileSync(join(dir, 'plantilla.csv'), 'utf8'), /Semana,Día,Momento,Hora,Persona,Plato,Cantidad,Unidad,Trabajo previo día anterior/);
  const r = analizarImportacion(await leerXlsx(buf(bytes), ['Menú simple', 'Plan semanal']));
  assert.ok(r.plan);
  assert.equal(r.plan.errores.length, 0, JSON.stringify(r.plan.errores));
  assert.equal(r.plan.filas.length, 7);
  assert.deepEqual(r.plan.personas, ['Nombre 1', 'Nombre 2']);
  assert.deepEqual(r.plan.semanas, [1, 2]);
  const p = planAFechas(r.plan, '2026-11-02', [1, 2], { hoy: '2026-10-23' });
  assert.equal(p.tareas.length, 1);
  assert.equal(p.tareas[0].titulo, 'Preparar para mañana: Overnight oats, Lentejas');
});

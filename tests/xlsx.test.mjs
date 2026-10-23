import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearXlsx, leerXlsx } from '../js/xlsx.js';
import { leerImportacion, plantillaMenu } from '../js/util.js';

const buf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

test('la plantilla se crea y se vuelve a leer igual', async () => {
  const filas = await leerXlsx(buf(crearXlsx(plantillaMenu())));
  assert.deepEqual(filas[0], ['Fecha', 'Persona', 'Franja', 'Hora', 'Texto']);
  assert.equal(filas.length, 4);
  assert.equal(filas[1][4], 'Avena con leche\nFruta del tiempo');
});

test('las filas de ejemplo de la plantilla se leen sin errores y son de la persona «Ejemplo»', async () => {
  const filas = await leerXlsx(buf(crearXlsx(plantillaMenu())));
  const r = leerImportacion(filas);
  assert.equal(r.errores.length, 0);
  assert.deepEqual(r.personas, ['Ejemplo']);
  assert.equal(r.filas.length, 3);
  assert.equal(r.filas[0].fecha, '2026-10-26');
  assert.equal(r.filas[0].hora, '08:30');
});

test('caracteres especiales: acentos, &, <, comillas y emoji', async () => {
  const t = 'Pollo & "arroz" <ok> ñandú 🍗';
  const filas = await leerXlsx(buf(crearXlsx([{ nombre: 'A&B', filas: [['x'], [t]] }])));
  assert.equal(filas[1][0], t);
});

test('número de serie de fecha y fracción de hora de Excel', () => {
  const r = leerImportacion([
    ['fecha', 'persona', 'franja', 'hora', 'texto'],
    ['46321', 'Jorge', 'Desayuno', '0.354166666666667', 'Avena'],   // 26/10/2026 08:30
    ['46322', 'Jorge', 'Media mañana', '0.5', 'Fruta'],            // 27/10/2026 12:00
    ['2026-10-28', 'Jorge', 'cena', '8:05', 'Sopa'],
  ]);
  assert.equal(r.errores.length, 0);
  assert.deepEqual(r.filas.map((f) => [f.fecha, f.franja, f.hora]),
    [['2026-10-26', 'desayuno', '08:30'], ['2026-10-27', 'media_manana', '12:00'], ['2026-10-28', 'cena', '08:05']]);
});

test('Excel real: archivo creado con openpyxl (fechas y horas reales, celdas con saltos de línea)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xl-'));
  const f = join(dir, 'a.xlsx');
  execFileSync('python3', ['-c', `
import openpyxl, datetime
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
ws.append(['Fecha','Persona','Franja','Hora','Texto'])
ws.append([datetime.date(2026,10,26),'Jorge','Desayuno',datetime.time(8,30),'Avena\\nFruta'])
ws.append([datetime.date(2026,10,26),'Paula','Cena',datetime.time(21,0),'Sopa de fideos'])
wb.save(${JSON.stringify(f)})`]);
  const r = leerImportacion(await leerXlsx(buf(readFileSync(f))));
  assert.equal(r.errores.length, 0, JSON.stringify(r.errores));
  assert.deepEqual(r.filas.map((x) => [x.fecha, x.persona, x.franja, x.hora, x.texto]),
    [['2026-10-26', 'Jorge', 'desayuno', '08:30', 'Avena\nFruta'], ['2026-10-26', 'Paula', 'cena', '21:00', 'Sopa de fideos']]);
});

test('Excel real: archivo guardado por LibreOffice (cadenas compartidas, hoja que no es la primera en disco)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xl-'));
  writeFileSync(join(dir, 'a.csv'), 'fecha,persona,franja,hora,texto\n26/10/2026,Jorge,Comida,14:00,"Lentejas\nEnsalada"\n');
  execFileSync('soffice', ['--headless', '--convert-to', 'xlsx', '--outdir', dir, join(dir, 'a.csv')], { stdio: 'ignore' });
  const r = leerImportacion(await leerXlsx(buf(readFileSync(join(dir, 'a.xlsx')))));
  assert.equal(r.errores.length, 0, JSON.stringify(r.errores));
  assert.equal(r.filas.length, 1);
  assert.equal(r.filas[0].texto, 'Lentejas\nEnsalada');
});

test('la plantilla generada la abre openpyxl y LibreOffice (validez real del archivo)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xl-'));
  const f = join(dir, 'plantilla.xlsx');
  writeFileSync(f, crearXlsx(plantillaMenu()));
  const out = execFileSync('python3', ['-c', `
import openpyxl
wb = openpyxl.load_workbook(${JSON.stringify(f)})
print(wb.sheetnames, wb['Menú'].max_row, wb['Menú']['A1'].font.b, wb['Menú'].data_validations.dataValidation[0].sqref)`]).toString();
  assert.match(out, /\['Menú', 'Cómo rellenar'\] 4 True C2:C1000/);
  execFileSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', dir, f], { stdio: 'ignore' });
  assert.match(readFileSync(join(dir, 'plantilla.csv'), 'utf8'), /Fecha,Persona,Franja,Hora,Texto/);
});

test('un archivo que no es Excel da un error claro', async () => {
  await assert.rejects(() => leerXlsx(buf(new TextEncoder().encode('hola,esto,no,es,excel'))), /no es un Excel válido/);
});

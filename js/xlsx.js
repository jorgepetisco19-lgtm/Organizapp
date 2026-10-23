// Leer y crear archivos de Excel (.xlsx) sin librerías externas.
// Un .xlsx es un ZIP con XML dentro. Aquí solo se implementa lo necesario:
//  - leerXlsx(buffer): devuelve las filas de la primera hoja como texto.
//  - crearXlsx(hojas): crea un .xlsx sencillo (texto, negrita en la primera fila, lista desplegable opcional).
// Usa DecompressionStream, que traen Chrome, Edge, Safari y Firefox modernos.

const dec = new TextDecoder('utf-8');
const enc = new TextEncoder();

// ---------- ZIP: leer ----------

async function inflarRaw(bytes) {
  const flujo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(flujo).arrayBuffer());
}

async function leerZip(buffer) {
  const b = new Uint8Array(buffer);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El archivo no es un Excel válido.');
  const total = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const entradas = new Map();
  for (let n = 0; n < total; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('El archivo Excel está dañado.');
    const metodo = v.getUint16(p + 10, true);
    const comp = v.getUint32(p + 20, true);
    const lnom = v.getUint16(p + 28, true), lext = v.getUint16(p + 30, true), lcom = v.getUint16(p + 32, true);
    const desde = v.getUint32(p + 42, true);
    const nombre = dec.decode(b.subarray(p + 46, p + 46 + lnom));
    entradas.set(nombre, { metodo, comp, desde });
    p += 46 + lnom + lext + lcom;
  }
  return {
    tiene: (n) => entradas.has(n),
    async texto(nombre) {
      const e = entradas.get(nombre);
      if (!e) return null;
      const lnom = v.getUint16(e.desde + 26, true), lext = v.getUint16(e.desde + 28, true);
      const ini = e.desde + 30 + lnom + lext;
      const datos = b.subarray(ini, ini + e.comp);
      if (e.metodo === 0) return dec.decode(datos);
      if (e.metodo === 8) return dec.decode(await inflarRaw(datos));
      throw new Error('Formato de compresión no admitido en el Excel.');
    },
  };
}

// ---------- XML sencillo ----------

const desescapar = (s) => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const escapar = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // caracteres de control que XML no admite (salvo tab y salto de línea)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const atributo = (attrs, nombre) => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${nombre}\\s*=\\s*"([^"]*)"`));
  return m ? desescapar(m[1]) : null;
};

// Texto de un bloque <si> o <is>: une todos los <t>, ignorando la pronunciación (rPh).
function textoDeBloque(xml) {
  xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) out += desescapar(m[1] || '');
  return out;
}

const letrasAColumna = (letras) => {
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// ---------- leer .xlsx ----------

// Lee una hoja del libro y devuelve sus filas. Por defecto la primera; con `preferidas` (nombres de hoja, sin
// distinguir mayúsculas ni tildes) lee la primera hoja que coincida con alguno de ellos.
const normHoja = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
export async function leerXlsx(buffer, preferidas = []) {
  const zip = await leerZip(buffer);
  if (!zip.tiene('xl/workbook.xml')) throw new Error('Este archivo no parece un Excel (.xlsx).');

  let ruta = 'xl/worksheets/sheet1.xml';
  const libro = await zip.texto('xl/workbook.xml');
  const rels = await zip.texto('xl/_rels/workbook.xml.rels');
  const hojas = [...libro.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ nombre: atributo(m[0], 'name') || '', rid: atributo(m[0], 'r:id') }));
  const quiero = preferidas.map(normHoja);
  const elegida = hojas.find((h) => quiero.includes(normHoja(h.nombre))) || hojas[0];
  if (elegida && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (atributo(m[0], 'Id') === elegida.rid) {
        const t = atributo(m[0], 'Target') || '';
        ruta = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      }
    }
  }
  const xmlHoja = await zip.texto(ruta);
  if (!xmlHoja) throw new Error('No se encontró la primera hoja del Excel.');

  const compartidas = [];
  const ss = await zip.texto('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) compartidas.push(textoDeBloque(m[1] || ''));

  const filas = [];
  for (const fm of xmlHoja.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const numFila = Number(atributo(fm[1], 'r')) || filas.length + 1;
    const fila = [];
    for (const cm of (fm[2] || '').matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (cm[1] !== undefined) continue; // celda vacía
      const attrs = cm[2], cuerpo = cm[3];
      const ref = atributo(attrs, 'r');
      const tipo = atributo(attrs, 't');
      const col = ref ? letrasAColumna(ref.replace(/[0-9]/g, '')) : fila.length;
      let valor = '';
      if (tipo === 'inlineStr') valor = textoDeBloque(cuerpo);
      else {
        const vm = cuerpo.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const v = vm ? desescapar(vm[1]) : '';
        if (tipo === 's') valor = compartidas[Number(v)] ?? '';
        else if (tipo === 'b') valor = v === '1' ? 'VERDADERO' : 'FALSO';
        else valor = v; // número (las fechas y horas llegan como número de serie), o texto de fórmula
      }
      while (fila.length < col) fila.push('');
      fila[col] = valor;
    }
    while (filas.length < numFila - 1) filas.push([]);
    filas[numFila - 1] = fila;
  }
  // se quitan filas completamente vacías
  return filas.filter((f) => f.some((c) => String(c).trim() !== ''));
}

// ---------- ZIP: escribir (sin comprimir) ----------

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function crearZip(archivos) { // [{ nombre, texto }]
  const partes = [], central = [];
  let pos = 0;
  const hoy = new Date();
  const hora = (hoy.getHours() << 11) | (hoy.getMinutes() << 5) | (hoy.getSeconds() >> 1);
  const fecha = ((hoy.getFullYear() - 1980) << 9) | ((hoy.getMonth() + 1) << 5) | hoy.getDate();
  for (const a of archivos) {
    const nom = enc.encode(a.nombre), datos = enc.encode(a.texto), crc = crc32(datos);
    const loc = new DataView(new ArrayBuffer(30));
    loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true);
    loc.setUint16(8, 0, true); loc.setUint16(10, hora, true); loc.setUint16(12, fecha, true);
    loc.setUint32(14, crc, true); loc.setUint32(18, datos.length, true); loc.setUint32(22, datos.length, true);
    loc.setUint16(26, nom.length, true); loc.setUint16(28, 0, true);
    partes.push(new Uint8Array(loc.buffer), nom, datos);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true); cen.setUint16(12, hora, true); cen.setUint16(14, fecha, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, datos.length, true); cen.setUint32(24, datos.length, true);
    cen.setUint16(28, nom.length, true); cen.setUint32(42, pos, true);
    central.push(new Uint8Array(cen.buffer), nom);
    pos += 30 + nom.length + datos.length;
  }
  const tamCentral = central.reduce((s, x) => s + x.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true);
  fin.setUint32(12, tamCentral, true); fin.setUint32(16, pos, true);
  const todo = [...partes, ...central, new Uint8Array(fin.buffer)];
  const out = new Uint8Array(todo.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of todo) { out.set(x, o); o += x.length; }
  return out;
}

// ---------- crear .xlsx ----------

const nombreColumna = (i) => {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

// hojas: [{ nombre, filas: [[texto...]], anchos?: [n...], lista?: { columna: 2, valores: [...] } }]
// La primera fila de cada hoja sale en negrita.
export function crearXlsx(hojas) {
  const archivos = [];
  archivos.push({ nombre: '[Content_Types].xml', texto:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '</Types>' });
  archivos.push({ nombre: '_rels/.rels', texto:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
  archivos.push({ nombre: 'xl/workbook.xml', texto:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    hojas.map((h, i) => `<sheet name="${escapar(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>' });
  archivos.push({ nombre: 'xl/_rels/workbook.xml.rels', texto:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>' });
  // estilos: 0 normal, 1 negrita con fondo suave, 2 normal con ajuste de texto
  archivos.push({ nombre: 'xl/styles.xml', texto:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE8FF"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' });

  hojas.forEach((h, i) => {
    const filasXml = h.filas.map((fila, r) => '<row r="' + (r + 1) + '">' + fila.map((v, c) => {
      const t = String(v ?? '');
      if (t === '') return '';
      return `<c r="${nombreColumna(c)}${r + 1}" s="${r === 0 ? 1 : 2}" t="inlineStr"><is><t xml:space="preserve">${escapar(t)}</t></is></c>`;
    }).join('') + '</row>').join('');
    const cols = h.anchos ? '<cols>' + h.anchos.map((a, c) => `<col min="${c + 1}" max="${c + 1}" width="${a}" customWidth="1"/>`).join('') + '</cols>' : '';
    const lista = h.lista
      ? `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${nombreColumna(h.lista.columna)}2:${nombreColumna(h.lista.columna)}1000"><formula1>"${escapar(h.lista.valores.join(','))}"</formula1></dataValidation></dataValidations>`
      : '';
    archivos.push({ nombre: `xl/worksheets/sheet${i + 1}.xml`, texto:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"' + (i === 0 ? ' tabSelected="1"' : '') + '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      cols + `<sheetData>${filasXml}</sheetData>` + lista + '</worksheet>' });
  });
  return crearZip(archivos);
}

// Pruebas reales de las reglas de acceso sobre un Postgres de verdad (PGlite).
// Simula lo mínimo de Supabase: esquema auth, auth.uid(), auth.jwt() y los roles anon/authenticated.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const db = new PGlite();
const sql = fs.readFileSync(process.env.SQL_PATH || '/mnt/user-data/outputs/organizapp/sql/01_estructura.sql', 'utf8');

const shim = `
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create role anon nologin;
create role authenticated nologin;
grant usage on schema auth, public to anon, authenticated;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
create role authenticator nologin;
-- como en Supabase: por defecto las tablas nuevas de public se abren a anon/authenticated
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
`;

const U = {
  jorge: { id: '00000000-0000-0000-0000-00000000000a', email: 'jorge@test.com' },
  paula: { id: '00000000-0000-0000-0000-00000000000b', email: 'paula@test.com' },
  tercero: { id: '00000000-0000-0000-0000-00000000000c', email: 'tercero@test.com' },
  amigo: { id: '00000000-0000-0000-0000-00000000000d', email: 'amigo@test.com' },
};

let pass = 0, fail = 0;
const fallos = [];
function ok(nombre, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ', nombre); }
  else { fail++; fallos.push(nombre); console.log('  FALLA', nombre, extra); }
}

async function como(u) {
  await db.exec('reset role');
  if (u === 'anon') {
    await db.exec(`select set_config('request.jwt.claims', '', false); set role anon;`);
  } else {
    const claims = JSON.stringify({ sub: u.id, email: u.email, role: 'authenticated' });
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
    await db.exec('set role authenticated');
  }
}
async function q(sqlText, params = []) {
  try { const r = await db.query(sqlText, params); return { rows: r.rows, n: r.affectedRows ?? r.rows.length }; }
  catch (e) { return { error: String(e.message || e) }; }
}
const falla = (r, trozo) => !!r.error && (!trozo || r.error.toLowerCase().includes(trozo.toLowerCase()));

// ---------- preparación ----------
await db.exec(shim);
await db.exec(sql);
console.log('SQL aplicado sin errores. Aplico una segunda vez para comprobar que es repetible…');
await db.exec(sql);
await db.exec('reset role');
for (const u of Object.values(U)) await db.query('insert into auth.users(id,email) values ($1,$2)', [u.id, u.email]);

// ---------- 1. Sin sesión (anon) ----------
console.log('\n1. Sin sesión');
await como('anon');
for (const t of ['perfiles', 'espacios', 'miembros', 'invitaciones', 'eventos', 'menu', 'amistades']) {
  const r = await q(`select * from public.${t}`);
  ok(`anon no puede leer ${t}`, falla(r, 'permission denied'), r.error || JSON.stringify(r.rows));
}
ok('anon no puede crear espacio', falla(await q(`select public.crear_espacio('x')`), 'permission denied'));
ok('anon no puede iniciar perfil', falla(await q(`select public.iniciar_perfil('x')`), 'permission denied'));
ok('anon no puede insertar eventos', falla(await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha) values (gen_random_uuid(),gen_random_uuid(),'plan','x','2026-10-26')`), 'permission denied'));

// ---------- 2. Jorge crea el calendario ----------
console.log('\n2. Jorge crea el calendario e invita a Paula');
await como(U.jorge);
let r = await q(`select public.iniciar_perfil('Jorge') as p`);
ok('Jorge crea su perfil', !r.error, r.error);
r = await q(`select public.crear_espacio('Casa') as id`);
ok('Jorge crea el calendario', !r.error && r.rows[0].id, r.error);
const esp1 = r.rows[0]?.id;

r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,hora_inicio,hora_fin,creado_por)
             values ($1,$2,'deporte','Pádel','2026-10-27','18:30','19:30',$2) returning id`, [esp1, U.jorge.id]);
ok('Jorge crea un evento en su capa', !r.error && r.rows.length === 1, r.error);
const evJorge = r.rows[0]?.id;

r = await q(`insert into public.menu(espacio_id,owner_id,fecha,franja,texto) values ($1,$2,'2026-10-27','comida','Crema de puerro') returning id`, [esp1, U.jorge.id]);
ok('Jorge crea una comida en su capa', !r.error && r.rows.length === 1, r.error);
const menuJorge = r.rows[0]?.id;

r = await q(`insert into public.invitaciones(espacio_id,email,relacion,creada_por) values ($1,'paula@test.com','pareja',$2) returning id`, [esp1, U.jorge.id]);
ok('Jorge invita a Paula', !r.error && r.rows.length === 1, r.error);
const invPaula = r.rows[0]?.id;
r = await q(`insert into public.invitaciones(espacio_id,email,relacion,creada_por) values ($1,'Mayus@Test.com','pareja',$2)`, [esp1, U.jorge.id]);
ok('El correo de la invitación debe ir en minúsculas (restricción)', !!r.error, 'se aceptó un correo con mayúsculas');
r = await q(`insert into public.invitaciones(espacio_id,email,relacion,creada_por) values ($1,'x@test.com','pareja',$2)`, [esp1, U.paula.id]);
ok('No se puede falsear quién invita (creada_por)', !!r.error);

// ---------- 3. Un tercero no ve ni toca nada ----------
console.log('\n3. Tercer usuario (no invitado)');
await como(U.tercero);
r = await q(`select public.iniciar_perfil('Tercero')`);
ok('Tercero crea su perfil', !r.error, r.error);
for (const t of ['espacios', 'miembros', 'invitaciones', 'eventos', 'menu']) {
  r = await q(`select * from public.${t}`);
  ok(`Tercero ve 0 filas de ${t}`, !r.error && r.rows.length === 0, r.error || r.rows.length);
}
r = await q(`select id from public.perfiles`);
ok('Tercero solo ve su propio perfil', !r.error && r.rows.length === 1 && r.rows[0].id === U.tercero.id, r.error || r.rows.length);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','Intruso','2026-10-27',$2)`, [esp1, U.tercero.id]);
ok('Tercero no puede insertar eventos en el calendario de Jorge', falla(r, 'row-level security'), r.error);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','Intruso','2026-10-27',$3)`, [esp1, U.jorge.id, U.tercero.id]);
ok('Tercero no puede insertar eventos en la capa de Jorge', falla(r, 'row-level security'), r.error);
r = await q(`update public.eventos set titulo='Hackeado' where id=$1 returning id`, [evJorge]);
ok('Tercero no puede modificar eventos de Jorge', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`delete from public.eventos where id=$1 returning id`, [evJorge]);
ok('Tercero no puede borrar eventos de Jorge', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`update public.menu set texto='Hackeado' where id=$1 returning id`, [menuJorge]);
ok('Tercero no puede modificar el menú de Jorge', !r.error && r.rows.length === 0);
r = await q(`insert into public.menu(espacio_id,owner_id,fecha,franja,texto) values ($1,$2,'2026-10-28','cena','x')`, [esp1, U.tercero.id]);
ok('Tercero no puede añadir menú al calendario de Jorge', falla(r, 'row-level security'), r.error);
r = await q(`insert into public.invitaciones(espacio_id,email,relacion,creada_por) values ($1,'tercero@test.com','pareja',$2)`, [esp1, U.tercero.id]);
ok('Tercero no puede invitarse a sí mismo', falla(r, 'row-level security'), r.error);
r = await q(`select * from public.mis_invitaciones()`);
ok('Tercero no tiene invitaciones', !r.error && r.rows.length === 0, r.error);
r = await q(`select public.aceptar_invitacion($1)`, [invPaula]);
ok('Tercero no puede aceptar la invitación de Paula', falla(r, 'Invitación no válida'), r.error);
r = await q(`select * from public.miembros where espacio_id=$1`, [esp1]);
ok('Tercero no ve miembros del calendario de Jorge', !r.error && r.rows.length === 0);
r = await q(`insert into public.miembros(espacio_id,user_id,relacion) values ($1,$2,'pareja')`, [esp1, U.tercero.id]);
ok('Tercero no puede añadirse como miembro directamente', falla(r, 'permission denied'), r.error);
r = await q(`update public.perfiles set nombre='Jorge falso' where id=$1 returning id`, [U.jorge.id]);
ok('Tercero no puede cambiar el perfil de Jorge', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`update public.perfiles set nombre='Yo', color='rojo' where id=$1`, [U.tercero.id]);
ok('Color con formato inválido se rechaza', !!r.error);
r = await q(`select public.rechazar_invitacion($1)`, [invPaula]);
await como(U.jorge);
r = await q(`select id from public.invitaciones where id=$1`, [invPaula]);
ok('Tercero no puede rechazar/borrar la invitación de Paula', !r.error && r.rows.length === 1, r.error);

// Tercero con su propio calendario sigue sin poder cruzar
await como(U.tercero);
r = await q(`select public.crear_espacio('Del tercero') as id`);
ok('Tercero puede crear su propio calendario', !r.error, r.error);
const esp3 = r.rows[0]?.id;
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','Cruce','2026-10-27',$3)`, [esp3, U.jorge.id, U.tercero.id]);
ok('Tercero no puede poner eventos de la capa de Jorge en su calendario (Jorge no es miembro)', falla(r, 'row-level security'), r.error);
r = await q(`select * from public.eventos`);
ok('Con calendario propio, sigue sin ver eventos del de Jorge', !r.error && r.rows.length === 0);
r = await q(`select id, nombre, color from public.perfiles where id=$1`, [U.jorge.id]);
ok('Con calendario propio, sigue sin ver el perfil de Jorge', !r.error && r.rows.length === 0);

// ---------- 4. Paula acepta ----------
console.log('\n4. Paula (pareja)');
await como(U.paula);
r = await q(`select public.iniciar_perfil('Paula')`);
ok('Paula crea su perfil', !r.error, r.error);
r = await q(`select * from public.eventos`);
ok('Antes de aceptar, Paula no ve nada', !r.error && r.rows.length === 0);
r = await q(`select * from public.mis_invitaciones()`);
ok('Paula ve su invitación con el nombre de quien invita', !r.error && r.rows.length === 1 && r.rows[0].de_nombre === 'Jorge', r.error || JSON.stringify(r.rows));
r = await q(`select public.aceptar_invitacion($1) as id`, [invPaula]);
ok('Paula acepta la invitación', !r.error && r.rows[0].id === esp1, r.error);
r = await q(`select public.aceptar_invitacion($1)`, [invPaula]);
ok('No se puede reutilizar la invitación', !!r.error);
r = await q(`select * from public.eventos`);
ok('Paula ve el evento de Jorge', !r.error && r.rows.length === 1, r.error);
r = await q(`select * from public.menu`);
ok('Paula ve el menú de Jorge', !r.error && r.rows.length === 1, r.error);
r = await q(`select id from public.perfiles order by nombre`);
ok('Paula ve los dos perfiles', !r.error && r.rows.length === 2, r.error || r.rows.length);
r = await q(`select user_id, color from public.miembros where espacio_id=$1`, [esp1]);
ok('Los colores de Jorge y Paula en el calendario son distintos', r.rows.length === 2 && r.rows[0].color !== r.rows[1].color, JSON.stringify(r.rows));
r = await q(`update public.eventos set titulo='Pádel (editado por Paula)' where id=$1 returning id`, [evJorge]);
ok('Paula (pareja) puede editar eventos de Jorge', !r.error && r.rows.length === 1, r.error);
r = await q(`update public.menu set texto='Crema de calabaza' where id=$1 returning id`, [menuJorge]);
ok('Paula (pareja) puede editar el menú de Jorge', !r.error && r.rows.length === 1, r.error);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'compromiso','Médico','2026-10-29',$3) returning id`, [esp1, U.jorge.id, U.paula.id]);
ok('Paula (pareja) puede crear eventos en la capa de Jorge', !r.error && r.rows.length === 1, r.error);
const evParaJorge = r.rows[0]?.id;
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','Fuera','2026-10-29',$3)`, [esp1, U.tercero.id, U.paula.id]);
ok('No se puede poner un evento en la capa de alguien que no es del calendario', falla(r, 'row-level security'), r.error);
r = await q(`update public.eventos set owner_id=$2 where id=$1 returning id`, [evJorge, U.tercero.id]);
ok('No se puede pasar un evento a la capa de un ajeno', falla(r, 'row-level security'), r.error);
r = await q(`update public.eventos set espacio_id=$2 where id=$1 returning id`, [evJorge, esp3]);
ok('No se puede mover un evento a otro calendario', falla(r, 'row-level security'), r.error);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,hora_inicio,hora_fin,creado_por) values ($1,$2,'plan','Mal','2026-10-29','20:00','19:00',$2)`, [esp1, U.paula.id]);
ok('Hora de fin anterior a la de inicio se rechaza', !!r.error);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'cumple','Mal','2026-10-29',$2)`, [esp1, U.paula.id]);
ok('Un tipo de evento que no existe se rechaza', !!r.error);
r = await q(`insert into public.menu(espacio_id,owner_id,fecha,franja,texto) values ($1,$2,'2026-10-27','comida','Otra') `, [esp1, U.paula.id]);
ok('Paula crea su comida del día', !r.error, r.error);
r = await q(`insert into public.menu(espacio_id,owner_id,fecha,franja,texto) values ($1,$2,'2026-10-27','comida','Cambiada') on conflict (espacio_id,owner_id,fecha,franja) do update set texto=excluded.texto returning texto`, [esp1, U.paula.id]);
ok('Guardar de nuevo la misma franja actualiza (sin duplicar)', !r.error && r.rows[0].texto === 'Cambiada', r.error);
r = await q(`insert into public.invitaciones(espacio_id,email,relacion,creada_por) values ($1,'amigo@test.com','amigo',$2) returning id`, [esp1, U.paula.id]);
ok('Paula (pareja) también puede invitar', !r.error, r.error);
const invAmigo = r.rows[0]?.id;

// ---------- 5. Amigo (solo ve, edita lo suyo) ----------
console.log('\n5. Amigo (relación amigo)');
await como(U.amigo);
await q(`select public.iniciar_perfil('Amigo')`);
r = await q(`select public.aceptar_invitacion($1) as id`, [invAmigo]);
ok('El amigo acepta la invitación', !r.error && r.rows[0].id === esp1, r.error);
r = await q(`select * from public.eventos`);
ok('El amigo ve los eventos', !r.error && r.rows.length >= 2, r.error);
r = await q(`update public.eventos set titulo='Cambio del amigo' where id=$1 returning id`, [evJorge]);
ok('El amigo NO puede editar eventos de otros', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`delete from public.eventos where id=$1 returning id`, [evJorge]);
ok('El amigo NO puede borrar eventos de otros', !r.error && r.rows.length === 0);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','En capa de Jorge','2026-10-30',$3)`, [esp1, U.jorge.id, U.amigo.id]);
ok('El amigo NO puede crear eventos en la capa de otro', falla(r, 'row-level security'), r.error);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','Mi plan','2026-10-30',$2) returning id`, [esp1, U.amigo.id]);
ok('El amigo SÍ puede crear eventos en su propia capa', !r.error && r.rows.length === 1, r.error);
const evAmigo = r.rows[0]?.id;
r = await q(`update public.eventos set titulo='Mi plan 2' where id=$1 returning id`, [evAmigo]);
ok('El amigo SÍ puede editar lo suyo', !r.error && r.rows.length === 1);
r = await q(`update public.menu set texto='Cambio del amigo' where id=$1 returning id`, [menuJorge]);
ok('El amigo NO puede editar el menú de otros', !r.error && r.rows.length === 0);
r = await q(`insert into public.invitaciones(espacio_id,email,relacion,creada_por) values ($1,'otro@test.com','amigo',$2)`, [esp1, U.amigo.id]);
ok('El amigo NO puede invitar', falla(r, 'row-level security'), r.error);
r = await q(`select * from public.invitaciones`);
ok('El amigo NO ve las invitaciones', !r.error && r.rows.length === 0);
await como(U.paula);
r = await q(`update public.eventos set titulo='Editado por pareja' where id=$1 returning id`, [evAmigo]);
ok('Una pareja puede editar también la capa del amigo', !r.error && r.rows.length === 1, r.error);

// eventos "de los dos" (compartido): un solo registro; mismas reglas de edición que cualquier evento
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,compartido,creado_por) values ($1,$2,'plan','Cena de los dos','2026-10-31',true,$2) returning id, compartido`, [esp1, U.paula.id]);
ok('Paula crea un evento compartido (un solo registro)', !r.error && r.rows.length === 1 && r.rows[0].compartido === true, r.error);
const evComp = r.rows[0]?.id;
r = await q(`select count(*)::int n from public.eventos where titulo='Cena de los dos'`);
ok('Solo existe un registro del evento compartido', r.rows[0].n === 1);
await como(U.jorge);
r = await q(`update public.eventos set titulo='Cena de los dos (Jorge)' where id=$1 returning id`, [evComp]);
ok('Jorge (pareja) puede editar el evento compartido creado por Paula', !r.error && r.rows.length === 1, r.error);
r = await q(`update public.eventos set compartido=false where id=$1 returning id`, [evComp]);
ok('Jorge (pareja) puede quitar la marca de compartido', !r.error && r.rows.length === 1, r.error);
r = await q(`update public.eventos set compartido=true where id=$1 returning id`, [evComp]);
await como(U.amigo);
r = await q(`select id from public.eventos where id=$1`, [evComp]);
ok('El amigo ve el evento compartido', !r.error && r.rows.length === 1);
r = await q(`update public.eventos set titulo='Cambio del amigo' where id=$1 returning id`, [evComp]);
ok('El amigo NO puede editar un evento compartido de la pareja', !r.error && r.rows.length === 0);
r = await q(`update public.eventos set compartido=true where id=$1 returning id`, [evJorge]);
ok('El amigo NO puede marcar como compartido un evento de otro', !r.error && r.rows.length === 0);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,compartido,creado_por) values ($1,$2,'plan','Plan para todos','2026-11-01',true,$2) returning id`, [esp1, U.amigo.id]);
ok('El amigo SÍ puede crear un evento compartido en su propia capa', !r.error && r.rows.length === 1, r.error);
await como(U.paula);

// ---------- 6. Límite de 5 personas ----------
console.log('\n6. Límite de 5 personas');
await db.exec('reset role');
const extra = [];
for (let i = 1; i <= 3; i++) {
  const id = `00000000-0000-0000-0000-0000000001${i}0`;
  extra.push({ id, email: `extra${i}@test.com` });
  await db.query('insert into auth.users(id,email) values ($1,$2)', [id, `extra${i}@test.com`]);
  await db.query(`insert into public.perfiles(id,nombre) values ($1,$2)`, [id, `Extra ${i}`]);
  await db.query(`insert into public.invitaciones(espacio_id,email,relacion,creada_por) values ($1,$2,'amigo',$3)`, [esp1, `extra${i}@test.com`, U.jorge.id]);
}
const invs = (await db.query(`select id, email from public.invitaciones where email like 'extra%' order by email`)).rows;
await como(extra[0]);
r = await q(`select public.aceptar_invitacion($1)`, [invs[0].id]);
ok('Quinta persona entra (Jorge, Paula, amigo + extra1 = 4)', !r.error, r.error);
await como(extra[1]);
r = await q(`select public.aceptar_invitacion($1)`, [invs[1].id]);
ok('Quinta persona entra (extra2 = 5)', !r.error, r.error);
await como(extra[2]);
r = await q(`select public.aceptar_invitacion($1)`, [invs[2].id]);
ok('La sexta persona NO entra', falla(r, '5 personas'), r.error);
r = await q(`select id from public.eventos where compartido`);
ok('Quien no es del calendario no ve ni los eventos compartidos', !r.error && r.rows.length === 0, r.error || r.rows.length);

// ---------- 7. Borrado ----------
console.log('\n7. Borrar');
await como(U.paula);
r = await q(`delete from public.eventos where id=$1 returning id`, [evParaJorge]);
ok('Pareja puede borrar un evento de la capa de la otra persona', !r.error && r.rows.length === 1, r.error);
await como(U.jorge);
r = await q(`update public.eventos set repeticion='semanal', repite_hasta='2026-12-01', excepciones='{2026-11-03}' where id=$1 returning id`, [evJorge]);
ok('Se puede guardar una repetición semanal con excepciones', !r.error && r.rows.length === 1, r.error);
r = await q(`update public.eventos set repite_hasta='2026-01-01' where id=$1`, [evJorge]);
ok('"Repetir hasta" anterior a la fecha de inicio se rechaza', !!r.error);


// ---------- 8. Amigos: código, solicitudes ----------
console.log('\n8. Código de amigo y solicitudes de amistad');
const ALFABETO = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
await como('anon');
for (const f of [`public.buscar_codigo('ABCD2345')`, `public.pedir_amistad('ABCD2345')`, `public.mis_amistades()`, `public.regenerar_codigo()`]) {
  r = await q(`select * from ${f}`);
  ok(`anon no puede usar ${f.split('(')[0]}`, falla(r, 'permission denied'), r.error);
}
await como(U.tercero);
r = await q(`insert into public.amistades(de,para) values ($1,$2)`, [U.tercero.id, U.jorge.id]);
ok('Nadie escribe en la tabla de amistades directamente', falla(r, 'permission denied'), r.error);
r = await q(`select codigo_amigo from public.perfiles where id=$1`, [U.tercero.id]);
ok('El código no se lee con un select (ni el propio)', falla(r, 'permission denied'), r.error || JSON.stringify(r.rows));
r = await q(`select public.iniciar_perfil('Tercero') as p`);
const codTercero = r.rows[0]?.p?.codigo_amigo ?? (typeof r.rows[0]?.p === 'string' ? r.rows[0].p.split(',').pop().replace(/[()"]/g, '') : null);
ok('Cada persona recibe su código al iniciar perfil (8 caracteres sin letras confusas)', ALFABETO.test(codTercero || ''), JSON.stringify(r.rows[0]));
await db.exec('reset role');
const codigos = (await db.query('select id, codigo_amigo from public.perfiles')).rows;
ok('Todos los perfiles tienen código y son distintos', codigos.every((c) => ALFABETO.test(c.codigo_amigo)) && new Set(codigos.map((c) => c.codigo_amigo)).size === codigos.length, JSON.stringify(codigos));
const cod = (u) => codigos.find((c) => c.id === u.id).codigo_amigo;
const codJorge = cod(U.jorge), codPaula = cod(U.paula), codAmigo = cod(U.amigo);

await como(U.paula);
r = await q(`select codigo_amigo from public.perfiles where id=$1`, [U.jorge.id]);
ok('Ni siquiera quien comparte calendario puede leer el código de otro', falla(r, 'permission denied'), r.error);

await como(U.tercero);
r = await q(`select * from public.buscar_codigo($1)`, [codJorge.slice(0, 4).toLowerCase() + ' - ' + codJorge.slice(4).toLowerCase()]);
ok('Buscar por código acepta minúsculas, espacios y guion', !r.error && r.rows.length === 1 && r.rows[0].nombre === 'Jorge' && r.rows[0].estado === 'nuevo', r.error || JSON.stringify(r.rows));
ok('La búsqueda solo devuelve id, nombre y estado (nada de correo)', r.rows[0] && Object.keys(r.rows[0]).sort().join() === 'estado,id,nombre', JSON.stringify(r.rows[0]));
r = await q(`select * from public.buscar_codigo('AAAAAAAA')`);
ok('Un código que no existe no devuelve nada', !r.error && r.rows.length === 0, r.error);
r = await q(`select * from public.buscar_codigo('Jorge')`);
ok('Buscar por nombre NO funciona (solo código exacto)', !r.error && r.rows.length === 0, r.error);
r = await q(`select * from public.buscar_codigo($1)`, [codJorge.slice(0, 7)]);
ok('Un código incompleto no devuelve nada', !r.error && r.rows.length === 0, r.error);
r = await q(`select * from public.buscar_codigo($1)`, [codTercero]);
ok('Buscar tu propio código da error', falla(r, 'propio'), r.error);
r = await q(`select public.pedir_amistad($1)`, [codTercero]);
ok('No puedes pedirte amistad a ti mismo', falla(r, 'propio'), r.error);
r = await q(`select public.pedir_amistad('ZZZZZZZZ')`);
ok('Pedir amistad con un código inexistente da error', falla(r, 'nadie'), r.error);

r = await q(`select public.pedir_amistad($1) as id`, [codJorge]);
ok('Tercero envía solicitud a Jorge', !r.error && r.rows[0].id, r.error);
const amis1 = r.rows[0]?.id;
r = await q(`select public.pedir_amistad($1)`, [codJorge]);
ok('No se puede enviar dos veces la misma solicitud', falla(r, 'Ya le enviaste'), r.error);
r = await q(`select * from public.mis_amistades()`);
ok('Tercero ve su solicitud como enviada (con el nombre de Jorge)', r.rows.length === 1 && r.rows[0].direccion === 'enviada' && r.rows[0].estado === 'pendiente' && r.rows[0].nombre === 'Jorge', JSON.stringify(r.rows));
r = await q(`select * from public.buscar_codigo($1)`, [codJorge]);
ok('La búsqueda dice que la solicitud ya está enviada', r.rows[0]?.estado === 'enviada', JSON.stringify(r.rows));
r = await q(`select public.responder_amistad($1, true)`, [amis1]);
ok('Quien envía no puede aceptar su propia solicitud', falla(r, 'ya no existe'), r.error);

await como(U.amigo);
r = await q(`select * from public.mis_amistades()`);
ok('Un tercero no ve solicitudes ajenas', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`select public.responder_amistad($1, true)`, [amis1]);
ok('Un tercero no puede aceptar solicitudes ajenas', falla(r, 'ya no existe'), r.error);
await q(`select public.quitar_amistad($1)`, [amis1]);
await db.exec('reset role');
ok('Un tercero no puede quitar solicitudes ajenas', (await db.query('select count(*)::int n from public.amistades where id=$1', [amis1])).rows[0].n === 1);

await como(U.jorge);
r = await q(`select * from public.mis_amistades()`);
ok('Jorge ve la solicitud recibida', r.rows.length === 1 && r.rows[0].direccion === 'recibida' && r.rows[0].nombre === 'Tercero', JSON.stringify(r.rows));
r = await q(`select * from public.buscar_codigo($1)`, [codTercero]);
ok('Y la búsqueda de Jorge dice "recibida"', r.rows[0]?.estado === 'recibida', JSON.stringify(r.rows));
r = await q(`select public.responder_amistad($1, true)`, [amis1]);
ok('Jorge acepta', !r.error, r.error);
r = await q(`select * from public.mis_amistades()`);
ok('Ahora son amigos', r.rows.length === 1 && r.rows[0].estado === 'aceptada', JSON.stringify(r.rows));
r = await q(`select public.pedir_amistad($1)`, [codTercero]);
ok('Pedir amistad a quien ya es amigo da error', falla(r, 'Ya sois amigos'), r.error);
r = await q(`select public.responder_amistad($1, true)`, [amis1]);
ok('No se puede responder dos veces', falla(r, 'ya no existe'), r.error);

// ser amigo NO da acceso a los datos del calendario
await como(U.tercero);
for (const t of ['espacios', 'miembros', 'eventos', 'menu', 'invitaciones']) {
  r = await q(`select * from public.${t}`);
  ok(`Ser amigo no da acceso a ${t} del calendario de Jorge`, !r.error && r.rows.every((x) => (x.espacio_id ?? x.id) !== esp1), r.error || r.rows.length);
}
r = await q(`select id, nombre from public.perfiles`);
ok('Ser amigo no deja ver su perfil (solo el tuyo)', !r.error && r.rows.length === 1 && r.rows[0].id === U.tercero.id, r.error || r.rows.length);

// solicitudes cruzadas: si A pide a B y B ya había pedido a A, se aceptan
await como(U.amigo);
r = await q(`select public.pedir_amistad($1) as id`, [codPaula]);
ok('Amigo envía solicitud a Paula', !r.error, r.error);
await como(U.paula);
r = await q(`select public.pedir_amistad($1) as id`, [codAmigo]);
ok('Si Paula también le pide, se aceptan sin más', !r.error, r.error);
r = await q(`select estado from public.mis_amistades()`);
ok('Quedan como amigos (una sola fila)', r.rows.length === 1 && r.rows[0].estado === 'aceptada', JSON.stringify(r.rows));

// rechazar y quitar
await como(U.amigo);
r = await q(`select public.pedir_amistad($1) as id`, [codJorge]);
const amis2 = r.rows[0]?.id;
await como(U.jorge);
r = await q(`select public.responder_amistad($1, false)`, [amis2]);
ok('Jorge rechaza y la solicitud desaparece', !r.error && (await q(`select * from public.mis_amistades()`)).rows.length === 1, r.error);
await como(U.amigo);
r = await q(`select public.pedir_amistad($1) as id`, [codJorge]);
ok('Tras rechazar se puede volver a pedir', !r.error, r.error);
const amis3 = r.rows[0]?.id;
r = await q(`select public.quitar_amistad($1)`, [amis3]);
r = await q(`select * from public.mis_amistades()`);
ok('Quien envía puede cancelar su solicitud', r.rows.every((x) => x.id !== amis3), JSON.stringify(r.rows));
await como(U.jorge);
r = await q(`select public.quitar_amistad($1)`, [amis1]);
r = await q(`select * from public.mis_amistades()`);
ok('Cualquiera de los dos puede quitar la amistad', r.rows.length === 0, JSON.stringify(r.rows));

// regenerar código
await como(U.jorge);
r = await q(`select public.regenerar_codigo() as c`);
const nuevoJorge = r.rows[0]?.c;
ok('Jorge genera un código nuevo', ALFABETO.test(nuevoJorge || '') && nuevoJorge !== codJorge, r.error || nuevoJorge);
await como(U.tercero);
r = await q(`select * from public.buscar_codigo($1)`, [codJorge]);
ok('El código antiguo ya no encuentra a Jorge', !r.error && r.rows.length === 0, r.error);
r = await q(`select * from public.buscar_codigo($1)`, [nuevoJorge]);
ok('El nuevo sí', r.rows.length === 1, r.error);

// límite de solicitudes pendientes
await db.exec('reset role');
const objetivos = [];
for (let i = 1; i <= 21; i++) {
  const id = `00000000-0000-0000-0000-0000000002${String(i).padStart(2, '0')}`;
  await db.query('insert into auth.users(id,email) values ($1,$2)', [id, `lim${i}@test.com`]);
  await db.query(`insert into public.perfiles(id,nombre) values ($1,$2)`, [id, `Lim ${i}`]);
  objetivos.push((await db.query('select codigo_amigo c from public.perfiles where id=$1', [id])).rows[0].c);
}
await como(U.tercero);
let ultimo;
for (let i = 0; i < 21; i++) ultimo = await q(`select public.pedir_amistad($1)`, [objetivos[i]]);
ok('Más de 20 solicitudes pendientes seguidas se rechazan', falla(ultimo, 'demasiadas'), ultimo.error);

// borrar la cuenta limpia las amistades
await db.exec('reset role');
await db.query('delete from auth.users where id=$1', ['00000000-0000-0000-0000-000000000201']);
ok('Si se borra una cuenta desaparecen sus amistades', (await db.query(`select count(*)::int n from public.amistades where para='00000000-0000-0000-0000-000000000201' or de='00000000-0000-0000-0000-000000000201'`)).rows[0].n === 0);

// ---------- 9. Migración 03 sobre una base antigua ----------
console.log('\n9. Migración 03 sobre una base que ya tenía perfiles');
const viejo = new PGlite();
await viejo.exec(shim);
await viejo.exec(`create table public.perfiles (id uuid primary key references auth.users(id) on delete cascade, nombre text not null, color text not null default '#3b82f6', creado timestamptz not null default now());
  insert into auth.users values ('00000000-0000-0000-0000-000000000001','a@x.com'),('00000000-0000-0000-0000-000000000002','b@x.com');
  insert into public.perfiles(id,nombre) values ('00000000-0000-0000-0000-000000000001','A'),('00000000-0000-0000-0000-000000000002','B');
  alter table public.perfiles enable row level security;
  grant select on public.perfiles to authenticated;`);
const mig = fs.readFileSync(process.env.SQL3_PATH || '/mnt/user-data/outputs/organizapp/sql/03_amigos.sql', 'utf8');
let errMig = null;
try { await viejo.exec(mig); await viejo.exec(mig); } catch (e) { errMig = e.message; }
ok('La migración se aplica dos veces sin errores', !errMig, errMig);
const cs = (await viejo.query('select codigo_amigo from public.perfiles')).rows.map((x) => x.codigo_amigo);
ok('Las personas que ya existían reciben código, distinto cada una', cs.length === 2 && cs.every((c) => ALFABETO.test(c)) && cs[0] !== cs[1], JSON.stringify(cs));

// ---------- 10. Varios calendarios por persona ----------
console.log('\n10. Varios calendarios por persona');
await db.exec('reset role');
const cods = Object.fromEntries((await db.query('select id, codigo_amigo from public.perfiles')).rows.map((x) => [x.id, x.codigo_amigo]));
// Jorge y Tercero se hacen amigos
await como(U.jorge);
r = await q(`select public.pedir_amistad($1)`, [cods[U.tercero.id]]);
await como(U.tercero);
r = await q(`select id from public.mis_amistades() where estado='pendiente' and direccion='recibida'`);
await q(`select public.responder_amistad($1, true)`, [r.rows[0].id]);

await como(U.jorge);
r = await q(`select public.crear_espacio('Personal') as id`);
ok('Jorge puede crear un segundo calendario (solo para él)', !r.error && r.rows[0].id, r.error);
const espP = r.rows[0]?.id;
r = await q(`select espacio_id, relacion, color from public.miembros where user_id=$1 order by unido`, [U.jorge.id]);
ok('Jorge está en dos calendarios', r.rows.length === 2 && r.rows.every((x) => x.relacion === 'pareja'), JSON.stringify(r.rows));
await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'compromiso','Cosa privada','2026-10-30',$2)`, [espP, U.jorge.id]);

await como(U.paula);
r = await q(`select id from public.espacios`);
ok('Paula solo ve el calendario compartido, no el personal de Jorge', r.rows.length === 1 && r.rows[0].id === esp1, JSON.stringify(r.rows));
r = await q(`select * from public.eventos where espacio_id=$1`, [espP]);
ok('Paula no ve los eventos del calendario personal', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','Intruso','2026-10-30',$3)`, [espP, U.jorge.id, U.paula.id]);
ok('Paula no puede escribir en el calendario personal de Jorge', !!r.error);
r = await q(`select public.invitar_amigo($1,$2,'amigo')`, [espP, U.amigo.id]);
ok('Quien no es pareja de ese calendario no puede invitar a nadie a él', falla(r, 'No tienes permiso'), r.error);
r = await q(`select * from public.invitaciones_enviadas($1)`, [espP]);
ok('Y no ve sus invitaciones enviadas', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`select public.renombrar_espacio($1,'Hackeado')`, [espP]);
ok('Y no puede renombrarlo', falla(r, 'No tienes permiso'), r.error);
r = await q(`select public.eliminar_espacio($1)`, [espP]);
ok('Y no puede borrarlo', falla(r, 'Solo quien creó'), r.error);

await como(U.jorge);
r = await q(`select public.invitar_amigo($1,$2,'amigo')`, [espP, extra[0].id]);
ok('Jorge no puede invitar a alguien que no es su amigo', falla(r, 'tus amigos'), r.error);
r = await q(`insert into public.invitaciones(espacio_id,para_user,relacion,creada_por) values ($1,$2,'amigo',$3)`, [espP, U.tercero.id, U.jorge.id]);
ok('No se puede saltar la comprobación de amistad insertando directamente', !!r.error);
r = await q(`select public.invitar_amigo($1,$2,'jefe')`, [espP, U.tercero.id]);
ok('Un rol inventado se rechaza', falla(r, 'Rol no válido'), r.error);
r = await q(`select public.invitar_amigo($1,$2,'amigo') as id`, [espP, U.tercero.id]);
ok('Jorge invita a su amigo Tercero con rol amigo', !r.error && r.rows[0].id, r.error);
const invT = r.rows[0]?.id;
r = await q(`select public.invitar_amigo($1,$2,'amigo')`, [espP, U.tercero.id]);
ok('No se puede invitar dos veces', falla(r, 'Ya le invitaste'), r.error);
r = await q(`select * from public.invitaciones_enviadas($1)`, [espP]);
ok('Jorge ve la invitación enviada con el nombre del amigo (sin correo)', r.rows.length === 1 && r.rows[0].destino === 'Tercero' && r.rows[0].es_amigo === true, JSON.stringify(r.rows));
r = await q(`select public.invitar_amigo($1,$2,'amigo')`, [esp1, U.tercero.id]);
ok('El calendario con 5 personas no admite más invitaciones', falla(r, '5 personas'), r.error);

await como(U.paula);
r = await q(`select * from public.mis_invitaciones()`);
ok('Paula no ve invitaciones ajenas', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`select public.aceptar_invitacion($1)`, [invT]);
ok('Paula no puede aceptar la invitación de otra persona', falla(r, 'no válida'), r.error);
r = await q(`select public.rechazar_invitacion($1)`, [invT]);
await como(U.jorge);
r = await q(`select * from public.invitaciones_enviadas($1)`, [espP]);
ok('Y tampoco puede rechazarla por otro', r.rows.length === 1, JSON.stringify(r.rows));

await como(U.tercero);
r = await q(`select * from public.mis_invitaciones()`);
ok('Tercero ve la invitación de Jorge', r.rows.length === 1 && r.rows[0].espacio_nombre === 'Personal' && r.rows[0].de_nombre === 'Jorge' && r.rows[0].relacion === 'amigo', JSON.stringify(r.rows));
r = await q(`select * from public.eventos where espacio_id=$1`, [espP]);
ok('Con la invitación pendiente todavía no ve nada del calendario', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`select public.aceptar_invitacion($1) as id`, [invT]);
ok('Tercero acepta (aunque ya tiene su propio calendario)', !r.error && r.rows[0].id === espP, r.error);
r = await q(`select espacio_id, relacion, color from public.miembros where user_id=$1`, [U.tercero.id]);
ok('Tercero está ahora en dos calendarios', r.rows.length === 2, JSON.stringify(r.rows));
r = await q(`select user_id, color from public.miembros where espacio_id=$1`, [espP]);
ok('En el calendario compartido los colores no se repiten', r.rows.length === 2 && r.rows[0].color !== r.rows[1].color, JSON.stringify(r.rows));
r = await q(`select public.aceptar_invitacion($1)`, [invT]);
ok('La invitación no se puede usar dos veces', falla(r, 'no válida'), r.error);
r = await q(`select * from public.eventos where espacio_id=$1`, [espP]);
ok('Ahora ve los eventos del calendario', r.rows.length === 1, r.error || r.rows.length);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','Mío','2026-10-31',$2) returning id`, [espP, U.tercero.id]);
ok('Con rol amigo puede escribir en su propia capa', !r.error && r.rows.length === 1, r.error);
const evT = r.rows[0]?.id;
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,compartido,creado_por) values ($1,$2,'plan','De todos','2026-10-31',true,$2) returning id`, [espP, U.tercero.id]);
const evTodos = r.rows[0]?.id;
r = await q(`update public.eventos set titulo='Cambiado' where espacio_id=$1 and owner_id=$2`, [espP, U.jorge.id]);
ok('Con rol amigo NO puede editar la capa de Jorge', !r.error && r.n === 0, r.error || r.n);
r = await q(`select public.invitar_amigo($1,$2,'amigo')`, [espP, U.amigo.id]);
ok('Con rol amigo no puede invitar', falla(r, 'No tienes permiso'), r.error);
r = await q(`select public.renombrar_espacio($1,'X')`, [espP]);
ok('Con rol amigo no puede renombrar', falla(r, 'No tienes permiso'), r.error);
r = await q(`select public.quitar_miembro($1,$2)`, [espP, U.jorge.id]);
ok('Con rol amigo no puede quitar a nadie', falla(r, 'No tienes permiso'), r.error);
r = await q(`select public.eliminar_espacio($1)`, [espP]);
ok('Con rol amigo no puede borrar el calendario', falla(r, 'Solo quien creó'), r.error);
r = await q(`select public.cambiar_mi_color($1,'#ef4444')`, [espP]);
ok('Tercero cambia su color en el calendario compartido', !r.error, r.error);
r = await q(`select espacio_id, color from public.miembros where user_id=$1`, [U.tercero.id]);
ok('El cambio solo afecta a ese calendario', r.rows.find((x) => x.espacio_id === espP).color === '#ef4444' && r.rows.find((x) => x.espacio_id !== espP).color !== '#ef4444', JSON.stringify(r.rows));
r = await q(`select public.cambiar_mi_color($1,'rojo')`, [espP]);
ok('Un color mal formado se rechaza', falla(r, 'Color no válido'), r.error);
r = await q(`select public.cambiar_mi_color($1,'#ef4444')`, [esp1]);
ok('No se puede cambiar el color en un calendario ajeno', falla(r, 'No estás'), r.error);
r = await q(`update public.miembros set relacion='pareja' where user_id=$1`, [U.tercero.id]);
ok('Nadie se sube el rol a sí mismo (miembros no se escribe directamente)', falla(r, 'permission denied'), r.error);

r = await q(`select public.cambiar_rol($1,$2,'pareja')`, [espP, U.tercero.id]);
ok('Con rol amigo no puede cambiar roles (ni subirse el suyo)', falla(r, 'Solo quien creó'), r.error);
r = await q(`select public.cambiar_rol($1,$2,'pareja')`, [espP, U.jorge.id]);
ok('Con rol amigo no puede cambiar el rol de quien creó el calendario', falla(r, 'Solo quien creó'), r.error);

await como(U.jorge);
r = await q(`update public.eventos set titulo='Editado por Jorge' where id=$1 returning id`, [evT]);
ok('Jorge (pareja) sí edita la capa de Tercero', r.rows.length === 1, r.error);
r = await q(`select public.renombrar_espacio($1,'  Mi agenda  ')`, [espP]);
ok('Jorge renombra su calendario', !r.error, r.error);
r = await q(`select nombre from public.espacios where id=$1`, [espP]);
ok('El nombre queda recortado', r.rows[0]?.nombre === 'Mi agenda', JSON.stringify(r.rows));
r = await q(`select public.quitar_miembro($1,$2)`, [espP, U.jorge.id]);
ok('No puedes quitarte a ti mismo con «quitar»', falla(r, 'Salir del calendario'), r.error);
r = await q(`select public.quitar_miembro($1,$2)`, [espP, U.paula.id]);
ok('No se puede quitar a quien no está', falla(r, 'no está'), r.error);
r = await q(`select public.salir_espacio($1)`, [espP]);
ok('Quien creó el calendario no puede «salir» (solo borrarlo)', falla(r, 'Creaste'), r.error);
r = await q(`select public.cambiar_rol($1,$2,'pareja')`, [espP, U.tercero.id]);
ok('Jorge (creador) sube a Tercero a pareja', !r.error, r.error);
r = await q(`select relacion from public.miembros where espacio_id=$1 and user_id=$2`, [espP, U.tercero.id]);
ok('El rol queda guardado como pareja', r.rows[0]?.relacion === 'pareja', JSON.stringify(r.rows));
r = await q(`select titulo from public.eventos where espacio_id=$1 and owner_id=$2`, [espP, U.tercero.id]);
ok('Cambiar el rol no borra los eventos de esa persona', r.rows.length >= 1, JSON.stringify(r.rows));
r = await q(`select public.cambiar_rol($1,$2,'jefe')`, [espP, U.tercero.id]);
ok('Un rol inventado se rechaza', falla(r, 'Rol no válido'), r.error);
r = await q(`select public.cambiar_rol($1,$2,'amigo')`, [espP, U.jorge.id]);
ok('El creador no puede cambiar su propio rol', falla(r, 'siempre es pareja'), r.error);
r = await q(`select public.cambiar_rol($1,$2,'amigo')`, [espP, U.amigo.id]);
ok('No se cambia el rol de quien no está en el calendario', falla(r, 'no está'), r.error);
r = await q(`select public.cambiar_rol($1,$2,'amigo')`, [espP, U.tercero.id]);
ok('Jorge baja a Tercero otra vez a amigo', !r.error, r.error);
r = await q(`select public.quitar_miembro($1,$2)`, [espP, U.tercero.id]);
ok('Jorge quita a Tercero del calendario', !r.error, r.error);
r = await q(`select titulo, owner_id from public.eventos where espacio_id=$1 order by titulo`, [espP]);
ok('Los eventos propios de Tercero desaparecen y los «de todos» pasan a Jorge', r.rows.length === 2 && r.rows.some((x) => x.titulo === 'De todos' && x.owner_id === U.jorge.id) && r.rows.some((x) => x.titulo === 'Cosa privada') && !r.rows.some((x) => x.titulo.includes('Mío') || x.titulo.includes('Editado')), JSON.stringify(r.rows));
await como(U.tercero);
r = await q(`select * from public.eventos where espacio_id=$1`, [espP]);
ok('Tercero ya no ve nada de ese calendario', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`select count(*)::int n from public.espacios`);
ok('Y conserva su propio calendario', r.rows[0].n === 1, JSON.stringify(r.rows));

// invitar con rol pareja, y salir por voluntad propia
await como(U.jorge);
r = await q(`select public.invitar_amigo($1,$2,'pareja') as id`, [espP, U.tercero.id]);
const invT2 = r.rows[0]?.id;
await como(U.tercero);
r = await q(`select public.aceptar_invitacion($1)`, [invT2]);
ok('Tercero vuelve a entrar, esta vez con rol pareja', !r.error, r.error);
r = await q(`update public.eventos set titulo='Editado por Tercero' where espacio_id=$1 and owner_id=$2 returning id`, [espP, U.jorge.id]);
ok('Con rol pareja sí edita la capa de Jorge', r.rows.length >= 1, r.error);
r = await q(`select public.cambiar_rol($1,$2,'amigo')`, [espP, U.jorge.id]);
ok('Una pareja que no creó el calendario NO puede cambiar roles ni degradar al creador', falla(r, 'Solo quien creó'), r.error);
r = await q(`select public.salir_espacio($1)`, [espP]);
ok('Tercero sale por su cuenta', !r.error, r.error);
r = await q(`select * from public.eventos where espacio_id=$1`, [espP]);
ok('Y ya no ve el calendario', r.rows.length === 0, r.error);
r = await q(`select public.salir_espacio($1)`, [espP]);
ok('Salir de uno en el que no estás da error', falla(r, 'No estás'), r.error);

// borrar
await como(U.paula);
r = await q(`select public.eliminar_espacio($1)`, [esp1]);
ok('Paula (pareja pero no creadora) no puede borrar el calendario compartido', falla(r, 'Solo quien creó'), r.error);
await como(U.jorge);
r = await q(`select public.eliminar_espacio($1)`, [espP]);
ok('Jorge borra su calendario personal', !r.error, r.error);
await db.exec('reset role');
r = await q(`select (select count(*)::int from public.eventos where espacio_id=$1) e, (select count(*)::int from public.miembros where espacio_id=$1) m`, [espP]);
ok('Con él desaparecen sus eventos y miembros', r.rows[0].e === 0 && r.rows[0].m === 0, JSON.stringify(r.rows));

// tope de 20 calendarios
await como(U.jorge);
let creados = 0, ultimo20;
for (let i = 0; i < 25; i++) { ultimo20 = await q(`select public.crear_espacio('C'||$1::text)`, [i]); if (!ultimo20.error) creados++; else break; }
r = await q(`select count(*)::int n from public.miembros where user_id=$1`, [U.jorge.id]);
ok('Tope de 20 calendarios por persona', r.rows[0].n === 20 && falla(ultimo20, 'máximo de 20'), `${r.rows[0].n} ${ultimo20.error}`);

// ---------- 10b. Tareas hechas, pasos de tarea y lista de la compra ----------
console.log('\n10b. Líneas: pasos de tarea y lista de la compra');
await db.exec('reset role');
const eL = '00000000-0000-0000-0000-0000000000f1', eOtro = '00000000-0000-0000-0000-0000000000f2';
await db.query(`insert into public.espacios(id,nombre,creado_por) values ($1,'Listas',$2),($3,'Otro',$2)`, [eL, U.paula.id, eOtro]);
await db.query(`insert into public.miembros(espacio_id,user_id,relacion,color) values
  ($1,$2,'pareja','#111111'),($1,$3,'pareja','#222222'),($1,$4,'amigo','#333333'),($5,$2,'pareja','#111111')`, [eL, U.paula.id, U.tercero.id, U.amigo.id, eOtro]);
await como(U.paula);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'tarea','Hacer la compra','2026-11-03',$2) returning id`, [eL, U.paula.id]);
const evTarea = r.rows[0]?.id;
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','Un plan','2026-11-03',$2) returning id`, [eL, U.paula.id]);
const evPlan = r.rows[0]?.id;
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'tarea','Tarea de otro calendario','2026-11-03',$2) returning id`, [eOtro, U.paula.id]);
const evOtro = r.rows[0]?.id;
r = await q(`update public.eventos set hechas = array['2026-11-03'::date] where id=$1 returning hechas`, [evTarea]);
ok('Paula marca su tarea como hecha (columna hechas)', !r.error && r.rows.length === 1, r.error);
const ins = (esp, ev, texto, quien) => q(`insert into public.lineas(espacio_id,evento_id,texto,creado_por) values ($1,$2,$3,$4) returning id`, [esp, ev, texto, quien]);

r = await ins(eL, evTarea, 'Leche', U.paula.id);
ok('Paula añade un paso a su tarea', !r.error && r.rows.length === 1, r.error);
const lPaso = r.rows[0]?.id;
r = await ins(eL, null, 'Pan', U.paula.id);
ok('Paula añade un producto a la lista de la compra', !r.error && r.rows.length === 1, r.error);
const lCompra = r.rows[0]?.id;
r = await ins(eL, evPlan, 'Paso en un plan', U.paula.id);
ok('Solo las tareas llevan pasos (un plan no)', !!r.error);
r = await ins(eL, evOtro, 'Paso de una tarea de otro calendario', U.paula.id);
ok('Una línea no puede colgar de una tarea de otro calendario', !!r.error);
r = await ins(eOtro, evTarea, 'Cruce', U.paula.id);
ok('Ni la tarea de este calendario con el id de otro calendario', !!r.error);
r = await ins(eL, null, 'Suplantada', U.tercero.id);
ok('No se puede crear una línea a nombre de otra persona', !!r.error);
r = await ins(eL, null, '', U.paula.id);
ok('Una línea vacía se rechaza', !!r.error);
r = await ins(eL, null, 'x'.repeat(201), U.paula.id);
ok('Una línea de más de 200 caracteres se rechaza', !!r.error);

await como(U.amigo);
r = await q(`select id from public.lineas where espacio_id=$1`, [eL]);
ok('Un amigo del calendario ve los pasos y la lista de la compra', r.rows.length === 2, r.error || r.rows.length);
r = await ins(eL, null, 'Huevos', U.amigo.id);
ok('Un amigo añade a la lista de la compra', !r.error && r.rows.length === 1, r.error);
const lAmigo = r.rows[0]?.id;
r = await q(`update public.lineas set hecha=true where id=$1 returning id`, [lCompra]);
ok('Un amigo marca un producto de la compra', !r.error && r.rows.length === 1, r.error);
r = await ins(eL, evTarea, 'Paso colado', U.amigo.id);
ok('Un amigo NO añade pasos a la tarea de otra persona', !!r.error);
r = await q(`update public.lineas set hecha=true where id=$1 returning id`, [lPaso]);
ok('Un amigo NO marca los pasos de la tarea de otra persona', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`delete from public.lineas where id=$1 returning id`, [lPaso]);
ok('Un amigo NO borra los pasos de la tarea de otra persona', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`update public.eventos set hechas = array['2026-11-04'::date] where id=$1 returning id`, [evTarea]);
ok('Un amigo NO marca como hecha la tarea de otra persona', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`update public.lineas set evento_id=$2 where id=$1`, [lAmigo, evTarea]);
ok('No se puede mover una línea a otra tarea', falla(r, 'permission denied'), r.error);
r = await q(`update public.lineas set espacio_id=$2 where id=$1`, [lAmigo, eOtro]);
ok('Ni a otro calendario', falla(r, 'permission denied'), r.error);

await como(U.tercero);
r = await ins(eL, evTarea, 'Mantequilla', U.tercero.id);
ok('Una pareja (no creadora) sí añade pasos a la tarea de Paula', !r.error && r.rows.length === 1, r.error);
r = await q(`update public.lineas set hecha=true where id=$1 returning id`, [lPaso]);
ok('Y los marca', !r.error && r.rows.length === 1, r.error);

await como(U.jorge);
r = await q(`select * from public.lineas where espacio_id=$1`, [eL]);
ok('Alguien de fuera no ve ninguna línea', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await ins(eL, null, 'Intruso', U.jorge.id);
ok('Alguien de fuera no añade a la lista de la compra', !!r.error);
r = await q(`update public.lineas set hecha=true where id=$1 returning id`, [lCompra]);
ok('Ni marca nada', !r.error && r.rows.length === 0, r.error || r.rows.length);
r = await q(`delete from public.lineas where id=$1 returning id`, [lCompra]);
ok('Ni borra nada', !r.error && r.rows.length === 0, r.error || r.rows.length);

await como('anon');
r = await q(`select * from public.lineas`);
ok('Sin sesión no se puede leer ninguna línea', falla(r, 'permission denied'), r.error);

await como(U.amigo);
r = await q(`delete from public.lineas where id=$1 returning id`, [lAmigo]);
ok('Un amigo borra su producto de la lista de la compra', !r.error && r.rows.length === 1, r.error);

await como(U.paula);
// límites
await db.exec('reset role');
await db.query(`insert into public.lineas(espacio_id,evento_id,texto,creado_por) select $1, null, 'p'||g, $2 from generate_series(1,298) g`, [eL, U.paula.id]);
await como(U.paula);
r = await q(`select count(*)::int n from public.lineas where espacio_id=$1 and evento_id is null`, [eL]);
const nCompra = r.rows[0].n;
r = await ins(eL, null, 'una más', U.paula.id);
ok(`La lista de la compra admite 300 líneas (hay ${nCompra})`, nCompra === 300 || !r.error, r.error);
r = await ins(eL, null, 'otra más', U.paula.id);
ok('La 301 se rechaza', falla(r, '300 líneas'), r.error);
await db.exec('reset role');
await db.query(`insert into public.lineas(espacio_id,evento_id,texto,creado_por) select $1, $2, 's'||g, $3 from generate_series(1,98) g`, [eL, evTarea, U.paula.id]);
await como(U.paula);
r = await q(`select count(*)::int n from public.lineas where evento_id=$1`, [evTarea]);
r = await ins(eL, evTarea, 'paso 100', U.paula.id);
r = await ins(eL, evTarea, 'paso 101', U.paula.id);
ok('Una tarea admite 100 pasos y el 101 se rechaza', falla(r, '100 pasos'), r.error);

// borrados en cascada
r = await q(`delete from public.eventos where id=$1 returning id`, [evTarea]);
r = await q(`select count(*)::int n from public.lineas where evento_id=$1`, [evTarea]);
ok('Al borrar la tarea se borran sus pasos', r.rows[0].n === 0, r.error || r.rows[0].n);
r = await q(`select public.eliminar_espacio($1)`, [eL]);
await db.exec('reset role');
r = await q(`select count(*)::int n from public.lineas where espacio_id=$1`, [eL]);
ok('Al borrar el calendario se borra su lista de la compra', r.rows[0].n === 0, r.error || r.rows[0].n);

// ---------- 10c. Borrar mi cuenta ----------
console.log('\n10c. Borrar mi cuenta y mis datos');
await db.exec('reset role');
const ID = (n) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
const B = { id: ID(1), email: 'borra@test.com' }, D2 = { id: ID(2), email: 'duena@test.com' }, P2 = { id: ID(3), email: 'pareja2@test.com' }, A2 = { id: ID(4), email: 'amigo2@test.com' }, S2 = { id: ID(5), email: 'solo@test.com' }, X2 = { id: ID(6), email: 'ajeno@test.com' };
for (const u of [B, D2, P2, A2, S2, X2]) {
  await db.query(`insert into auth.users(id,email) values ($1,$2)`, [u.id, u.email]);
  await db.query(`insert into public.perfiles(id,nombre) values ($1,$2)`, [u.id, u.email.split('@')[0]]);
}
const cSolo = ID(11), cAjeno = ID(12), cMio = ID(13), cMioAmigos = ID(14);
await db.query(`insert into public.espacios(id,nombre,creado_por) values ($1,'Solo mío',$2),($3,'De la dueña',$4),($5,'Compartido mío',$2),($6,'Mío con amigos',$2)`, [cSolo, B.id, cAjeno, D2.id, cMio, cMioAmigos]);
await db.query(`insert into public.miembros(espacio_id,user_id,relacion,color) values
  ($1,$2,'pareja','#111111'),
  ($3,$4,'pareja','#222222'),($3,$2,'amigo','#333333'),
  ($5,$2,'pareja','#111111'),($5,$6,'pareja','#444444'),($5,$7,'amigo','#555555'),
  ($8,$2,'pareja','#111111'),($8,$7,'amigo','#555555')`, [cSolo, B.id, cAjeno, D2.id, cMio, P2.id, A2.id, cMioAmigos]);
await db.query(`insert into public.eventos(id,espacio_id,owner_id,tipo,titulo,fecha,compartido,creado_por) values
  ($1,$2,$3,'plan','Mi plan en el de ella','2026-11-05',false,$3),
  ($4,$5,$3,'plan','Mi plan privado','2026-11-05',false,$3),
  ($6,$5,$3,'plan','Plan de todos','2026-11-06',true,$3),
  ($7,$5,$8,'plan','Plan de Pareja2','2026-11-07',false,$8)`, [ID(21), cAjeno, B.id, ID(22), cMio, ID(23), ID(24), P2.id]);
await db.query(`insert into public.lineas(espacio_id,evento_id,texto,creado_por) values ($1,null,'Leche del ajeno',$2),($3,null,'Pan mío',$2)`, [cAjeno, B.id, cSolo]);
await db.query(`insert into public.amistades(de,para,estado) values ($1,$2,'aceptada')`, [B.id, X2.id]);
await db.query(`insert into public.invitaciones(espacio_id,email,relacion,creada_por) values ($1,'otro@test.com','amigo',$2),($3,$4,'amigo',$5)`, [cMio, B.id, cAjeno, B.email, D2.id]);

await como('anon');
r = await q(`select public.borrar_mi_cuenta()`);
ok('Sin sesión no se puede borrar una cuenta', falla(r, 'permission denied'), r.error);

// C. creador de un calendario compartido solo con un «amigo»: no se borra nada
await como(B);
r = await q(`select public.borrar_mi_cuenta()`);
ok('Si creaste un calendario compartido donde nadie es «pareja», se avisa y no se borra', falla(r, 'ninguna tiene el rol'), r.error);
await db.exec('reset role');
r = await q(`select (select count(*)::int from auth.users where id=$1) u, (select count(*)::int from public.eventos where owner_id=$1) e, (select count(*)::int from public.espacios where id=$2) c`, [B.id, cSolo]);
ok('…y todo sigue en su sitio (la operación es atómica)', r.rows[0].u === 1 && r.rows[0].e === 3 && r.rows[0].c === 1, JSON.stringify(r.rows));
await db.query(`update public.miembros set relacion='pareja' where espacio_id=$1 and user_id=$2`, [cMioAmigos, A2.id]);

// ahora sí
await como(B);
r = await q(`select public.borrar_mi_cuenta()`);
ok('Borrar mi cuenta funciona', !r.error, r.error);
await db.exec('reset role');
r = await q(`select (select count(*)::int from auth.users where id=$1) u, (select count(*)::int from public.perfiles where id=$1) p, (select count(*)::int from public.miembros where user_id=$1) m, (select count(*)::int from public.eventos where owner_id=$1) e, (select count(*)::int from public.amistades where de=$1 or para=$1) a, (select count(*)::int from public.invitaciones where creada_por=$1 or email=$2) i`, [B.id, B.email]);
ok('No queda nada suyo: cuenta, perfil, membresías, eventos, amistades ni invitaciones', Object.values(r.rows[0]).every((n) => n === 0), JSON.stringify(r.rows));
r = await q(`select count(*)::int n from public.espacios where id=$1`, [cSolo]);
ok('Su calendario de uso individual se borra entero (con su lista de la compra)', r.rows[0].n === 0 && (await q(`select count(*)::int n from public.lineas where espacio_id=$1`, [cSolo])).rows[0].n === 0);
r = await q(`select creado_por from public.espacios where id=$1`, [cMio]);
ok('El calendario compartido que creó pasa a otra persona «pareja»', r.rows[0]?.creado_por === P2.id, JSON.stringify(r.rows));
r = await q(`select titulo from public.eventos where espacio_id=$1 order by titulo`, [cMio]);
ok('En él se quedan «Plan de todos» (ahora de la nueva creadora) y lo de la otra persona; su plan privado se borra', JSON.stringify(r.rows.map((x) => x.titulo)) === JSON.stringify(['Plan de Pareja2', 'Plan de todos']), JSON.stringify(r.rows));
r = await q(`select owner_id from public.eventos where id=$1`, [ID(23)]);
ok('…y el «Plan de todos» pasa a ser de la nueva creadora', r.rows[0]?.owner_id === P2.id);
r = await q(`select count(*)::int n from public.eventos where espacio_id=$1`, [cAjeno]);
ok('En el calendario de otra persona se borran sus eventos y ese calendario sigue existiendo', r.rows[0].n === 0 && (await q(`select count(*)::int n from public.espacios where id=$1`, [cAjeno])).rows[0].n === 1);
r = await q(`select count(*)::int n, bool_and(creado_por is null) nulo from public.lineas where espacio_id=$1`, [cAjeno]);
ok('Lo que apuntó en una lista de la compra ajena se queda, ya sin su nombre', r.rows[0].n === 1 && r.rows[0].nulo === true, JSON.stringify(r.rows));
r = await q(`select count(*)::int n from auth.users where id in ($1,$2,$3,$4,$5)`, [D2.id, P2.id, A2.id, S2.id, X2.id]);
ok('Las demás personas siguen ahí (solo se borra a quien llama)', r.rows[0].n === 5);
r = await q(`select count(*)::int n from public.amistades`);
ok('Su amistad con otra persona desaparece', (await q(`select count(*)::int n from public.amistades where para=$1 or de=$1`, [X2.id])).rows[0].n === 0);

// Una persona ajena borrando su cuenta no toca nada de los demás
await como(X2);
r = await q(`select public.borrar_mi_cuenta()`);
ok('Una persona sin calendarios también puede borrar su cuenta', !r.error, r.error);
await db.exec('reset role');
r = await q(`select (select count(*)::int from public.eventos) e, (select count(*)::int from public.espacios) c`);
ok('…y los calendarios y eventos de los demás no se tocan', r.rows[0].c >= 3 && r.rows[0].e >= 2, JSON.stringify(r.rows));

// ---------- 10d. Eventos que se repiten varios días a la semana ----------
console.log('\n10d. dias_semana');
await db.exec('reset role');
const eL2 = '00000000-0000-0000-0000-0000000000f9';
await db.query(`insert into public.espacios(id,nombre,creado_por) values ($1,'Rutinas',$2)`, [eL2, U.paula.id]);
await db.query(`insert into public.miembros(espacio_id,user_id,relacion,color) values ($1,$2,'pareja','#111111'),($1,$3,'amigo','#222222'),($1,$4,'amigo','#333333')`, [eL2, U.paula.id, U.tercero.id, U.amigo.id]);
await como(U.paula);
const ins8 = (extra) => q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,repeticion,dias_semana,creado_por) values ($1,$2,'deporte','Pilates','2026-11-03',$3,$4,$2) returning id`, [eL2, U.paula.id, ...extra]);
r = await ins8(['semanal', [1, 3]]);
ok('Paula crea un evento semanal con dos días (martes y jueves)', !r.error && r.rows.length === 1, r.error);
const evDias = r.rows[0]?.id;
r = await q(`select dias_semana from public.eventos where id=$1`, [evDias]);
ok('Se guardan tal cual', JSON.stringify(r.rows[0]?.dias_semana) === '[1,3]', JSON.stringify(r.rows));
r = await ins8(['semanal', null]);
ok('Sin días (null) sigue valiendo: es el día de su fecha', !r.error, r.error);
r = await ins8(['semanal', [7]]);
ok('Un día fuera de 0..6 se rechaza', !!r.error, r.error);
r = await ins8(['semanal', []]);
ok('Una lista vacía se rechaza', !!r.error, r.error);
r = await ins8(['semanal', [0, 1, 2, 3, 4, 5, 6, 0]]);
ok('Más de 7 días se rechaza', !!r.error, r.error);
r = await ins8([null, [1, 3]]);
ok('Días sin repetición semanal se rechazan', !!r.error, r.error);
r = await q(`update public.eventos set repeticion = null, repite_hasta = null where id=$1`, [evDias]);
ok('No se puede quitar la repetición dejando días marcados', !!r.error, r.error);
r = await q(`update public.eventos set repeticion = null, repite_hasta = null, dias_semana = null where id=$1 returning id`, [evDias]);
ok('…pero sí quitando las dos cosas a la vez', !r.error && r.rows.length === 1, r.error);
await q(`update public.eventos set repeticion = 'semanal', dias_semana = array[1,3]::smallint[] where id=$1`, [evDias]);
await como(U.tercero);
r = await q(`update public.eventos set dias_semana = array[0]::smallint[] where id=$1 returning id`, [evDias]);
ok('Un amigo no puede cambiar los días de un evento de Paula', !r.error && r.rows.length === 0, r.error);
await como(U.amigo);
r = await q(`select dias_semana from public.eventos where id=$1`, [evDias]);
ok('Quien está en el calendario ve los días', JSON.stringify(r.rows[0]?.dias_semana) === '[1,3]', JSON.stringify(r.rows));
await db.exec('reset role');


// ---------- 10e. Eventos de varias personas (participantes) ----------
console.log('\n10e. participantes');
await db.exec('reset role');
const eL4 = '00000000-0000-0000-0000-0000000000fa';
await db.query(`insert into public.espacios(id,nombre,creado_por) values ($1,'Cuatro',$2)`, [eL4, U.paula.id]);
await db.query(`insert into public.miembros(espacio_id,user_id,relacion,color) values ($1,$2,'pareja','#111111'),($1,$3,'amigo','#222222'),($1,$4,'amigo','#333333')`, [eL4, U.paula.id, U.tercero.id, U.amigo.id]);
// Jorge NO está en este calendario: es la persona de fuera
const insP = (quien, owner, parts, extra = {}) => q(
  `insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,participantes,compartido,creado_por) values ($1,$2,'deporte','Fútbol','2026-11-05',$3,$4,$5) returning id`,
  [eL4, owner, parts, extra.compartido ?? false, quien.id]);
await como(U.paula);
r = await insP(U.paula, U.tercero.id, [U.tercero.id, U.amigo.id]);
ok('Paula (pareja) crea un evento para otras dos personas', !r.error && r.rows.length === 1, r.error);
const evP = r.rows[0]?.id;
r = await insP(U.paula, U.paula.id, [U.paula.id, U.tercero.id]);
ok('…y uno en el que participa ella', !r.error, r.error);
const evP2 = r.rows[0]?.id;
r = await insP(U.paula, U.paula.id, [U.tercero.id, U.amigo.id]);
ok('El dueño tiene que estar entre los participantes', !!r.error, r.error);
r = await insP(U.paula, U.tercero.id, [U.tercero.id]);
ok('Con una sola persona no es un evento de varias (se rechaza)', !!r.error, r.error);
r = await insP(U.paula, U.tercero.id, [U.tercero.id, U.tercero.id]);
ok('No se puede repetir a una persona', !!r.error, r.error);
r = await insP(U.paula, U.tercero.id, [U.tercero.id, U.jorge.id]);
ok('No se puede apuntar a alguien que no es del calendario', !!r.error && /calendario/i.test(r.error), r.error);
r = await insP(U.paula, U.tercero.id, [U.tercero.id, U.amigo.id], { compartido: true });
ok('Un evento «de todos» no puede llevar lista de personas', !!r.error, r.error);
r = await insP(U.paula, U.tercero.id, Array.from({ length: 6 }, (_, i) => U.tercero.id));
ok('Más de 5 personas se rechaza', !!r.error, r.error);

// Quien participa lo ve; quien está fuera, no
await como(U.amigo);
r = await q(`select participantes from public.eventos where id=$1`, [evP]);
ok('Un participante ve el evento y su lista', r.rows.length === 1 && r.rows[0].participantes.length === 2, JSON.stringify(r.rows));
await como(U.jorge);
r = await q(`select count(*)::int n from public.eventos where espacio_id=$1`, [eL4]);
ok('Quien no es del calendario no ve ningún evento (ni los de varias personas)', r.rows[0].n === 0, JSON.stringify(r.rows));
r = await q(`update public.eventos set titulo='hack' where id=$1 returning id`, [evP]);
ok('…ni puede modificarlos', !r.error && r.rows.length === 0, r.error);
r = await q(`delete from public.eventos where id=$1 returning id`, [evP]);
ok('…ni borrarlos', !r.error && r.rows.length === 0, r.error);
r = await insP(U.jorge, U.tercero.id, [U.tercero.id, U.amigo.id]);
ok('…ni crear uno dentro', !!r.error, r.error);

// Un «amigo» no puede crear eventos con otras personas ni tocar los que no creó
await como(U.tercero);
r = await insP(U.tercero, U.tercero.id, [U.tercero.id, U.amigo.id]);
ok('Un «amigo» no puede apuntar a otra persona en un evento', !!r.error, r.error);
r = await q(`update public.eventos set titulo='cambiado' where id=$1 returning id`, [evP2]);
ok('Un «amigo» que participa no puede cambiar un evento que no creó (aunque sea el dueño de la fila)', !r.error && r.rows.length === 0, r.error);
r = await q(`update public.eventos set titulo='cambiado' where id=$1 returning id`, [evP]);
ok('…tampoco el otro, siendo dueño de la fila', !r.error && r.rows.length === 0, r.error);
r = await q(`delete from public.eventos where id=$1 returning id`, [evP]);
ok('…ni borrarlo', !r.error && r.rows.length === 0, r.error);
r = await q(`update public.eventos set participantes = array[owner_id, '${U.paula.id}']::uuid[] where id=$1 returning id`, [evP]);
ok('…ni cambiar quién participa', !r.error && r.rows.length === 0, r.error);
// Un evento normal suyo sigue pudiéndose editar y no se puede convertir en uno de varias personas añadiendo a otra
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,creado_por) values ($1,$2,'plan','Cine','2026-11-06',$2) returning id`, [eL4, U.tercero.id]);
const evPropio = r.rows[0]?.id;
ok('Un «amigo» sigue creando eventos suyos de siempre', !r.error && !!evPropio, r.error);
r = await q(`update public.eventos set participantes = array[owner_id, '${U.amigo.id}']::uuid[] where id=$1 returning id`, [evPropio]);
ok('…pero no puede convertirlo en uno con otra persona', !!r.error || r.rows.length === 0, r.error);

// La pareja sí edita
await como(U.paula);
r = await q(`update public.eventos set titulo='Partido', hora_inicio='20:00' where id=$1 returning id`, [evP]);
ok('Paula (pareja) puede editar el evento de varias personas', !r.error && r.rows.length === 1, r.error);
r = await q(`update public.eventos set participantes = array[owner_id, '${U.amigo.id}']::uuid[] where id=$1 returning id`, [evP]);
ok('…y cambiar quién participa', !r.error && r.rows.length === 1, r.error);
r = await q(`update public.eventos set participantes = array[owner_id, '${U.jorge.id}']::uuid[] where id=$1 returning id`, [evP]);
ok('…pero no meter a alguien de fuera', !!r.error, r.error);
r = await q(`update public.eventos set participantes = null where id=$1 returning id`, [evP]);
ok('…y volverlo un evento de una sola persona', !r.error && r.rows.length === 1, r.error);
r = await q(`update public.eventos set participantes = array[owner_id, '${U.amigo.id}']::uuid[] where id=$1 returning id`, [evP]);
await q(`update public.eventos set compartido = true where id=$1`, [evP]);
r = await q(`select compartido, participantes from public.eventos where id=$1`, [evP]);
ok('Un evento no puede ser «de todos» y de varias personas a la vez', r.rows[0].compartido === false, JSON.stringify(r.rows));

// Quien lo creó (pareja) mantiene el poder aunque deje de ser pareja: y el creador original pierde el derecho si ya no es miembro
// Salir de un calendario: se le quita de los eventos de varias personas
await como(U.amigo);
r = await q(`select public.salir_espacio($1)`, [eL4]);
ok('Un participante puede salir del calendario', !r.error, r.error);
await db.exec('reset role');
r = await q(`select owner_id, participantes from public.eventos where id=$1`, [evP]);
ok('Al salir, el evento sigue para las demás personas', r.rows.length === 1 && r.rows[0].participantes === null && r.rows[0].owner_id === U.tercero.id, JSON.stringify(r.rows));
// evP2: [paula, tercero]; sale tercero → pasa a ser de Paula sola
await como(U.tercero);
r = await q(`select public.salir_espacio($1)`, [eL4]);
ok('Otra persona sale', !r.error, r.error);
await db.exec('reset role');
r = await q(`select owner_id, participantes from public.eventos where id=$1`, [evP2]);
ok('Si queda una sola persona, el evento pasa a ser normal y suyo', r.rows.length === 1 && r.rows[0].participantes === null && r.rows[0].owner_id === U.paula.id, JSON.stringify(r.rows));
r = await q(`select count(*)::int n from public.eventos where espacio_id=$1 and owner_id=$2`, [eL4, U.tercero.id]);
ok('Y no queda nada de la persona que salió', r.rows[0].n === 0, JSON.stringify(r.rows));

// Con tres personas, al salir una el evento de tres sigue siendo de varias
await db.exec('reset role');
await db.query(`insert into public.miembros(espacio_id,user_id,relacion,color) values ($1,$2,'amigo','#222222'),($1,$3,'amigo','#333333')`, [eL4, U.tercero.id, U.amigo.id]);
await como(U.paula);
r = await insP(U.paula, U.paula.id, [U.paula.id, U.tercero.id, U.amigo.id]);
const ev3 = r.rows[0]?.id;
ok('Paula crea un evento para tres personas', !r.error && !!ev3, r.error);
await como(U.amigo);
await q(`select public.salir_espacio($1)`, [eL4]);
await db.exec('reset role');
r = await q(`select owner_id, participantes from public.eventos where id=$1`, [ev3]);
ok('Al salir una de tres, quedan dos y sigue siendo de varias personas', r.rows[0]?.participantes?.length === 2 && !r.rows[0].participantes.includes(U.amigo.id), JSON.stringify(r.rows));
// Si sale la dueña de la fila, el dueño pasa a otra persona participante
await db.query(`insert into public.miembros(espacio_id,user_id,relacion,color) values ($1,$2,'amigo','#333333')`, [eL4, U.amigo.id]);
await como(U.paula);
r = await insP(U.paula, U.tercero.id, [U.tercero.id, U.amigo.id, U.paula.id]);
const ev3b = r.rows[0]?.id;
await como(U.tercero);
await q(`select public.salir_espacio($1)`, [eL4]);
await db.exec('reset role');
r = await q(`select owner_id, participantes from public.eventos where id=$1`, [ev3b]);
ok('Si sale quien figura como dueño, otro participante pasa a serlo y el evento se mantiene', r.rows.length === 1 && r.rows[0].participantes?.length === 2 && r.rows[0].participantes.includes(r.rows[0].owner_id) && r.rows[0].owner_id !== U.tercero.id, JSON.stringify(r.rows));

// La cuenta borrada también se quita de los eventos de varias personas
await db.exec('reset role');
const eL5 = '00000000-0000-0000-0000-0000000000fb';
const ID5 = (n) => `00000000-0000-0000-0000-0000000005${String(n).padStart(2, '0')}`;
const Z = [1, 2, 3].map((n) => ({ id: ID5(n), email: `z${n}@test.com` }));
for (const u of Z) {
  await db.query(`insert into auth.users(id,email) values ($1,$2)`, [u.id, u.email]);
  await db.query(`insert into public.perfiles(id,nombre) values ($1,$2)`, [u.id, u.email.split('@')[0]]);
}
await db.query(`insert into public.espacios(id,nombre,creado_por) values ($1,'Z',$2)`, [eL5, Z[0].id]);
await db.query(`insert into public.miembros(espacio_id,user_id,relacion,color) values ($1,$2,'pareja','#111111'),($1,$3,'amigo','#222222'),($1,$4,'amigo','#333333')`, [eL5, Z[0].id, Z[1].id, Z[2].id]);
await como(Z[0]);
r = await q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,participantes,creado_por) values ($1,$2,'deporte','Pádel','2026-11-07',$3,$4)`, [eL5, Z[1].id, [Z[1].id, Z[2].id], Z[0].id]);
ok('La creadora del calendario crea un evento para dos personas', !r.error, r.error);
await como(Z[1]);
r = await q(`select public.borrar_mi_cuenta()`);
ok('Borrar la cuenta de un participante funciona', !r.error, r.error);
await db.exec('reset role');
r = await q(`select owner_id, participantes from public.eventos where espacio_id=$1`, [eL5]);
ok('…y el evento queda como evento normal de la otra persona', r.rows.length === 1 && r.rows[0].participantes === null && r.rows[0].owner_id === Z[2].id, JSON.stringify(r.rows));
await db.exec('reset role');


// ---------- 10f. Subtipos de cita ----------
console.log('\n10f. subtipos');
await db.exec('reset role');
const eL6 = '00000000-0000-0000-0000-0000000000fc', eL7 = '00000000-0000-0000-0000-0000000000fd';
await db.query(`insert into public.espacios(id,nombre,creado_por) values ($1,'Subtipos',$2),($3,'Otro de Paula',$2)`, [eL6, U.paula.id, eL7]);
await db.query(`insert into public.miembros(espacio_id,user_id,relacion,color) values ($1,$2,'pareja','#111111'),($1,$3,'amigo','#222222'),($1,$4,'amigo','#333333'),($5,$2,'pareja','#111111')`, [eL6, U.paula.id, U.tercero.id, U.amigo.id, eL7]);
const mkSub = (quien, esp, nombre, color = '#ef4444') => q(`insert into public.subtipos(espacio_id,nombre,color,creado_por) values ($1,$2,$3,$4) returning id`, [esp, nombre, color, quien.id]);
await como(U.paula);
r = await mkSub(U.paula, eL6, 'Médica');
ok('Paula (pareja) crea un subtipo', !r.error && r.rows.length === 1, r.error);
const subMed = r.rows[0]?.id;
await como(U.tercero);
r = await mkSub(U.tercero, eL6, 'Peluquería', '#a855f7');
ok('Un «amigo» también puede crear subtipos en su calendario', !r.error && r.rows.length === 1, r.error);
const subPel = r.rows[0]?.id;
r = await mkSub(U.amigo, eL6, 'Otra cosa');
ok('No se puede crear un subtipo diciendo que lo creó otra persona', !!r.error, r.error);
r = await mkSub(U.tercero, eL6, 'MÉDICA ');
ok('No se repite un nombre (da igual mayúsculas y espacios)', !!r.error, r.error);
r = await mkSub(U.tercero, eL6, 'Dentista', 'rojo');
ok('Un color que no es #rrggbb se rechaza', !!r.error, r.error);
r = await mkSub(U.tercero, eL6, '   ');
ok('Un nombre vacío se rechaza', !!r.error, r.error);
r = await mkSub(U.tercero, eL6, 'x'.repeat(41));
ok('Un nombre de más de 40 letras se rechaza', !!r.error, r.error);
r = await q(`select count(*)::int n from public.subtipos where espacio_id=$1`, [eL6]);
ok('Las personas del calendario ven los subtipos de todas', r.rows[0].n === 2, JSON.stringify(r.rows));
// edición: quien lo creó o la pareja
r = await q(`update public.subtipos set color='#00ff00' where id=$1 returning id`, [subMed]);
ok('Un «amigo» no puede cambiar el subtipo de Paula', !r.error && r.rows.length === 0, r.error);
r = await q(`delete from public.subtipos where id=$1 returning id`, [subMed]);
ok('…ni borrarlo', !r.error && r.rows.length === 0, r.error);
r = await q(`update public.subtipos set nombre='Peluquería y barbería', color='#0ea5e9' where id=$1 returning id`, [subPel]);
ok('Pero sí cambia el suyo', !r.error && r.rows.length === 1, r.error);
r = await q(`update public.subtipos set espacio_id=$1 where id=$2 returning id`, [eL7, subPel]);
ok('Un subtipo no se puede cambiar de calendario', falla(r, 'permission denied') || (!r.error && r.rows.length === 0), r.error);
await como(U.amigo);
r = await q(`update public.subtipos set nombre='hack' where id=$1 returning id`, [subPel]);
ok('Otro «amigo» tampoco cambia el de Tercero', !r.error && r.rows.length === 0, r.error);
await como(U.paula);
r = await q(`update public.subtipos set nombre='Peluquería' where id=$1 returning id`, [subPel]);
ok('Paula (pareja) sí puede cambiar el de Tercero', !r.error && r.rows.length === 1, r.error);
// quien está fuera
await como(U.jorge);
r = await q(`select count(*)::int n from public.subtipos where espacio_id=$1`, [eL6]);
ok('Quien no es del calendario no ve ningún subtipo', r.rows[0].n === 0, JSON.stringify(r.rows));
r = await mkSub(U.jorge, eL6, 'Intruso');
ok('…ni puede crear uno', !!r.error, r.error);
r = await q(`update public.subtipos set nombre='hack' where id=$1 returning id`, [subMed]);
ok('…ni cambiarlo', !r.error && r.rows.length === 0, r.error);
r = await q(`delete from public.subtipos where id=$1 returning id`, [subMed]);
ok('…ni borrarlo', !r.error && r.rows.length === 0, r.error);
await como('anon');
r = await q(`select * from public.subtipos`);
ok('Sin sesión no se ve nada', falla(r, 'permission denied'), r.error);
// eventos con subtipo
await como(U.tercero);
const insC = (tipo, sub, esp = eL6, owner = U.tercero.id) => q(`insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha,subtipo_id,creado_por) values ($1,$2,$3,'Cita X','2026-11-10',$4,$2) returning id`, [esp, owner, tipo, sub]);
r = await insC('compromiso', subMed);
ok('Una cita puede llevar un subtipo del calendario', !r.error && r.rows.length === 1, r.error);
const evCita = r.rows[0]?.id;
r = await insC('plan', subMed);
ok('Un plan no puede llevar subtipo (solo las citas)', !!r.error, r.error);
r = await insC('deporte', subMed);
ok('Un deporte tampoco', !!r.error, r.error);
await como(U.paula);
r = await mkSub(U.paula, eL7, 'De otro calendario');
const subOtro = r.rows[0]?.id;
await como(U.tercero);
r = await insC('compromiso', subOtro);
ok('Un subtipo de otro calendario no se puede usar', !!r.error && /calendario/i.test(r.error), r.error);
r = await q(`update public.eventos set tipo='plan' where id=$1 returning id`, [evCita]);
ok('Cambiar la cita a plan sin quitar el subtipo se rechaza', !!r.error, r.error);
r = await q(`update public.eventos set tipo='plan', subtipo_id=null where id=$1 returning id`, [evCita]);
ok('…pero sí quitándolo a la vez', !r.error && r.rows.length === 1, r.error);
await q(`update public.eventos set tipo='compromiso', subtipo_id=$2 where id=$1`, [evCita, subMed]);
// borrar un subtipo deja sus citas sin subtipo
await como(U.paula);
r = await q(`delete from public.subtipos where id=$1 returning id`, [subMed]);
ok('Paula borra el subtipo «Médica»', !r.error && r.rows.length === 1, r.error);
r = await q(`select tipo, subtipo_id from public.eventos where id=$1`, [evCita]);
ok('La cita sigue ahí, sin subtipo', r.rows.length === 1 && r.rows[0].subtipo_id === null && r.rows[0].tipo === 'compromiso', JSON.stringify(r.rows));
// límite de 20
await como(U.paula);
let nSub = 0, ultimoError = '';
for (let i = 0; i < 25; i++) { const x = await mkSub(U.paula, eL6, `Tipo ${i}`); if (!x.error) nSub++; else { ultimoError = x.error; break; } }
r = await q(`select count(*)::int n from public.subtipos where espacio_id=$1`, [eL6]);
ok('No se pueden tener más de 20 subtipos en un calendario', r.rows[0].n === 20 && /20/.test(ultimoError), `${r.rows[0].n} · ${ultimoError}`);
// si borra el calendario, se van sus subtipos
await db.exec('reset role');
await db.query(`delete from public.espacios where id=$1`, [eL6]);
r = await q(`select count(*)::int n from public.subtipos where espacio_id=$1`, [eL6]);
ok('Al borrar el calendario se borran sus subtipos', r.rows[0].n === 0, JSON.stringify(r.rows));
await db.exec('reset role');

// ---------- 11. Migración 04 sobre la estructura anterior (v11) ----------
console.log('\n11. Migración 04 sobre una base creada con la versión anterior');
const v11 = new PGlite();
await v11.exec(shim);
await v11.exec(fs.readFileSync(process.env.SQLV11_PATH || '/mnt/user-data/outputs/organizapp/tests/fixtures/estructura_v11.sql', 'utf8'));
await v11.exec(`insert into auth.users values ('${U.jorge.id}','jorge@test.com'),('${U.paula.id}','paula@test.com');
  insert into public.perfiles(id,nombre,color) values ('${U.jorge.id}','Jorge','#10b981'),('${U.paula.id}','Paula','#f97316');
  insert into public.espacios(id,nombre,creado_por) values ('00000000-0000-0000-0000-0000000000e1','Casa','${U.jorge.id}');
  insert into public.miembros(espacio_id,user_id,relacion) values ('00000000-0000-0000-0000-0000000000e1','${U.jorge.id}','pareja'),('00000000-0000-0000-0000-0000000000e1','${U.paula.id}','pareja');
  insert into public.eventos(espacio_id,owner_id,tipo,titulo,fecha) values ('00000000-0000-0000-0000-0000000000e1','${U.jorge.id}','plan','Cena','2026-10-30');
  insert into public.invitaciones(espacio_id,email,relacion,creada_por) values ('00000000-0000-0000-0000-0000000000e1','nuevo@test.com','amigo','${U.jorge.id}');`);
const mig4 = fs.readFileSync(process.env.SQL4_PATH || '/mnt/user-data/outputs/organizapp/sql/04_calendarios.sql', 'utf8');
let e4 = null;
try { await v11.exec(mig4); await v11.exec(mig4); } catch (e) { e4 = e.message; }
ok('La migración 04 se aplica dos veces sin errores', !e4, e4);
const mig5 = fs.readFileSync(process.env.SQL5_PATH || '/mnt/user-data/outputs/organizapp/sql/05_cambiar_rol.sql', 'utf8');
let e5 = null;
try { await v11.exec(mig5); await v11.exec(mig5); } catch (e) { e5 = e.message; }
ok('La migración 05 se aplica dos veces sin errores', !e5, e5);
const mig6 = fs.readFileSync(process.env.SQL6_PATH || '/mnt/user-data/outputs/organizapp/sql/06_hechas_y_lineas.sql', 'utf8');
let e6 = null;
try { await v11.exec(mig6); await v11.exec(mig6); } catch (e) { e6 = e.message; }
ok('La migración 06 se aplica dos veces sin errores', !e6, e6);
const mig7 = fs.readFileSync(process.env.SQL7_PATH || '/mnt/user-data/outputs/organizapp/sql/07_borrar_cuenta.sql', 'utf8');
let e7 = null;
try { await v11.exec(mig7); await v11.exec(mig7); } catch (e) { e7 = e.message; }
ok('La migración 07 se aplica dos veces sin errores', !e7, e7);
const mig8 = fs.readFileSync(process.env.SQL8_PATH || '/mnt/user-data/outputs/organizapp/sql/08_dias_semana.sql', 'utf8');
let e8 = null;
try { await v11.exec(mig8); await v11.exec(mig8); } catch (e) { e8 = e.message; }
ok('La migración 08 se aplica dos veces sin errores', !e8, e8);
const mig9 = fs.readFileSync(process.env.SQL9_PATH || '/mnt/user-data/outputs/organizapp/sql/09_participantes.sql', 'utf8');
let e9 = null;
try { await v11.exec(mig9); await v11.exec(mig9); } catch (e) { e9 = e.message; }
ok('La migración 09 se aplica dos veces sin errores', !e9, e9);
const mig10 = fs.readFileSync(process.env.SQL10_PATH || '/mnt/user-data/outputs/organizapp/sql/10_subtipos.sql', 'utf8');
let e10 = null;
try { await v11.exec(mig10); await v11.exec(mig10); } catch (e) { e10 = e.message; }
ok('La migración 10 se aplica dos veces sin errores', !e10, e10);
const cm = (await v11.query(`select user_id, color from public.miembros order by color`)).rows;
ok('Los miembros que ya existían conservan su color (el de su perfil)', cm.length === 2 && cm.some((x) => x.color === '#10b981') && cm.some((x) => x.color === '#f97316'), JSON.stringify(cm));
ok('Los eventos y las invitaciones de siempre siguen ahí', (await v11.query('select count(*)::int n from public.eventos')).rows[0].n === 1 && (await v11.query('select count(*)::int n from public.invitaciones')).rows[0].n === 1);
await db.exec('reset role');
const lista = async (d, sqlq) => (await d.query(sqlq)).rows.map((x) => x.v).sort();
for (const [nombre, consulta] of [
  ['las funciones', `select proname||'('||pg_get_function_identity_arguments(oid)||')' v from pg_proc where pronamespace='public'::regnamespace`],
  ['las columnas', `select table_name||'.'||column_name||':'||data_type||':'||is_nullable v from information_schema.columns where table_schema='public'`],
  ['las reglas de acceso', `select tablename||'.'||policyname||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'') v from pg_policies where schemaname='public'`],
  ['los permisos de funciones', `select routine_name||':'||grantee v from information_schema.routine_privileges where routine_schema='public' and grantee in ('anon','authenticated','PUBLIC')`],
  ['los permisos de tablas', `select table_name||':'||grantee||':'||privilege_type v from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated')`],
]) {
  const a = await lista(db, consulta), b = await lista(v11, consulta);
  ok(`Una base nueva (01) y una migrada (04+05+06+07+08+09+10) tienen ${nombre} idénticos`, JSON.stringify(a) === JSON.stringify(b), a.filter((x) => !b.includes(x)).concat(b.filter((x) => !a.includes(x))).join(' | '));
}

await como('anon');
r = await q(`select public.cambiar_rol($1,$2,'pareja')`, [espP, U.tercero.id]);
ok('Sin sesión no se puede cambiar un rol', falla(r, 'permission denied'), r.error);
await db.exec('reset role');

// ---------- Resumen ----------
await db.exec('reset role');
console.log(`\n${pass} pruebas correctas, ${fail} fallos`);
if (fail) { console.log('Fallos:\n - ' + fallos.join('\n - ')); process.exit(1); }

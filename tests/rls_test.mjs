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
r = await q(`select public.crear_espacio('Otro') as id`);
ok('Jorge no puede crear un segundo calendario', falla(r, 'Ya perteneces'), r.error);

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
r = await q(`select id, color from public.perfiles order by nombre`);
ok('Paula ve los dos perfiles', !r.error && r.rows.length === 2, r.error || r.rows.length);
ok('Los colores de Jorge y Paula son distintos', r.rows.length === 2 && r.rows[0].color !== r.rows[1].color, JSON.stringify(r.rows));
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

// ---------- Resumen ----------
await db.exec('reset role');
console.log(`\n${pass} pruebas correctas, ${fail} fallos`);
if (fail) { console.log('Fallos:\n - ' + fallos.join('\n - ')); process.exit(1); }

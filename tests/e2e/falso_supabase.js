// Supabase FALSO para pruebas en navegador (nunca va a producción).
// Imita lo mínimo de supabase-js que usa la app, con la base de datos en localStorage.
// No imita las reglas de acceso (RLS): esas se prueban aparte, en Postgres de verdad (tests/rls_test.mjs).
var supabase = (function () {
  const CLAVE_DB = 'falso_db', CLAVE_SES = 'falso_sesion';
  const USUARIOS = {
    jorge: { id: '00000000-0000-0000-0000-00000000000a', email: 'jorge@test.com', user_metadata: { full_name: 'Jorge Pérez' } },
    paula: { id: '00000000-0000-0000-0000-00000000000b', email: 'paula@test.com', user_metadata: { full_name: 'Paula Gómez' } },
    tercero: { id: '00000000-0000-0000-0000-00000000000c', email: 'tercero@test.com', user_metadata: { full_name: 'Tercero' } },
    cuarto: { id: '00000000-0000-0000-0000-00000000000d', email: 'cuarto@test.com', user_metadata: { full_name: 'Cuarto Nuevo' } },
  };
  const vacia = () => ({ perfiles: [], espacios: [], miembros: [], invitaciones: [], eventos: [], menu: [], amistades: [], lineas: [], subtipos: [] });
  const cargar = () => { try { const d = JSON.parse(localStorage.getItem(CLAVE_DB)) || vacia(); if (!d.lineas) d.lineas = []; if (!d.subtipos) d.subtipos = []; return d; } catch { return vacia(); } };
  const guardar = (db) => localStorage.setItem(CLAVE_DB, JSON.stringify(db));
  const sesionActual = () => { const k = localStorage.getItem(CLAVE_SES); return k ? USUARIOS[k] : null; };
  const uuid = () => crypto.randomUUID();
  const ALFA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const codigoNuevo = () => Array.from({ length: 8 }, () => ALFA[Math.floor(Math.random() * ALFA.length)]).join('');
  const norm = (t) => String(t || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const hora = (v) => (typeof v === 'string' && /^\d\d:\d\d$/.test(v) ? v + ':00' : v);
  const PALETA = ['#3b82f6', '#f97316', '#10b981', '#a855f7', '#ef4444', '#eab308', '#06b6d4', '#ec4899'];
  const oyentes = [];
  const err = (message, code) => ({ data: null, error: { message, code } });

  function condicion(txt) {
    const [col, op, ...resto] = txt.split('.');
    const val = resto.join('.');
    if (op === 'gte') return (r) => r[col] >= val;
    if (op === 'lte') return (r) => r[col] <= val;
    if (op === 'eq') return (r) => String(r[col]) === val;
    if (op === 'not' && val === 'is.null') return (r) => r[col] != null;
    throw new Error('falso_supabase: condición no soportada ' + txt);
  }

  class Consulta {
    constructor(tabla) { this.t = tabla; this.op = 'select'; this.fil = []; this.sing = false; this.retorna = false; }
    select() { if (this.op !== 'select') this.retorna = true; return this; }
    insert(p) { this.op = 'insert'; this.p = [].concat(p); return this; }
    upsert(p, o) { this.op = 'upsert'; this.p = [].concat(p); this.o = o || {}; return this; }
    update(p) { this.op = 'update'; this.p = p; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.fil.push((r) => r[c] === v); return this; }
    lte(c, v) { this.fil.push((r) => r[c] <= v); return this; }
    gte(c, v) { this.fil.push((r) => r[c] >= v); return this; }
    is(c, v) { this.fil.push((r) => (r[c] ?? null) === v); return this; }
    in(c, vs) { this.fil.push((r) => vs.includes(r[c])); return this; }
    or(txt) { const cs = txt.split(',').map(condicion); this.fil.push((r) => cs.some((f) => f(r))); return this; }
    order(c) { this.ord = c; return this; }
    single() { this.sing = true; return this; }
    then(a, b) { return Promise.resolve().then(() => this.ejecutar()).then(a, b); }
    ejecutar() {
      const db = cargar();
      const tabla = db[this.t];
      const dev = (filas) => {
        let f = filas.map((x) => JSON.parse(JSON.stringify(x)));
        if (this.ord) f.sort((a, b) => (typeof a[this.ord] === 'number' ? a[this.ord] - b[this.ord] : String(a[this.ord]).localeCompare(String(b[this.ord]))));
        if (this.sing) return f.length === 1 ? { data: f[0], error: null } : err('JSON object requested, multiple (or no) rows returned');
        return { data: f, error: null };
      };
      if (this.op === 'select') return dev(tabla.filter((r) => this.fil.every((f) => f(r))));
      if (this.op === 'insert' || this.op === 'upsert') {
        const nuevas = [];
        for (const p of this.p) {
          const fila = { id: uuid(), creado: new Date().toISOString(), creada: new Date().toISOString(), ...p };
          if (this.t === 'lineas') { fila.hecha = fila.hecha ?? false; fila.evento_id = fila.evento_id ?? null; fila.orden = fila.orden ?? Date.now(); }
          if (this.t === 'eventos') { fila.excepciones = fila.excepciones || []; fila.hechas = fila.hechas || []; fila.dias_extra = fila.dias_extra || 0; fila.hora_inicio = hora(fila.hora_inicio ?? null); fila.hora_fin = hora(fila.hora_fin ?? null); }
          if (this.t === 'menu') fila.hora = hora(fila.hora ?? null);
          let dup = null;
          if (this.t === 'invitaciones') dup = tabla.find((r) => r.espacio_id === fila.espacio_id && r.email === fila.email);
          if (this.t === 'menu') dup = tabla.find((r) => r.espacio_id === fila.espacio_id && r.owner_id === fila.owner_id && r.fecha === fila.fecha && r.franja === fila.franja);
          if (dup) {
            if (this.op === 'insert') return err('duplicate key value violates unique constraint', '23505');
            Object.assign(dup, { ...fila, id: dup.id });
          } else { tabla.push(fila); nuevas.push(fila); }
        }
        guardar(db);
        return this.retorna ? dev(nuevas) : { data: null, error: null };
      }
      if (this.op === 'update') {
        const tocadas = tabla.filter((r) => this.fil.every((f) => f(r)));
        for (const r of tocadas) Object.assign(r, this.p, this.p.hora_inicio !== undefined ? { hora_inicio: hora(this.p.hora_inicio), hora_fin: hora(this.p.hora_fin) } : {});
        guardar(db);
        return this.retorna ? dev(tocadas) : { data: null, error: null };
      }
      if (this.op === 'delete') {
        const quitar = tabla.filter((r) => this.fil.every((f) => f(r)));
        db[this.t] = tabla.filter((r) => !quitar.includes(r));
        if (this.t === 'eventos') db.lineas = db.lineas.filter((l) => !quitar.some((e) => e.id === l.evento_id));
        if (this.t === 'subtipos') db.eventos.forEach((e) => { if (quitar.some((q) => q.id === e.subtipo_id)) e.subtipo_id = null; });
        guardar(db);
        return this.retorna ? dev(quitar) : { data: null, error: null };
      }
    }
  }

  const rpcs = {
    iniciar_perfil({ p_nombre }) {
      const u = sesionActual(); const db = cargar();
      let p = db.perfiles.find((x) => x.id === u.id);
      if (!p) { p = { id: u.id, nombre: p_nombre, color: '#3b82f6', creado: new Date().toISOString(), codigo_amigo: codigoNuevo() }; db.perfiles.push(p); guardar(db); }
      return { data: p, error: null };
    },
    crear_espacio({ p_nombre }) {
      const u = sesionActual(); const db = cargar();
      if (db.miembros.filter((m) => m.user_id === u.id).length >= 20) return err('Has llegado al máximo de 20 calendarios.');
      const e = { id: uuid(), nombre: String(p_nombre || '').trim() || 'Nuestro calendario', creado_por: u.id };
      const mio = db.perfiles.find((p) => p.id === u.id);
      db.espacios.push(e); db.miembros.push({ espacio_id: e.id, user_id: u.id, relacion: 'pareja', color: mio.color, unido: new Date().toISOString() }); guardar(db);
      return { data: e.id, error: null };
    },
    mis_invitaciones() {
      const u = sesionActual(); const db = cargar();
      return { data: db.invitaciones.filter((i) => i.email === u.email || i.para_user === u.id).map((i) => ({
        id: i.id, espacio_nombre: db.espacios.find((e) => e.id === i.espacio_id).nombre,
        de_nombre: (db.perfiles.find((p) => p.id === i.creada_por) || { nombre: 'Alguien' }).nombre, relacion: i.relacion })), error: null };
    },
    aceptar_invitacion({ p_id }) {
      const u = sesionActual(); const db = cargar();
      const inv = db.invitaciones.find((i) => i.id === p_id && (i.email === u.email || i.para_user === u.id));
      if (!inv) return err('Invitación no válida');
      if (db.miembros.some((m) => m.espacio_id === inv.espacio_id && m.user_id === u.id)) { db.invitaciones = db.invitaciones.filter((i) => i.id !== inv.id); guardar(db); return { data: inv.espacio_id, error: null }; }
      if (db.miembros.filter((m) => m.espacio_id === inv.espacio_id).length >= 5) return err('Este calendario ya tiene 5 personas');
      const mios = db.perfiles.find((p) => p.id === u.id);
      const usados = db.miembros.filter((m) => m.espacio_id === inv.espacio_id).map((m) => m.color);
      const color = usados.includes(mios.color) ? PALETA.find((c) => !usados.includes(c)) : mios.color;
      db.miembros.push({ espacio_id: inv.espacio_id, user_id: u.id, relacion: inv.relacion, color, unido: new Date().toISOString() });
      db.invitaciones = db.invitaciones.filter((i) => i.id !== inv.id);
      guardar(db);
      return { data: inv.espacio_id, error: null };
    },
    rechazar_invitacion({ p_id }) {
      const u = sesionActual(); const db = cargar();
      db.invitaciones = db.invitaciones.filter((i) => !(i.id === p_id && (i.email === u.email || i.para_user === u.id))); guardar(db);
      return { data: null, error: null };
    },
    invitaciones_enviadas({ p_espacio }) {
      const u = sesionActual(); const db = cargar();
      if (!db.miembros.some((m) => m.espacio_id === p_espacio && m.user_id === u.id && m.relacion === 'pareja')) return { data: [], error: null };
      return { data: db.invitaciones.filter((i) => i.espacio_id === p_espacio).map((i) => ({
        id: i.id, destino: i.email || db.perfiles.find((p) => p.id === i.para_user).nombre, relacion: i.relacion, creada: i.creada, es_amigo: !!i.para_user })), error: null };
    },
    invitar_amigo({ p_espacio, p_amigo, p_relacion }) {
      const u = sesionActual(); const db = cargar(); db.amistades = db.amistades || [];
      if (!db.miembros.some((m) => m.espacio_id === p_espacio && m.user_id === u.id && m.relacion === 'pareja')) return err('No tienes permiso en este calendario.');
      if (!db.amistades.some((a) => a.estado === 'aceptada' && ((a.de === u.id && a.para === p_amigo) || (a.de === p_amigo && a.para === u.id)))) return err('Solo puedes invitar a tus amigos.');
      if (db.miembros.some((m) => m.espacio_id === p_espacio && m.user_id === p_amigo)) return err('Ya está en este calendario.');
      if (db.invitaciones.some((i) => i.espacio_id === p_espacio && i.para_user === p_amigo)) return err('Ya le invitaste a este calendario.');
      const n = { id: uuid(), espacio_id: p_espacio, email: null, para_user: p_amigo, relacion: p_relacion, creada_por: u.id, creada: new Date().toISOString() };
      db.invitaciones.push(n); guardar(db); return { data: n.id, error: null };
    },
    renombrar_espacio({ p_espacio, p_nombre }) {
      const u = sesionActual(); const db = cargar();
      if (!db.miembros.some((m) => m.espacio_id === p_espacio && m.user_id === u.id && m.relacion === 'pareja')) return err('No tienes permiso en este calendario.');
      db.espacios.find((e) => e.id === p_espacio).nombre = String(p_nombre).trim(); guardar(db); return { data: null, error: null };
    },
    cambiar_rol({ p_espacio, p_user, p_relacion }) {
      const u = sesionActual(); const db = cargar();
      if (!['pareja', 'amigo'].includes(p_relacion)) return err('Rol no válido.');
      if (db.espacios.find((e) => e.id === p_espacio)?.creado_por !== u.id) return err('Solo quien creó el calendario puede cambiar roles.');
      if (p_user === u.id) return err('Quien creó el calendario siempre es pareja.');
      const m = db.miembros.find((x) => x.espacio_id === p_espacio && x.user_id === p_user);
      if (!m) return err('Esa persona no está en el calendario.');
      m.relacion = p_relacion; guardar(db); return { data: null, error: null };
    },
    quitar_miembro({ p_espacio, p_user }) {
      const u = sesionActual(); const db = cargar();
      if (!db.miembros.some((m) => m.espacio_id === p_espacio && m.user_id === u.id && m.relacion === 'pareja')) return err('No tienes permiso en este calendario.');
      return limpiar(db, p_espacio, p_user);
    },
    salir_espacio({ p_espacio }) {
      const u = sesionActual(); const db = cargar();
      if (db.espacios.find((e) => e.id === p_espacio)?.creado_por === u.id) return err('Creaste este calendario: puedes borrarlo, pero no salir de él.');
      return limpiar(db, p_espacio, u.id);
    },
    eliminar_espacio({ p_espacio }) {
      const u = sesionActual(); const db = cargar();
      const e = db.espacios.find((x) => x.id === p_espacio && x.creado_por === u.id);
      if (!e) return err('Solo quien creó el calendario puede borrarlo.');
      db.espacios = db.espacios.filter((x) => x.id !== p_espacio);
      for (const t of ['miembros', 'invitaciones', 'eventos', 'menu', 'lineas', 'subtipos']) db[t] = db[t].filter((x) => x.espacio_id !== p_espacio);
      guardar(db); return { data: null, error: null };
    },
    borrar_mi_cuenta() {
      const u = sesionActual(); const db = cargar();
      for (const e of db.espacios.filter((x) => x.creado_por === u.id)) {
        const otros = db.miembros.filter((m) => m.espacio_id === e.id && m.user_id !== u.id);
        if (!otros.length) {
          db.espacios = db.espacios.filter((x) => x.id !== e.id);
          for (const t of ['miembros', 'invitaciones', 'eventos', 'menu', 'lineas', 'subtipos']) db[t] = db[t].filter((x) => x.espacio_id !== e.id);
          continue;
        }
        const nuevo = otros.find((m) => m.relacion === 'pareja');
        if (!nuevo) return err(`Creaste «${e.nombre}» y lo comparten otras personas, pero ninguna tiene el rol «pareja». Pon a alguien como «pareja» (Más → Personas) o borra ese calendario, y vuelve a intentarlo.`);
        e.creado_por = nuevo.user_id;
      }
      for (const m of db.miembros.filter((x) => x.user_id === u.id)) { const r = limpiar(db, m.espacio_id, u.id); if (r.error) return r; }
      db.invitaciones = db.invitaciones.filter((i) => i.creada_por !== u.id && i.email !== (u.email || '').toLowerCase());
      db.amistades = db.amistades.filter((a) => a.de !== u.id && a.para !== u.id);
      db.perfiles = db.perfiles.filter((p) => p.id !== u.id);
      guardar(db); return { data: null, error: null };
    },
    cambiar_mi_color({ p_espacio, p_color }) {
      const u = sesionActual(); const db = cargar();
      const m = db.miembros.find((x) => x.espacio_id === p_espacio && x.user_id === u.id);
      if (!m) return err('No estás en ese calendario.');
      m.color = p_color; db.perfiles.find((p) => p.id === u.id).color = p_color; guardar(db); return { data: null, error: null };
    },
    // --- amigos (réplica simple de las funciones de Postgres; las reglas reales se prueban en rls_test.mjs) ---
    buscar_codigo({ p_codigo }) {
      const u = sesionActual(); const db = cargar(); db.amistades = db.amistades || [];
      const c = norm(p_codigo);
      if (c.length !== 8) return { data: [], error: null };
      const otro = db.perfiles.find((p) => p.codigo_amigo === c);
      if (!otro) return { data: [], error: null };
      if (otro.id === u.id) return err('Ese es tu propio código.');
      const a = db.amistades.find((x) => (x.de === u.id && x.para === otro.id) || (x.de === otro.id && x.para === u.id));
      const estado = !a ? 'nuevo' : a.estado === 'aceptada' ? 'amigos' : a.de === u.id ? 'enviada' : 'recibida';
      return { data: [{ id: otro.id, nombre: otro.nombre, estado }], error: null };
    },
    pedir_amistad({ p_codigo }) {
      const u = sesionActual(); const db = cargar(); db.amistades = db.amistades || [];
      const otro = db.perfiles.find((p) => p.codigo_amigo === norm(p_codigo));
      if (!otro) return err('No hay nadie con ese código.');
      if (otro.id === u.id) return err('Ese es tu propio código.');
      const a = db.amistades.find((x) => (x.de === u.id && x.para === otro.id) || (x.de === otro.id && x.para === u.id));
      if (a) {
        if (a.estado === 'aceptada') return err('Ya sois amigos.');
        if (a.de === u.id) return err('Ya le enviaste una solicitud.');
        a.estado = 'aceptada'; guardar(db); return { data: a.id, error: null };
      }
      const n = { id: uuid(), de: u.id, para: otro.id, estado: 'pendiente', creada: new Date().toISOString() };
      db.amistades.push(n); guardar(db); return { data: n.id, error: null };
    },
    responder_amistad({ p_id, p_aceptar }) {
      const u = sesionActual(); const db = cargar();
      const a = (db.amistades || []).find((x) => x.id === p_id && x.para === u.id && x.estado === 'pendiente');
      if (!a) return err('Esa solicitud ya no existe.');
      if (p_aceptar) a.estado = 'aceptada'; else db.amistades = db.amistades.filter((x) => x.id !== p_id);
      guardar(db); return { data: null, error: null };
    },
    quitar_amistad({ p_id }) {
      const u = sesionActual(); const db = cargar();
      db.amistades = (db.amistades || []).filter((x) => !(x.id === p_id && (x.de === u.id || x.para === u.id)));
      guardar(db); return { data: null, error: null };
    },
    mis_amistades() {
      const u = sesionActual(); const db = cargar();
      return { data: (db.amistades || []).filter((x) => x.de === u.id || x.para === u.id).map((x) => {
        const otroId = x.de === u.id ? x.para : x.de;
        return { id: x.id, otro_id: otroId, nombre: db.perfiles.find((p) => p.id === otroId).nombre, estado: x.estado, direccion: x.de === u.id ? 'enviada' : 'recibida', creada: x.creada };
      }), error: null };
    },
    regenerar_codigo() {
      const u = sesionActual(); const db = cargar();
      const p = db.perfiles.find((x) => x.id === u.id); p.codigo_amigo = codigoNuevo(); guardar(db);
      return { data: p.codigo_amigo, error: null };
    },
  };

  function limpiar(db, esp, quien) {
    const creador = db.espacios.find((e) => e.id === esp)?.creado_por;
    if (creador === quien) return err('No se puede quitar a quien creó el calendario.');
    if (!db.miembros.some((m) => m.espacio_id === esp && m.user_id === quien)) return err('Esa persona no está en el calendario.');
    // eventos de varias personas: se le quita de la lista (si queda una sola persona, el evento pasa a ser normal)
    db.eventos.forEach((e) => {
      if (e.espacio_id !== esp || !Array.isArray(e.participantes) || !e.participantes.includes(quien)) return;
      const resto = e.participantes.filter((x) => x !== quien);
      if (e.owner_id === quien) e.owner_id = resto[0];
      e.participantes = resto.length < 2 ? null : resto;
    });
    db.eventos.forEach((e) => { if (e.espacio_id === esp && e.owner_id === quien && e.compartido) e.owner_id = creador; });
    db.lineas = db.lineas.filter((l) => !db.eventos.some((e) => e.id === l.evento_id && e.espacio_id === esp && e.owner_id === quien && !e.compartido));
    db.eventos = db.eventos.filter((e) => !(e.espacio_id === esp && e.owner_id === quien));
    db.menu = db.menu.filter((f) => !(f.espacio_id === esp && f.owner_id === quien));
    db.miembros = db.miembros.filter((m) => !(m.espacio_id === esp && m.user_id === quien));
    guardar(db); return { data: null, error: null };
  }
  const avisar = (evento) => { const s = sesionActual(); setTimeout(() => oyentes.forEach((cb) => cb(evento, s ? { user: s } : null)), 0); };

  return {
    createClient() {
      return {
        auth: {
          onAuthStateChange(cb) { oyentes.push(cb); const s = sesionActual(); setTimeout(() => cb('INITIAL_SESSION', s ? { user: s } : null), 0); return { data: { subscription: { unsubscribe() {} } } }; },
          async signInWithOAuth() { localStorage.setItem(CLAVE_SES, localStorage.getItem('falso_entrar_como') || 'jorge'); avisar('SIGNED_IN'); return { data: {}, error: null }; },
          async signOut() { localStorage.removeItem(CLAVE_SES); avisar('SIGNED_OUT'); return { error: null }; },
        },
        from: (t) => new Consulta(t),
        rpc: async (n, a) => (rpcs[n] ? rpcs[n](a || {}) : err('rpc desconocida ' + n)),
      };
    },
  };
})();

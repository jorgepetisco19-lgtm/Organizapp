// Supabase FALSO para pruebas en navegador (nunca va a producción).
// Imita lo mínimo de supabase-js que usa la app, con la base de datos en localStorage.
// No imita las reglas de acceso (RLS): esas se prueban aparte, en Postgres de verdad (tests/rls_test.mjs).
var supabase = (function () {
  const CLAVE_DB = 'falso_db', CLAVE_SES = 'falso_sesion';
  const USUARIOS = {
    jorge: { id: '00000000-0000-0000-0000-00000000000a', email: 'jorge@test.com', user_metadata: { full_name: 'Jorge Pérez' } },
    paula: { id: '00000000-0000-0000-0000-00000000000b', email: 'paula@test.com', user_metadata: { full_name: 'Paula Gómez' } },
    tercero: { id: '00000000-0000-0000-0000-00000000000c', email: 'tercero@test.com', user_metadata: { full_name: 'Tercero' } },
  };
  const vacia = () => ({ perfiles: [], espacios: [], miembros: [], invitaciones: [], eventos: [], menu: [], amistades: [] });
  const cargar = () => { try { return JSON.parse(localStorage.getItem(CLAVE_DB)) || vacia(); } catch { return vacia(); } };
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
        if (this.ord) f.sort((a, b) => String(a[this.ord]).localeCompare(String(b[this.ord])));
        if (this.sing) return f.length === 1 ? { data: f[0], error: null } : err('JSON object requested, multiple (or no) rows returned');
        return { data: f, error: null };
      };
      if (this.op === 'select') return dev(tabla.filter((r) => this.fil.every((f) => f(r))));
      if (this.op === 'insert' || this.op === 'upsert') {
        const nuevas = [];
        for (const p of this.p) {
          const fila = { id: uuid(), creado: new Date().toISOString(), creada: new Date().toISOString(), ...p };
          if (this.t === 'eventos') { fila.excepciones = fila.excepciones || []; fila.hora_inicio = hora(fila.hora_inicio ?? null); fila.hora_fin = hora(fila.hora_fin ?? null); }
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
      if (db.miembros.some((m) => m.user_id === u.id)) return err('Ya perteneces a un calendario');
      const e = { id: uuid(), nombre: p_nombre, creado_por: u.id };
      db.espacios.push(e); db.miembros.push({ espacio_id: e.id, user_id: u.id, relacion: 'pareja' }); guardar(db);
      return { data: e.id, error: null };
    },
    mis_invitaciones() {
      const u = sesionActual(); const db = cargar();
      return { data: db.invitaciones.filter((i) => i.email === u.email).map((i) => ({
        id: i.id, espacio_nombre: db.espacios.find((e) => e.id === i.espacio_id).nombre,
        de_nombre: (db.perfiles.find((p) => p.id === i.creada_por) || { nombre: 'Alguien' }).nombre, relacion: i.relacion })), error: null };
    },
    aceptar_invitacion({ p_id }) {
      const u = sesionActual(); const db = cargar();
      const inv = db.invitaciones.find((i) => i.id === p_id && i.email === u.email);
      if (!inv) return err('Invitación no válida');
      if (db.miembros.some((m) => m.user_id === u.id)) return err('Ya perteneces a un calendario');
      if (db.miembros.filter((m) => m.espacio_id === inv.espacio_id).length >= 5) return err('Este calendario ya tiene 5 personas');
      db.miembros.push({ espacio_id: inv.espacio_id, user_id: u.id, relacion: inv.relacion });
      db.invitaciones = db.invitaciones.filter((i) => i.id !== inv.id);
      const mios = db.perfiles.find((p) => p.id === u.id);
      const usados = db.miembros.filter((m) => m.espacio_id === inv.espacio_id && m.user_id !== u.id).map((m) => db.perfiles.find((p) => p.id === m.user_id).color);
      if (usados.includes(mios.color)) mios.color = PALETA.find((c) => !usados.includes(c));
      guardar(db);
      return { data: inv.espacio_id, error: null };
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
    rechazar_invitacion({ p_id }) {
      const u = sesionActual(); const db = cargar();
      db.invitaciones = db.invitaciones.filter((i) => !(i.id === p_id && i.email === u.email)); guardar(db);
      return { data: null, error: null };
    },
  };

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

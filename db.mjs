// db.mjs — Capa de base de datos normalizada para el CRM Hauscrete.
//
// La app guarda/lee su `state` completo (contrato window.storage sin cambios).
// Aquí lo DESCOMPONEMOS en tablas normalizadas al guardar y lo REENSAMBLAMOS
// al leer. Cada fila conserva su JSON original completo (columna `data`), así
// que el reensamblado es exacto; las columnas tipadas existen para consultas SQL.
//
// Fuente de verdad: las tablas normalizadas. Se guarda además un respaldo del
// blob crudo y se verifica cada escritura con un round-trip (state->tablas->state).

import { DatabaseSync } from 'node:sqlite';

export const STATE_KEY = 'modulo-proyectos-v1';

// --- Definición de colecciones (arrays del state -> tablas) -------------------
// columns: columnas tipadas para SQL. `from` = nombre de campo o función(obj).
// child: subtabla de partidas (cotizaciones / ocs).
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

const COLLECTIONS = {
  projects: {
    table: 'projects',
    columns: [
      ['id', 'TEXT', (o) => String(o.id ?? '')],
      ['folio', 'INTEGER', (o) => num(o.folio)],
      ['num_hebel', 'TEXT', 'numHebel'],
      ['nombre', 'TEXT', 'nombre'],
      ['cliente', 'TEXT', 'cliente'],
      ['promotor', 'TEXT', 'promotor'],
      ['asesor', 'TEXT', 'asesor'],
      ['estatus', 'TEXT', 'estatus'],
      ['embudo', 'TEXT', 'embudo'],
      ['ciudad', 'TEXT', 'ciudad'],
      ['estado', 'TEXT', 'estado'],
      ['creado', 'TEXT', 'creado'],
      ['fecha_solicitud', 'TEXT', 'fechaSolicitud'],
    ],
  },
  cotizaciones: {
    table: 'cotizaciones',
    columns: [
      ['id', 'TEXT', (o) => String(o.id ?? '')],
      ['folio', 'INTEGER', (o) => num(o.folio)],
      ['proyecto_id', 'TEXT', (o) => (o.proyectoId == null ? null : String(o.proyectoId))],
      ['fecha', 'TEXT', 'fecha'],
      ['vigencia', 'TEXT', (o) => (o.vigencia == null ? null : String(o.vigencia))],
      ['iva', 'REAL', (o) => num(o.iva)],
      ['pago', 'REAL', (o) => num(o.pago)],
      ['condicion', 'TEXT', 'condicion'],
      ['referencia', 'TEXT', 'referencia'],
      ['facturada', 'TEXT', 'facturada'],
      ['oc_folio', 'TEXT', (o) => (o.ocFolio == null ? null : String(o.ocFolio))],
    ],
    child: {
      table: 'cotizacion_partidas',
      parentCol: 'cotizacion_id',
      parentKey: (o) => String(o.id ?? ''),
      arrayField: 'partidas',
      columns: [
        ['codigo', 'TEXT', 'codigo'],
        ['descripcion', 'TEXT', 'descripcion'],
        ['cantidad', 'REAL', (o) => num(o.cantidad)],
        ['unidad', 'TEXT', 'unidad'],
        ['precio', 'REAL', (o) => num(o.precio)],
        ['tipo', 'TEXT', 'tipo'],
        ['descuento', 'REAL', (o) => num(o.desc)],
      ],
    },
  },
  ocs: {
    table: 'ocs',
    columns: [
      ['id', 'TEXT', (o) => String(o.id ?? '')],
      ['folio', 'TEXT', (o) => (o.folio == null ? null : String(o.folio))],
      ['cot_id', 'TEXT', (o) => (o.cotId == null ? null : String(o.cotId))],
      ['proyecto_id', 'TEXT', (o) => (o.proyectoId == null ? null : String(o.proyectoId))],
      ['fecha', 'TEXT', 'fecha'],
      ['proveedor', 'TEXT', 'proveedor'],
    ],
    child: {
      table: 'oc_partidas',
      parentCol: 'oc_id',
      parentKey: (o) => String(o.id ?? ''),
      arrayField: 'partidas',
      columns: [
        ['codigo', 'TEXT', 'codigo'],
        ['descripcion', 'TEXT', 'descripcion'],
        ['cantidad', 'REAL', (o) => num(o.cantidad)],
        ['unidad', 'TEXT', 'unidad'],
        ['precio', 'REAL', (o) => num(o.precio)],
        ['tipo', 'TEXT', 'tipo'],
      ],
    },
  },
  productos: {
    table: 'productos',
    columns: [
      ['codigo', 'TEXT', 'codigo'],
      ['codigo_prov', 'TEXT', 'codigoProv'],
      ['marca', 'TEXT', 'marca'],
      ['descripcion', 'TEXT', 'descripcion'],
      ['unidad', 'TEXT', 'unidad'],
      ['precio', 'REAL', (o) => num(o.precio)],
      ['tipo', 'TEXT', 'tipo'],
      ['vol_tarima', 'REAL', (o) => num(o.volTarima)],
      ['espesor_cm', 'REAL', (o) => num(o.espesorCm)],
      ['pzas_tarima', 'REAL', (o) => num(o.pzasTarima)],
      ['vol_pieza', 'REAL', (o) => num(o.volPieza)],
      ['area_pieza', 'REAL', (o) => num(o.areaPieza)],
      ['mostrar_pt', 'TEXT', 'mostrarPT'],
    ],
  },
  proveedores: {
    table: 'proveedores',
    columns: [
      ['clave', 'TEXT', 'clave'],
      ['nombre', 'TEXT', 'nombre'],
      ['rfc', 'TEXT', 'rfc'],
      ['marca', 'TEXT', 'marca'],
      ['regimen_fiscal', 'TEXT', 'regimenFiscal'],
      ['cp', 'TEXT', 'cp'],
      ['email', 'TEXT', 'email'],
      ['telefono', 'TEXT', 'telefono'],
    ],
  },
  clientes: {
    table: 'clientes',
    columns: [
      ['clave', 'TEXT', (o) => (o.clave == null ? null : String(o.clave))],
      ['nombre', 'TEXT', 'nombre'],
      ['rfc', 'TEXT', 'rfc'],
      ['rfc_receptor', 'TEXT', 'rfcReceptor'],
      ['email', 'TEXT', 'email'],
      ['telefono', 'TEXT', 'telefono'],
    ],
  },
  asesores: {
    table: 'usuarios',
    columns: [
      ['nombre', 'TEXT', 'nombre'],
      ['apellidos', 'TEXT', 'apellidos'],
      ['iniciales', 'TEXT', 'iniciales'],
      ['rol', 'TEXT', 'rol'],
      ['correo', 'TEXT', 'correo'],
      ['celular', 'TEXT', 'celular'],
    ],
  },
  pagosSemanas: {
    table: 'pagos_semanas',
    columns: [
      ['id', 'TEXT', (o) => String(o.id ?? '')],
      ['semana', 'TEXT', 'semana'],
      ['creado', 'TEXT', 'creado'],
      ['usuario', 'TEXT', 'usuario'],
    ],
  },
  // Catálogos simples (elementos string u objeto): solo ord + data.
  sistemasCat: { table: 'sistemas', columns: [['nombre', 'TEXT', 'nombre']] },
  segmentaciones: { table: 'segmentaciones', columns: [] },
  observacionesCat: { table: 'observaciones_cat', columns: [] },
  entregasCat: { table: 'entregas_cat', columns: [] },
  cuentasCat: { table: 'cuentas_cat', columns: [] },
  etapasEmbudo: { table: 'etapas_embudo', columns: [] },
};

// Resuelve el valor de una columna a partir de su definición `from`.
function colValue(from, obj) {
  const v = typeof from === 'function' ? from(obj) : obj[from];
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

// --- Esquema ------------------------------------------------------------------
function buildDDL() {
  const stmts = [];
  for (const def of Object.values(COLLECTIONS)) {
    const cols = def.columns.map(([n, t]) => `  ${n} ${t}`).join(',\n');
    stmts.push(
      `CREATE TABLE IF NOT EXISTS ${def.table} (\n  _rowid INTEGER PRIMARY KEY AUTOINCREMENT,\n  ord INTEGER${cols ? ',\n' + cols : ''},\n  data TEXT NOT NULL\n);`
    );
    if (def.child) {
      const c = def.child;
      const ccols = c.columns.map(([n, t]) => `  ${n} ${t}`).join(',\n');
      stmts.push(
        `CREATE TABLE IF NOT EXISTS ${c.table} (\n  _rowid INTEGER PRIMARY KEY AUTOINCREMENT,\n  ${c.parentCol} TEXT,\n  ord INTEGER${ccols ? ',\n' + ccols : ''},\n  data TEXT NOT NULL\n);`
      );
    }
  }
  // Configuración: escalares/objetos del state que no son colecciones.
  stmts.push(`CREATE TABLE IF NOT EXISTS config (\n  key TEXT PRIMARY KEY,\n  data TEXT NOT NULL\n);`);
  // Respaldo del blob crudo + adjuntos (arch-*, fact-*).
  stmts.push(`CREATE TABLE IF NOT EXISTS kv (\n  key TEXT PRIMARY KEY,\n  value TEXT,\n  updated_at TEXT DEFAULT (datetime('now'))\n);`);
  return stmts.join('\n\n');
}

// --- Descomposición: state -> tablas ------------------------------------------
export function decompose(db, state) {
  db.exec('BEGIN');
  try {
    for (const [key, def] of Object.entries(COLLECTIONS)) {
      db.exec(`DELETE FROM ${def.table}`);
      if (def.child) db.exec(`DELETE FROM ${def.child.table}`);
      const arr = Array.isArray(state[key]) ? state[key] : [];
      const colNames = def.columns.map(([n]) => n);
      const placeholders = ['?', '?', ...colNames.map(() => '?'), '?']; // ord + cols + data
      const insert = db.prepare(
        `INSERT INTO ${def.table} (ord${colNames.length ? ',' + colNames.join(',') : ''},data) VALUES (${placeholders.slice(0, colNames.length + 2).join(',')})`
      );
      let childInsert = null;
      if (def.child) {
        const cc = def.child.columns.map(([n]) => n);
        const cph = ['?', '?', ...cc.map(() => '?'), '?']; // parent + ord + cols + data
        childInsert = db.prepare(
          `INSERT INTO ${def.child.table} (${def.child.parentCol},ord${cc.length ? ',' + cc.join(',') : ''},data) VALUES (${cph.join(',')})`
        );
      }
      arr.forEach((obj, i) => {
        const isObj = obj !== null && typeof obj === 'object';
        const vals = def.columns.map(([, , from]) => (isObj ? colValue(from, obj) : null));
        insert.run(i, ...vals, JSON.stringify(obj ?? null));
        if (def.child && isObj) {
          const parts = Array.isArray(obj[def.child.arrayField]) ? obj[def.child.arrayField] : [];
          const pk = def.child.parentKey(obj);
          parts.forEach((pt, j) => {
            const pIsObj = pt !== null && typeof pt === 'object';
            const pvals = def.child.columns.map(([, , from]) => (pIsObj ? colValue(from, pt) : null));
            childInsert.run(pk, j, ...pvals, JSON.stringify(pt ?? null));
          });
        }
      });
    }
    // Config: todo lo que no sea colección conocida.
    db.exec('DELETE FROM config');
    const cfg = db.prepare('INSERT INTO config (key, data) VALUES (?, ?)');
    for (const [key, val] of Object.entries(state)) {
      if (key in COLLECTIONS) continue;
      cfg.run(key, JSON.stringify(val ?? null));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// --- Reensamblado: tablas -> state --------------------------------------------
export function reassemble(db) {
  const state = {};
  for (const [key, def] of Object.entries(COLLECTIONS)) {
    const rows = db.prepare(`SELECT data FROM ${def.table} ORDER BY ord`).all();
    state[key] = rows.map((r) => JSON.parse(r.data));
  }
  const cfg = db.prepare('SELECT key, data FROM config').all();
  for (const r of cfg) state[r.key] = JSON.parse(r.data);
  return state;
}

// ¿Ya hay datos normalizados? (para decidir migración inicial)
export function tablesPopulated(db) {
  for (const def of Object.values(COLLECTIONS)) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${def.table}`).get().n;
    if (n > 0) return true;
  }
  return db.prepare('SELECT COUNT(*) AS n FROM config').get().n > 0;
}

// --- Round-trip self-test (faithfulness) --------------------------------------
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// Compara el state original contra el reensamblado; devuelve claves con diferencias.
export function diffState(original, rebuilt) {
  const diffs = [];
  const keys = new Set([...Object.keys(original), ...Object.keys(rebuilt)]);
  for (const k of keys) {
    if (stableStringify(original[k]) !== stableStringify(rebuilt[k])) diffs.push(k);
  }
  return diffs;
}

export function openDB(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(buildDDL());
  return db;
}

export { COLLECTIONS };

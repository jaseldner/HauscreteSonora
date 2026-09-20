// Importa un respaldo JSON del CRM (Ajustes -> Generales -> respaldo) al SQLite.
//
// Uso:  node import-json.mjs "ruta\\al\\respaldo.json"
//
// El estado completo (state) se guarda como un solo valor bajo la clave
// "modulo-proyectos-v1", igual que hacía el navegador. Los adjuntos (imágenes,
// PDFs/XML) NO viajan en el respaldo; se migran aparte cuando toque.
//
// NOTA: el formato exacto del respaldo se confirma al ver un archivo real; este
// script detecta las variantes más probables (state crudo, o envuelto).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDB, decompose, reassemble, diffState, STATE_KEY } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'hauscrete.sqlite');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node import-json.mjs "ruta\\al\\respaldo.json"');
  process.exit(1);
}

// Señales de que un objeto ES el state del CRM.
const STATE_HINTS = ['projects', 'cotizaciones', 'productos', 'proveedores', 'clientes', 'asesores'];

function pareceState(o) {
  return o && typeof o === 'object' && STATE_HINTS.some((k) => k in o);
}

// Desenvuelve el respaldo hasta encontrar el objeto state.
function extraerState(raw) {
  if (pareceState(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const k of ['datos', STATE_KEY, 'state', 'data', 'value']) {
      let v = raw[k];
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
      if (pareceState(v)) return v;
    }
  }
  return null;
}

const rawText = await readFile(file, 'utf8');
let parsed;
try {
  parsed = JSON.parse(rawText);
} catch (e) {
  console.error('El archivo no es JSON válido:', e.message);
  process.exit(1);
}

const state = extraerState(parsed);
if (!state) {
  console.error('No reconocí el formato del respaldo. Envíame una muestra para ajustar el importador.');
  console.error('Claves de nivel superior encontradas:', Object.keys(parsed).join(', '));
  process.exit(1);
}

// Resumen de lo que se va a importar.
const conteo = (k) => (Array.isArray(state[k]) ? state[k].length : state[k] ? Object.keys(state[k]).length : 0);
console.log('\n  Contenido detectado en el respaldo:');
for (const k of STATE_HINTS) console.log(`    ${k.padEnd(14)} ${conteo(k)}`);
console.log(`    ${'sistemasCat'.padEnd(14)} ${conteo('sistemasCat')}`);

const db = openDB(DB_FILE);

const previo = db.prepare('SELECT value FROM kv WHERE key = ?').get(STATE_KEY);
if (previo) {
  console.log(`\n  ⚠  Ya existe estado guardado. Se sobrescribirá.`);
}

// Descompone en tablas normalizadas + guarda respaldo crudo + verifica round-trip.
decompose(db, state);
const diffs = diffState(state, reassemble(db));
if (diffs.length) {
  console.log('  ⚠  Round-trip con diferencias en:', diffs.join(', '), '(se conserva respaldo crudo)');
} else {
  console.log('  ✔  Round-trip verificado: tablas ↔ estado idénticos.');
}
db.prepare(
  `INSERT INTO kv(key, value, updated_at) VALUES(?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
).run(STATE_KEY, JSON.stringify(state));

console.log(`\n  ✔ Importado a ${DB_FILE}`);
console.log(`  ✔ Abre el CRM con: npm start  ->  http://localhost:3000\n`);

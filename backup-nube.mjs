// Respalda la base de datos EN LA NUBE (Fly.io) a un archivo local restaurable.
// Uso: doble clic en "Respaldar Nube.bat"  (o:  node backup-nube.mjs)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Carpeta de salida: por defecto backups/. La sincronización automática de las
// 11 pm manda BACKUP_DIR para dejar los suyos aparte (backups/diario).
const OUT_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');

// --- Datos de acceso a la nube ---
// Si cambias la contraseña de acceso del sistema, actualiza PASS aquí también.
const CLOUD = 'https://hauscrete-crm.fly.dev/api/storage';
const USER = 'hauscrete';
const PASS = 'Hauscrete2026';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

async function get(key) {
  const r = await fetch(`${CLOUD}/get?key=${encodeURIComponent(key)}`, { headers: { Authorization: AUTH } });
  if (r.status === 401) throw new Error('Contraseña de acceso incorrecta. Actualiza PASS en backup-nube.mjs.');
  if (!r.ok) throw new Error('La nube respondió HTTP ' + r.status);
  return r.json();
}

console.log('  Descargando la base desde la nube (hauscrete-crm.fly.dev)...');
const main = await get('modulo-proyectos-v1');
if (!main.value) throw new Error('La nube no devolvió datos.');
const state = JSON.parse(main.value);

// Adjuntos y demás claves (arch-*, fact-*), si hay
const keys = (await (await fetch(`${CLOUD}/list`, { headers: { Authorization: AUTH } })).json()).keys || [];
const adjuntos = {};
for (const k of keys) {
  if (k === 'modulo-proyectos-v1') continue;
  const v = await get(k);
  if (v.value !== undefined) adjuntos[k] = v.value;
}

// Sello de fecha/hora
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const sello = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;

const respaldo = {
  app: 'modulo-proyectos',
  version: 1,
  origen: 'nube',
  fecha: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  datos: state,
  adjuntos,
};

await mkdir(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `respaldo_NUBE_${sello}.json`);
await writeFile(out, JSON.stringify(respaldo, null, 2), 'utf8');

// --- Además, dejar la base LOCAL igual a la nube (espejo para pruebas) ---
let localStatus = 'no se actualizó';
try {
  const LOCAL = 'http://localhost:3000/api/storage';
  let serverUp = false;
  try { const r = await fetch(LOCAL + '/list', { signal: AbortSignal.timeout(1500) }); serverUp = r.ok; } catch {}
  if (serverUp) {
    // Servidor local en marcha: actualizar por su API.
    await fetch(LOCAL + '/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'modulo-proyectos-v1', value: main.value }) });
    for (const [k, v] of Object.entries(adjuntos)) await fetch(LOCAL + '/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k, value: v }) });
    localStatus = 'actualizada (servidor local en marcha)';
  } else {
    // Servidor local apagado: escribir directo en el archivo.
    const { openDB, decompose } = await import('./db.mjs');
    const db = openDB(path.join(__dirname, 'hauscrete.sqlite'));
    decompose(db, state);
    const setKv = db.prepare(`INSERT INTO kv(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`);
    for (const [k, v] of Object.entries(adjuntos)) setKv.run(k, v);
    db.close();
    localStatus = 'actualizada (archivo local)';
  }
} catch (e) {
  localStatus = 'no se pudo actualizar (' + e.message + ')';
}

const n = (k) => (Array.isArray(state[k]) ? state[k].length : 0);
console.log('\n  ✔ Respaldo de la NUBE generado:');
console.log('   ', out);
console.log('\n  Contenido:');
console.log('    proyectos    ', n('projects'));
console.log('    productos    ', n('productos'));
console.log('    cotizaciones ', n('cotizaciones'));
console.log('    proveedores  ', n('proveedores'));
console.log('    pagosSemanas ', n('pagosSemanas'));
console.log('    adjuntos     ', Object.keys(adjuntos).length);
console.log('\n  Base local:  ' + localStatus);

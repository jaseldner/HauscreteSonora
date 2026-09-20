// backup.mjs — Exporta un respaldo restaurable de TODA la base (incluye Ajustes).
//
// Uso:  node backup.mjs
//
// Genera un archivo en la carpeta backups/ con el MISMO formato que espera la app
// ({app, version, fecha, datos: state}), así se puede restaurar tanto con
// `node import-json.mjs` como con el botón "⬆ Restaurar respaldo" de la app.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDB, reassemble } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'hauscrete.sqlite');
const OUT_DIR = path.join(__dirname, 'backups');

const db = openDB(DB_FILE);
const state = reassemble(db);

// Sello de tiempo local YYYY-MM-DD_HHMM
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const sello = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;

const respaldo = {
  app: 'modulo-proyectos',
  version: 1,
  fecha: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  datos: state,
};

await mkdir(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `respaldo_hauscrete_${sello}.json`);
await writeFile(out, JSON.stringify(respaldo, null, 2), 'utf8');

// Resumen
const n = (k) => (Array.isArray(state[k]) ? state[k].length : 0);
console.log('\n  Respaldo generado:');
console.log('   ', out);
console.log('\n  Contenido:');
console.log('    productos     ', n('productos'));
console.log('    proveedores   ', n('proveedores'));
console.log('    clientes      ', n('clientes'));
console.log('    asesores      ', n('asesores'));
console.log('    sistemasCat   ', n('sistemasCat'));
console.log('    proyectos     ', n('projects'));
console.log('    cotizaciones  ', n('cotizaciones'));
console.log('    precios flia. ', Object.keys(state.preciosVentaFamilia || {}).length);
console.log('\n  Para restaurar: node import-json.mjs "' + out + '"\n');

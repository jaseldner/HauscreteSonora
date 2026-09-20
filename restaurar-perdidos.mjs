// Restaura elementos borrados por el conflicto de sesiones del 2026-07-13,
// tomándolos del respaldo backups/respaldo_NUBE_2026-07-13_1750.json.
// SOLO AGREGA lo que falte (por id/clave/iniciales/folio); NO modifica ni borra
// nada de lo que ya está en la nube. Re-ejecutable: si ya está todo, no escribe.
// Uso:  node restaurar-perdidos.mjs           (revisión, no escribe)
//       node restaurar-perdidos.mjs --aplicar (respalda, restaura y verifica)

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOUD = 'https://hauscrete-crm.fly.dev/api/storage';
const AUTH = 'Basic ' + Buffer.from('hauscrete:Hauscrete2026').toString('base64');
const KEY = 'modulo-proyectos-v1';
const APLICAR = process.argv.includes('--aplicar');
const RESPALDO = path.join(__dirname, 'backups', 'respaldo_NUBE_2026-07-13_1750.json');

const bkp = JSON.parse(await readFile(RESPALDO, 'utf8')).datos;

console.log('  Descargando el estado actual de la nube…');
const r = await fetch(`${CLOUD}/get?key=${encodeURIComponent(KEY)}`, { headers: { Authorization: AUTH } });
if (!r.ok) throw new Error('La nube respondió HTTP ' + r.status);
const main = await r.json();
const now = JSON.parse(main.value);

// Respaldo de seguridad del estado actual antes de tocar nada
const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
const sello = `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
await mkdir(path.join(__dirname, 'backups'), { recursive: true });
const bkpFile = path.join(__dirname, 'backups', `respaldo_ANTES_restaurar_${sello}.json`);
await writeFile(bkpFile, JSON.stringify({ app:'modulo-proyectos', origen:'nube', motivo:'pre-restauracion', datos: now }, null, 2), 'utf8');
console.log('  Respaldo del estado actual:', bkpFile);

const acciones = [];

// 1-2. Proyectos perdidos (por id)
const PROY_IDS = new Set();
for (const numHebel of ['10-4977', 'IN-0196']) {
  const pj = (bkp.projects || []).find(p => p.numHebel === numHebel);
  if (!pj) { console.log('  ⚠ No hallé', numHebel, 'en el respaldo'); continue; }
  PROY_IDS.add(pj.id);
  if (!(now.projects || []).some(p => p.id === pj.id)) {
    now.projects.push(pj);
    acciones.push(`proyecto ${pj.numHebel} ${pj.nombre}`);
  }
}

// 3. Cotización folio 3 (por id)
const c3 = (bkp.cotizaciones || []).find(c => c.folio === 3);
if (c3 && !(now.cotizaciones || []).some(c => c.id === c3.id)) {
  now.cotizaciones.push(c3);
  acciones.push(`cotización folio 3 (${(c3.partidas||[]).length} partidas, ${c3.usuario||''})`);
}

// 4. Asesor JAVZN (por iniciales)
const av = (bkp.asesores || []).find(a => a.iniciales === 'JAVZN');
if (av && !(now.asesores || []).some(a => a.iniciales === 'JAVZN')) {
  now.asesores.push(av);
  acciones.push('asesor JAVZN (Jose Antonio Vicente Zarate Navarro)');
}

// 5. Cliente CL-008 David Soto (por clave)
const cl = (bkp.clientes || []).find(c => c.clave === 'CL-008');
if (cl && !(now.clientes || []).some(c => c.clave === 'CL-008')) {
  now.clientes.push(cl);
  acciones.push('cliente CL-008 David Soto');
}

if (!acciones.length) {
  console.log('\n  ✔ Nada que restaurar: todo ya está en la nube.');
  process.exit(0);
}
console.log('\n  Por restaurar (' + acciones.length + '):');
acciones.forEach(a => console.log('   +', a));

if (!APLICAR) {
  console.log('\n  Modo revisión: nada escrito. Para aplicar:  node restaurar-perdidos.mjs --aplicar');
  process.exit(0);
}

console.log('\n  Subiendo el estado con lo restaurado…');
const res = await fetch(`${CLOUD}/set`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: AUTH },
  body: JSON.stringify({ key: KEY, value: JSON.stringify(now) }),
});
if (!res.ok) throw new Error('Error al escribir: HTTP ' + res.status);

// Verificación
const v = await (await fetch(`${CLOUD}/get?key=${encodeURIComponent(KEY)}`, { headers: { Authorization: AUTH } })).json();
const s2 = JSON.parse(v.value);
const ok =
  [...PROY_IDS].every(id => (s2.projects||[]).some(p => p.id === id)) &&
  (!c3 || (s2.cotizaciones||[]).some(c => c.id === c3.id)) &&
  (s2.asesores||[]).some(a => a.iniciales === 'JAVZN') &&
  (s2.clientes||[]).some(c => c.clave === 'CL-008');
console.log(ok ? '\n  ✔ Restaurado y verificado en la nube.' : '\n  ⚠ La verificación no encontró todo; revisar.');
console.log('  IMPORTANTE: todos los usuarios deben RECARGAR la página (Ctrl+F5) AHORA,');
console.log('  o su sesión vieja volverá a borrar lo restaurado al guardar.');

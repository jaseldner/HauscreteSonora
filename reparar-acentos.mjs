// Repara los acentos corruptos (�, U+FFFD) en los datos guardados en la NUBE.
// Causa: una importación vieja decodificó texto Windows-1252 como UTF-8 y perdió los acentos.
// Estrategia SEGURA: solo reemplaza valores de texto que coincidan EXACTAMENTE con la lista
// conocida; respalda antes; y si tras reparar queda alguna �, ABORTA sin escribir.
// Uso:  node reparar-acentos.mjs           (modo revisión, no escribe)
//       node reparar-acentos.mjs --aplicar (respalda, repara y sube a la nube)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOUD = 'https://hauscrete-crm.fly.dev/api/storage';
const USER = 'hauscrete', PASS = 'Hauscrete2026';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const KEY = 'modulo-proyectos-v1';
const APLICAR = process.argv.includes('--aplicar');

const R = '�'; // el carácter de reemplazo �
const MAP = new Map([
  [`M${R}`, 'M³'],
  [`M${R}xico`, 'México'],
  [`Nuevo Le${R}n`, 'Nuevo León'],
  [`Perif${R}rico`, 'Periférico'],
  [`Perif${R}ricos`, 'Periféricos'],
  [`Se capacitar${R} sin costo alguno a la mano de obra.`, 'Se capacitará sin costo alguno a la mano de obra.'],
  [`Se consider${R} una altura de muros seg${R}n planos.`, 'Se consideró una altura de muros según planos.'],
  [`Volumetr${R}a Preliminar Variable.`, 'Volumetría Preliminar Variable.'],
  [`La mercanc${R}a incluye seguro de transporte.`, 'La mercancía incluye seguro de transporte.'],
  [`El tiempo de entrega es de 7 d${R}as naturales una vez liquidado el 100% del pedido.`,
   'El tiempo de entrega es de 7 días naturales una vez liquidado el 100% del pedido.'],
  [`El material suministrado puede contener un 3 a 5% de merma por da${R}os durante su transporte y manejo. Este material es re-utilizable eliminando mediante corte la parte con da${R}o o resanando esa zona.`,
   'El material suministrado puede contener un 3 a 5% de merma por daños durante su transporte y manejo. Este material es re-utilizable eliminando mediante corte la parte con daño o resanando esa zona.'],
  [`Mamposter${R}a Confinada`, 'Mampostería Confinada'],
  [`Mamposter${R}a de Refuerzo Interior`, 'Mampostería de Refuerzo Interior'],
  [`Block AAC-4 Est${R}ndar/Semi-Jumbo`, 'Block AAC-4 Estándar/Semi-Jumbo'],
  [`Block AAC-6 Est${R}ndar/Semi-Jumbo/Dintel`, 'Block AAC-6 Estándar/Semi-Jumbo/Dintel'],
  [`Espuma Poliuretano Est${R}ndar 750 ml.`, 'Espuma Poliuretano Estándar 750 ml.'],
  [`Almac${R}n`, 'Almacén'],
  // Doble corrupción (��) vista en el dataset real importado
  [`Perif${R}${R}rico`, 'Periférico'],
  [`Perif${R}${R}ricos`, 'Periféricos'],
]);

let repl = 0;
function fix(o){
  if (o == null) return o;
  if (typeof o === 'string') { if (MAP.has(o)) { repl++; return MAP.get(o); } return o; }
  if (Array.isArray(o)) return o.map(fix);
  if (typeof o === 'object') { const out = {}; for (const k in o) out[k] = fix(o[k]); return out; }
  return o;
}
const contar = (s) => (JSON.stringify(s).match(/�/g) || []).length;

async function get(key){
  const r = await fetch(`${CLOUD}/get?key=${encodeURIComponent(key)}`, { headers: { Authorization: AUTH } });
  if (r.status === 401) throw new Error('Contraseña de acceso incorrecta.');
  if (!r.ok) throw new Error('La nube respondió HTTP ' + r.status);
  return r.json();
}

console.log('  Descargando el estado actual de la nube…');
const main = await get(KEY);
if (!main.value) throw new Error('La nube no devolvió datos.');
const state = JSON.parse(main.value);

const antes = contar(state);
console.log('  Caracteres � antes:', antes);

// Respaldo de seguridad (siempre, aunque sea modo revisión)
const d = new Date(), p = (n) => String(n).padStart(2, '0');
const sello = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
const OUT = path.join(__dirname, 'backups');
await mkdir(OUT, { recursive: true });
const bkp = path.join(OUT, `respaldo_ANTES_reparar_${sello}.json`);
await writeFile(bkp, JSON.stringify({ app:'modulo-proyectos', origen:'nube', motivo:'pre-reparacion-acentos', datos: state }, null, 2), 'utf8');
console.log('  Respaldo guardado en:', bkp);

const reparado = fix(state);
const despues = contar(reparado);
console.log('  Reemplazos exactos aplicados:', repl);
console.log('  Caracteres � después:', despues);

if (despues > 0){
  console.log('\n  ⚠ Aún quedan � sin mapear. NO se escribe nada. Textos con � restantes:');
  const restantes = new Set();
  (function walk(o){ if(o==null)return; if(typeof o==='string'){ if(o.includes(R)) restantes.add(o); return;} if(Array.isArray(o)){o.forEach(walk);return;} if(typeof o==='object'){for(const k in o)walk(o[k]);} })(reparado);
  restantes.forEach(s=>console.log('   ::: '+JSON.stringify(s)));
  process.exit(1);
}

if (!APLICAR){
  console.log('\n  ✔ Modo revisión: todo mapeado, 0 � restantes. Nada escrito.');
  console.log('  Para aplicar en la nube:  node reparar-acentos.mjs --aplicar');
  process.exit(0);
}

console.log('\n  Subiendo el estado reparado a la nube…');
const res = await fetch(`${CLOUD}/set`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: AUTH },
  body: JSON.stringify({ key: KEY, value: JSON.stringify(reparado) }),
});
if (!res.ok) throw new Error('Error al escribir en la nube: HTTP ' + res.status);

// Verificación: releer y contar
const verif = await get(KEY);
const q = contar(JSON.parse(verif.value));
console.log('  Verificación — caracteres � en la nube ahora:', q);
console.log(q === 0 ? '\n  ✔ Listo. Acentos reparados en la nube.' : '\n  ⚠ Revisar: aún quedan �.');

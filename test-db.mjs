// Prueba aislada de db.mjs: round-trip fiel + consultas SQL.
import { readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDB, decompose, reassemble, diffState, STATE_KEY } from './db.mjs';

const TMP = './_test.sqlite';
try { rmSync(TMP, { force: true }); rmSync(TMP + '-wal', { force: true }); rmSync(TMP + '-shm', { force: true }); } catch {}

// 1) Estado real (semilla) desde la base actual
const src = new DatabaseSync('hauscrete.sqlite');
const realState = JSON.parse(src.prepare('SELECT value FROM kv WHERE key=?').get(STATE_KEY).value);
src.close();

function probar(nombre, state) {
  const db = openDB(TMP);
  decompose(db, state);
  const rebuilt = reassemble(db);
  const diffs = diffState(state, rebuilt);
  console.log(`\n[${nombre}] diferencias: ${diffs.length === 0 ? 'NINGUNA ✔' : diffs.join(', ') + ' ✗'}`);
  db.close();
  rmSync(TMP, { force: true }); rmSync(TMP + '-wal', { force: true }); rmSync(TMP + '-shm', { force: true });
  return diffs.length === 0;
}

// Test A: estado real
probar('estado real (semilla)', realState);

// Test B: estado sintético con proyecto + cotización(partidas) + OC
const synthetic = JSON.parse(JSON.stringify(realState));
synthetic.projects = [
  { id: 1720000000001, folio: 177, numHebel: 'IN-0199', nombre: 'Casa Demo', cliente: 'Cliente X',
    promotor: 'Prom Y', asesor: 'Jose Adolfo Seldner Torres', estatus: 'proceso', embudo: 'Cotizado',
    ciudad: 'Hermosillo', estado: 'Sonora', creado: '2026-07-04 10:00:00', fechaSolicitud: '2026-07-01',
    seg: { valor: 120000, m3: 84.0336, factSel: [222], bitacora: [{ fecha: '2026-07-04 10:05:00', texto: 'nota', usuario: 'JAST' }] } },
];
synthetic.cotizaciones = [
  { id: 1720000000002, folio: 222, proyectoId: 1720000000001, fecha: '2026-07-04', vigencia: '2026-07-25',
    moneda: 'MXN', iva: 16, pago: 50, condicion: 'Crédito', referencia: 'REF-1', facturada: 'no', ocFolio: null,
    partidas: [
      { codigo: 'BL4202061', descripcion: 'Block AAC-4', cantidad: 84.0336, unidad: 'M³', precio: 7710, tipo: 'Block', desc: 0 },
      { codigo: 'MACX', descripcion: 'Mortero', cantidad: 30, unidad: 'Bulto', precio: 453, tipo: 'Mortero', desc: 5 },
    ],
    sistemas: ['Muro AAC'], notas: 'sin notas' },
];
synthetic.ocs = [
  { id: 1720000000003, folio: 'OC-001', cotId: 1720000000002, proyectoId: 1720000000001, fecha: '2026-07-04',
    proveedor: 'LITECRETE', partidas: [{ codigo: 'BL4202061', descripcion: 'Block', cantidad: 84.03, unidad: 'M³', precio: 3654, tipo: 'Block' }] },
];
synthetic.clientes = [{ clave: 1, nombre: 'Cliente X', rfc: 'XAXX010101000', email: 'x@y.com', telefono: '6620000000' }];
probar('estado sintético (proyecto+cotización+partidas+OC)', synthetic);

// Test C: verificar consultas SQL sobre las tablas normalizadas
const db = openDB(TMP);
decompose(db, synthetic);
console.log('\n[SQL] Consultas sobre tablas normalizadas:');
console.log('  productos:', db.prepare('SELECT COUNT(*) n FROM productos').get().n);
console.log('  usuarios por rol:', JSON.stringify(db.prepare('SELECT rol, COUNT(*) n FROM usuarios GROUP BY rol').all()));
console.log('  proyecto:', JSON.stringify(db.prepare('SELECT folio, num_hebel, nombre, asesor, estatus FROM projects').all()));
console.log('  partidas de cotización:', JSON.stringify(db.prepare('SELECT codigo, cantidad, precio, tipo FROM cotizacion_partidas ORDER BY ord').all()));
console.log('  subtotal cotización (SQL):',
  db.prepare('SELECT ROUND(SUM(cantidad*precio*(1-COALESCE(descuento,0)/100)),2) subtotal FROM cotizacion_partidas').get().subtotal);
console.log('  producto BL4 más caro:', JSON.stringify(db.prepare("SELECT codigo, precio FROM productos WHERE codigo LIKE 'BL4%' ORDER BY precio DESC LIMIT 1").get()));
db.close();
rmSync(TMP, { force: true }); rmSync(TMP + '-wal', { force: true }); rmSync(TMP + '-shm', { force: true });
console.log('\nListo.');

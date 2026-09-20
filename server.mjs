// Servidor local Hauscrete — Ruta A (SQLite en archivo, sin dependencias npm).
// Sirve el HTML del CRM y persiste window.storage en hauscrete.sqlite.
//
// Uso:  npm start   ->  http://localhost:3000
//
// El objeto window.storage del navegador (get/set/delete/list) se redirige a
// este servidor mediante un shim inyectado al vuelo en el HTML. El resto del
// archivo modulo-proyectos.html NO se modifica.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDB, decompose, reassemble, diffState, tablesPopulated, STATE_KEY } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HTML_FILE = process.env.HTML_FILE || 'modulo-proyectos.html';
// En la nube (Fly) la base vive en el disco persistente (/data). Local: junto al código.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'hauscrete.sqlite');
// Contraseña de acceso opcional (Basic Auth). Si se define ACCESO_PASS, el sitio la pide.
const ACCESO_USER = process.env.ACCESO_USER || 'hauscrete';
const ACCESO_PASS = process.env.ACCESO_PASS || '';

// --- Base de datos: tablas normalizadas (fuente de verdad) + kv (adjuntos/respaldo) --
const db = openDB(DB_FILE);

const stmt = {
  get:  db.prepare('SELECT value FROM kv WHERE key = ?'),
  set:  db.prepare(`INSERT INTO kv(key, value, updated_at) VALUES(?, ?, datetime('now'))
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`),
  del:  db.prepare('DELETE FROM kv WHERE key = ?'),
  list: db.prepare('SELECT key FROM kv ORDER BY key'),
};

/* RF-572: las CLAVES del calendario suscribible (/cal/<token>.ics) viven en una tabla
   PROPIA del servidor, no solo en la ficha del state. Motivo: el 04/09/2026 otra sesión
   guardó una copia vieja de las fichas, la clave de JAST se perdió, el sistema generó
   otra y el iPhone (suscrito a la vieja) se quedó mudo. Con la tabla: una clave activa
   sigue sirviendo aunque el state la pierda; el cliente pide la clave al servidor en
   vez de inventarla; "Generar liga nueva" revoca las anteriores. */
db.exec(`CREATE TABLE IF NOT EXISTS cal_tokens (
  token   TEXT PRIMARY KEY,
  usuario TEXT NOT NULL,
  creado  TEXT,
  activo  INTEGER NOT NULL DEFAULT 1
)`);
const calStmt = {
  porToken:   db.prepare('SELECT usuario, activo FROM cal_tokens WHERE token = ?'),
  porUsuario: db.prepare('SELECT token FROM cal_tokens WHERE usuario = ? AND activo = 1 ORDER BY creado DESC LIMIT 1'),
  poner:      db.prepare(`INSERT INTO cal_tokens(token, usuario, creado, activo) VALUES(?, ?, datetime('now'), 1)
                          ON CONFLICT(token) DO UPDATE SET usuario = excluded.usuario, activo = 1`),
  revocar:    db.prepare('UPDATE cal_tokens SET activo = 0 WHERE usuario = ?'),
};
const calNuevoToken = () => { const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; let t = ''; for (let i = 0; i < 32; i++) t += abc[Math.floor(Math.random() * abc.length)]; return t; };
const nombreFicha = (a) => [a.nombre, a.apellidos].filter(Boolean).join(' ').trim() || a.nombre || '';

// El state completo se maneja aparte: se DESCOMPONE en tablas al guardar y se
// REENSAMBLA al leer. La clave STATE_KEY nunca se sirve desde kv (kv guarda solo
// un respaldo del blob crudo y los adjuntos arch-*/fact-*).

// RF-394: Guardarraíl anti-vaciado. Un navegador que arranca en blanco (p.ej.
// mientras el servidor está caído, como en el incidente OOM del 25/08/2026)
// puede mandar un state casi vacío que pisaría toda la base (last-write-wins).
// Si la base ya tiene datos y el state entrante trae una fracción mínima, el
// guardado se rechaza. Cubre /api/storage/set y /merge (ambos pasan por aquí).
// Una restauración intencional se hace con {"force":true} en el POST /set.
const GUARD_COLS = ['projects', 'clientes', 'cotizaciones'];
const GUARD_MIN = 8;     // solo protege cuando ya hay al menos esto guardado (8 para que un sistema nuevo, como Baja, quede cubierto pronto)
const GUARD_FRAC = 0.2;  // rechaza si llega menos del 20% de lo guardado
function verificarNoVaciado(state) {
  for (const col of GUARD_COLS) {
    let antes = 0;
    try { antes = db.prepare(`SELECT COUNT(*) AS c FROM ${col}`).get().c; } catch { continue; }
    const ahora = Array.isArray(state[col]) ? state[col].length : 0;
    if (antes >= GUARD_MIN && ahora < antes * GUARD_FRAC) {
      const e = new Error(
        `Guardado rechazado por seguridad: ${col} pasaría de ${antes} a ${ahora} registros. ` +
        'Parece una sesión con datos vacíos o muy viejos. Recarga la página (F5) y reintenta. ' +
        'Si de verdad es una restauración, el script debe mandar force:true.');
      e.esGuardarrail = true;
      throw e;
    }
  }
}

// Guarda el state: descompone en tablas + respaldo crudo + auto-test round-trip.
/* RF-610: una LISTA DE PRECIOS de proveedor que ya tiene precios nunca se vacía por
   un guardado normal. Pasó dos veces con Litecrete (11 y ~12/09/2026): una sesión con
   la ficha vieja del proveedor (sin lista) la guardaba entera y la nube se quedaba con
   0 precios, el descuento de fábrica 38 % y sin la referencia al PDF. Si lo que llega
   trae un año sin precios (o no lo trae) y lo guardado sí tiene precios, se conserva
   lo guardado; si llega sin PDF y el guardado lo tenía, se conserva el PDF. Una
   restauración o un vaciado a propósito se hace con force:true. */
function conservarListasPrecios(state) {
  if (!Array.isArray(state.proveedores)) return 0;
  let previos;
  try { previos = db.prepare('SELECT data FROM proveedores').all().map((r) => JSON.parse(r.data)); }
  catch { return 0; }
  const porClave = new Map(previos.filter((p) => p && p.clave).map((p) => [p.clave, p]));
  const nPrecios = (l) => Object.keys((l && l.precios) || {}).length;
  let arreglos = 0;
  for (const prov of state.proveedores) {
    const ant = prov && porClave.get(prov.clave);
    if (!ant || !ant.listasPrecios) continue;
    for (const [anio, lAnt] of Object.entries(ant.listasPrecios)) {
      if (!lAnt) continue;
      const lNva = prov.listasPrecios && prov.listasPrecios[anio];
      if (nPrecios(lAnt) > 0 && nPrecios(lNva) === 0) {
        prov.listasPrecios = prov.listasPrecios && typeof prov.listasPrecios === 'object' ? prov.listasPrecios : {};
        prov.listasPrecios[anio] = lAnt;
        arreglos++;
        console.warn(`  ⚠ RF-610: se conservó la lista de precios ${anio} de ${prov.clave} (${nPrecios(lAnt)} precios); llegaba vacía.`);
      } else if (lNva && lAnt.pdf && !lNva.pdf) {
        lNva.pdf = lAnt.pdf;
        arreglos++;
        console.warn(`  ⚠ RF-610: se conservó el PDF de la lista ${anio} de ${prov.clave}; llegaba sin él.`);
      }
    }
  }
  return arreglos;
}

/* RF-611: los márgenes de Costo - Venta (state.margenesVenta = {Hebel:{…}, Abrasivos:{…}})
   nunca se pierden por un guardado que los traiga vacíos: las pestañas con la versión
   anterior creaban un {} con solo abrir Ajustes → Costo - Venta y lo mandaban. Si lo
   que llega no trae una línea que sí estaba guardada, esa línea se conserva. */
function conservarMargenesVenta(state) {
  let ant;
  try {
    const row = db.prepare("SELECT data FROM config WHERE key = 'margenesVenta'").get();
    ant = row ? JSON.parse(row.data) : null;
  } catch { return 0; }
  if (!ant || typeof ant !== 'object') return 0;
  const nva = (state.margenesVenta && typeof state.margenesVenta === 'object') ? state.margenesVenta : {};
  let n = 0;
  for (const [linea, mg] of Object.entries(ant)) {
    if (mg && Object.keys(mg).length && !(nva[linea] && Object.keys(nva[linea]).length)) {
      nva[linea] = mg; n++;
      console.warn(`  ⚠ RF-611: se conservaron los márgenes de la línea ${linea}; llegaban vacíos.`);
    }
  }
  if (n) state.margenesVenta = nva;
  return n;
}

function guardarState(rawString, opts = {}) {
  const state = JSON.parse(rawString);
  if (!opts.force) verificarNoVaciado(state);
  if (!opts.force && conservarListasPrecios(state)) rawString = JSON.stringify(state);   // RF-610
  if (!opts.force && conservarMargenesVenta(state)) rawString = JSON.stringify(state);   // RF-611
  decompose(db, state);
  // Auto-test de fidelidad: state -> tablas -> state debe ser idéntico.
  const diffs = diffState(state, reassemble(db));
  if (diffs.length) {
    console.warn('  ⚠ Round-trip con diferencias en:', diffs.join(', '), '(se conserva respaldo crudo)');
  }
  // Respaldo del blob crudo (recuperación ante desastre + compat con import-json).
  stmt.set.run(STATE_KEY, rawString);
}

// Lee el state reensamblado desde las tablas; si aún no hay, usa el respaldo kv.
function leerStateValue() {
  if (tablesPopulated(db)) return JSON.stringify(reassemble(db));
  const row = stmt.get.get(STATE_KEY);
  return row ? row.value : undefined;
}

// --- Revisión para sincronización en vivo (RF-77) ------------------------------
// Sube con cada escritura. Las sesiones la sondean: si cambió, bajan el estado
// y fusionan en pantalla los cambios de los demás sin recargar.
const REV_KEY = '__rev';
function leerRev() {
  const row = stmt.get.get(REV_KEY);
  return row ? Number(row.value) || 0 : 0;
}
function subirRev() {
  const v = leerRev() + 1;
  stmt.set.run(REV_KEY, String(v));
  return v;
}

// --- Guardado por fusión (multiusuario) ---------------------------------------
// Cada sesión manda solo SUS cambios (delta) y el servidor los fusiona sobre el
// estado guardado. Así una pestaña con datos viejos ya no borra los registros
// que otras sesiones crearon después de que ella cargó.
// Campo llave por colección (debe coincidir con COL_ID del cliente en el HTML):
const COL_ID = {
  projects: 'id', cotizaciones: 'id', ocs: 'id', pagosSemanas: 'id', prefacturas: 'id',
  eventos: 'id',
  planDemanda: 'id', invRecepciones: 'id',
  // RF-612: consignación, muestras e inventario móvil, registro por registro
  consigMovs: 'id', muestras: 'id', movilMovs: 'id',
  clientes: 'clave', proveedores: 'clave', asesores: 'iniciales', productos: 'codigo',
  sistemasCat: 'nombre', cuentasCat: 'nombre',
};

const LISTAS_MIGRADAS = new Set(['consigMovs', 'muestras']);   // RF-612
function fusionarDelta(delta) {
  const raw = leerStateValue();
  const state = raw ? JSON.parse(raw) : {};
  // Altas/cambios de registros (por llave)
  for (const [col, regs] of Object.entries(delta.upserts || {})) {
    const idf = COL_ID[col];
    if (!idf || !Array.isArray(regs)) continue;
    if (!Array.isArray(state[col])) state[col] = [];
    for (const reg of regs) {
      if (!reg || reg[idf] === undefined) continue;
      const i = state[col].findIndex((x) => x && x[idf] === reg[idf]);
      if (i > -1) state[col][i] = reg; else state[col].push(reg);
    }
  }
  // Bajas de registros (por llave) — solo las que la sesión hizo a propósito
  for (const [col, ids] of Object.entries(delta.deletes || {})) {
    const idf = COL_ID[col];
    if (!idf || !Array.isArray(state[col])) continue;
    const quitar = new Set(ids);
    state[col] = state[col].filter((x) => !quitar.has(x && x[idf]));
  }
  // Listas simples (segmentaciones, entregasCat, observacionesCat…): reemplazo total
  for (const [col, arr] of Object.entries(delta.listas || {})) {
    /* RF-612: consigMovs y muestras antes viajaban como lista completa. Una pestaña que
       siga con la versión anterior las manda así: se toman registro por registro (altas
       y cambios) y NUNCA se reemplaza la lista entera, para que no pise lo de otros. */
    if (LISTAS_MIGRADAS.has(col) && Array.isArray(arr)) {
      if (!Array.isArray(state[col])) state[col] = [];
      for (const reg of arr) {
        if (!reg || reg.id === undefined) continue;
        const i = state[col].findIndex((x) => x && x.id === reg.id);
        if (i > -1) state[col][i] = reg; else state[col].push(reg);
      }
      continue;
    }
    if (COL_ID[col]) continue; // las colecciones con llave nunca entran aquí
    state[col] = arr;
  }
  // Escalares; los contadores next* nunca retroceden (max de ambos)
  for (const [k, v] of Object.entries(delta.escalares || {})) {
    state[k] = (/^next/.test(k) && typeof v === 'number' && typeof state[k] === 'number')
      ? Math.max(state[k], v) : v;
  }
  guardarState(JSON.stringify(state));
}

// Migración inicial: si hay un blob viejo en kv pero las tablas están vacías,
// pásalo a las tablas normalizadas una sola vez.
if (!tablesPopulated(db)) {
  const row = stmt.get.get(STATE_KEY);
  if (row && row.value) {
    try {
      guardarState(row.value);
      console.log('  ↪ Estado existente migrado del blob kv a tablas normalizadas.');
    } catch (e) {
      console.warn('  ⚠ No se pudo migrar el blob inicial:', e.message);
    }
  }
}

// --- Shim de cliente: reemplaza window.storage para apuntar a este servidor ---
// Se inyecta al inicio del <head> para existir antes que el código de la app.
//
// CONTRATO EXACTO del entorno original (verificado en modulo-proyectos.html):
//   get(key)      -> { value: "<string>" }   (o {} si no existe)  [app hace JSON.parse(r.value)]
//   set(key, val) -> objeto truthy           (la app hace `if(!res) throw`)
//   delete(key)   -> sin uso del retorno
//   list()        -> array de claves
// Los valores son STRINGS opacos: la app hace su propio JSON.stringify/parse.
const STORAGE_SHIM = `
<script data-hauscrete-storage-shim>
(function () {
  const BASE = '/api/storage';
  async function req(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('storage ' + url + ' -> HTTP ' + r.status);
    return r.status === 204 ? null : r.json();
  }
  const storage = {
    // Devuelve el envoltorio { value } tal cual lo espera la app.
    async get(key) {
      return await req(BASE + '/get?key=' + encodeURIComponent(key));
    },
    // Devuelve la respuesta del servidor (truthy) para el chequeo if(!res).
    async set(key, value) {
      return await req(BASE + '/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
    },
    async delete(key) {
      await req(BASE + '/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
    },
    async list() {
      const j = await req(BASE + '/list');
      return j.keys;
    },
  };
  // Fijamos window.storage y evitamos que la app lo reasigne por su cuenta.
  try {
    Object.defineProperty(window, 'storage', { value: storage, writable: false, configurable: false });
  } catch (e) {
    window.storage = storage;
  }
})();
</script>
`;

// --- Utilidades HTTP ----------------------------------------------------------
function sendJSON(res, code, obj) {
  const body = obj === null ? '' : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 50 * 1024 * 1024) reject(new Error('cuerpo demasiado grande'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveHTML(res) {
  const file = path.join(__dirname, HTML_FILE);
  try {
    let html = await readFile(file, 'utf8');
    // Inyecta el shim lo antes posible: tras <head>, o si no hay, al inicio.
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => m + STORAGE_SHIM);
    } else {
      html = STORAGE_SHIM + html;
    }
    // RF-227b: sin caché — el navegador SIEMPRE recibe la versión recién desplegada
    // (antes los usuarios veían versiones viejas hasta hacer Ctrl+Shift+R).
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store, must-revalidate' });
    res.end(html);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<h1>Falta ${HTML_FILE}</h1><p>Coloca tu archivo <code>${HTML_FILE}</code> en esta carpeta:<br>` +
        `<code>${__dirname}</code></p>`
    );
  }
}

async function serveStatic(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/+/, ''));
  const file = path.join(__dirname, rel);
  // No salir de la carpeta del proyecto.
  if (!file.startsWith(__dirname)) return sendJSON(res, 403, { error: 'prohibido' });
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('no es archivo');
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('No encontrado');
  }
}

/* --- RF-172: revisión automática del SAT ------------------------------------
   La máquina de la nube se SUSPENDE cuando nadie usa el sistema, así que un
   temporizador no serviría. En su lugar, la revisión se dispara con el uso normal:
   cada vez que llega tráfico, si ya pasó el intervalo, se consulta al SAT en
   segundo plano (sin hacer esperar a nadie). Así, mientras alguien trabaje en el
   CRM, las facturas van cayendo solas a la bandeja.                             */
const SAT_CADA_MS = Number(process.env.SAT_INTERVALO_MIN || 60) * 60 * 1000;
const KEY_SAT_ULTIMA = '__sat_ultima_revision';
let _satCorriendo = false;
function satRevisionAutomatica() {
  if (_satCorriendo) return;
  const ahora = Date.now();
  let ultima = 0;
  try { ultima = Number((stmt.get.get(KEY_SAT_ULTIMA) || {}).value) || 0; } catch {}
  if (ahora - ultima < SAT_CADA_MS) return;
  _satCorriendo = true;
  stmt.set.run(KEY_SAT_ULTIMA, String(ahora));   // se marca antes para no encimar corridas
  (async () => {
    try {
      const SAT = await import('./sat-descarga.mjs');
      if (!SAT.satConfigurado()) return;
      let desdeMinimo = null;   // RF-628: para llenar el concepto de lo que ya está en la bandeja
      try { const raw0 = leerStateValue(); desdeMinimo = SAT.satDesdeSinConcepto(raw0 ? JSON.parse(raw0) : {}); } catch {}
      const r = await SAT.satDescargar({
        leerEstado: async () => { try { return JSON.parse((stmt.get.get(SAT.KEY_ESTADO) || {}).value || '{}'); } catch { return {}; } },
        guardarEstado: async (est) => { stmt.set.run(SAT.KEY_ESTADO, JSON.stringify(est)); },
        desdeMinimo,
      });
      if (r.ok && r.items.length) {
        const raw = leerStateValue();
        const state = raw ? JSON.parse(raw) : {};
        const completadas = SAT.satCompletarBandeja(r.items, state);   // RF-628
        const nuevos = SAT.satNuevosParaBandeja(r.items, state);
        if (nuevos.length || completadas) {
          state.satBandeja = (state.satBandeja || []).concat(nuevos);
          guardarState(JSON.stringify(state));
          subirRev();
          console.log(`  SAT: ${nuevos.length} factura(s) nueva(s) en la bandeja; ${completadas} con concepto completado.`);
        }
      }
    } catch (e) {
      console.warn('  SAT (revisión automática):', e && e.message || e);
    } finally { _satCorriendo = false; }
  })();
}

/* --- RF-204: avisos programados de eventos por Telegram -----------------------
   Corre cada minuto mientras la máquina está despierta (setInterval) y también se
   dispara con el tráfico, igual que el SAT. Si la máquina dormía, los avisos salen
   al despertar (los muy viejos se descartan en telegram.mjs). */
const TG_AVISOS_MS = 60 * 1000;
let _tgUltimaAvisos = 0;
let _tgAvisosCorriendo = false;
function telegramAvisosAutomaticos() {
  const ahora = Date.now();
  if (_tgAvisosCorriendo || ahora - _tgUltimaAvisos < TG_AVISOS_MS) return;
  _tgUltimaAvisos = ahora;
  _tgAvisosCorriendo = true;
  (async () => {
    try {
      const TG = await import('./telegram.mjs');
      if (!TG.tgConfigurado()) return;
      const state = JSON.parse(leerStateValue() || '{}');
      const r = await TG.tgEnviarAvisosEventos({
        state,
        leerEstado: async () => { try { return JSON.parse((stmt.get.get(TG.KEY_ESTADO) || {}).value || '{}'); } catch { return {}; } },
        guardarEstado: async (est) => { stmt.set.run(TG.KEY_ESTADO, JSON.stringify(est)); },
      });
      if (r.avisados) console.log(`  Telegram: ${r.avisados} aviso(s) de evento enviados.`);
    } catch (e) { console.warn('  Telegram (avisos):', e && e.message || e); }
    finally { _tgAvisosCorriendo = false; }
  })();
}
const _tgTimer = setInterval(telegramAvisosAutomaticos, TG_AVISOS_MS);
if (_tgTimer.unref) _tgTimer.unref();

/* --- RF-209: reporte administrativo diario por Telegram (6:00 PM por default) ---
   Va a los usuarios con la casilla "información administrativa" y Telegram
   conectado. Mismo patrón que los avisos: cada minuto despierto + con tráfico;
   el kv __repadmin evita mandarlo dos veces el mismo día. */
async function enviarReporteAdmin(state, TG, REP) {
  const texto = REP.repAdminTexto(state, 'Hauscrete');
  if (!texto) return { enviados: 0, error: 'Sin semanas registradas en Pago a Proveedores.' };
  let enviados = 0; const destinatarios = [];
  for (const a of (state.asesores || [])) {
    if (!a.tgInfoAdmin || !a.tg || !a.tg.chatId) continue;
    try { await TG.tgEnviar(a.tg.chatId, texto); enviados++; destinatarios.push(((a.nombre || '') + ' ' + (a.apellidos || '')).trim()); }
    catch (e) { console.warn('  Reporte admin →', a.iniciales, ':', e && e.message || e); }
  }
  return { enviados, destinatarios, texto };
}
// RF-259b: mensaje MATUTINO de depósitos — TODOS los depósitos programados para hoy
// (de quien sea que los haya fijado) les llegan a TODOS los usuarios seleccionados.
async function enviarReporteDepositos(state, TG, REP) {
  const texto = REP.repDepositosTexto(state, 'Hauscrete');   // todos los depósitos, con quién los fijó
  if (!texto) return { enviados: 0, destinatarios: [], texto: '(hoy no hay depósitos programados)' };
  let enviados = 0; const destinatarios = [];
  for (const a of (state.asesores || [])) {
    if (!a.tgInfoAdmin || !a.tg || !a.tg.chatId) continue;
    const nombre = ((a.nombre || '') + ' ' + (a.apellidos || '')).trim();
    try { await TG.tgEnviar(a.tg.chatId, texto); enviados++; destinatarios.push(nombre); }
    catch (e) { console.warn('  Reporte depósitos →', a.iniciales, ':', e && e.message || e); }
  }
  return { enviados, destinatarios, texto };
}
let _repDepCorriendo = false, _repDepUltima = 0;
function reporteDepositosAutomatico() {
  const ahora = Date.now();
  if (_repDepCorriendo || ahora - _repDepUltima < 60000) return;
  _repDepUltima = ahora; _repDepCorriendo = true;
  (async () => {
    try {
      const REP = await import('./reporte-admin.mjs');
      const state = JSON.parse(leerStateValue() || '{}');
      const row = stmt.get.get('__repdepositos');
      if (!REP.repDepositosToca(state, row ? row.value : '')) return;
      const TG = await import('./telegram.mjs');
      if (!TG.tgConfigurado()) return;
      await enviarReporteDepositos(state, TG, REP);
      stmt.set.run('__repdepositos', REP.repAhoraLocal().toISOString().slice(0, 10));
    } catch (e) { console.warn('reporteDepositosAutomatico:', e && e.message || e); }
    finally { _repDepCorriendo = false; }
  })();
}
const _repDepTimer = setInterval(reporteDepositosAutomatico, 60000);
let _repAdmCorriendo = false, _repAdmUltima = 0;
function reporteAdminAutomatico() {
  const ahora = Date.now();
  if (_repAdmCorriendo || ahora - _repAdmUltima < 60000) return;
  _repAdmUltima = ahora; _repAdmCorriendo = true;
  (async () => {
    try {
      const TG = await import('./telegram.mjs');
      if (!TG.tgConfigurado()) return;
      const REP = await import('./reporte-admin.mjs');
      const row = stmt.get.get('__repadmin');
      const state = JSON.parse(leerStateValue() || '{}');
      if (!REP.repAdminToca(state, row ? row.value : '')) return;
      const r = await enviarReporteAdmin(state, TG, REP);
      stmt.set.run('__repadmin', REP.repAhoraLocal().toISOString().slice(0, 10));
      if (r.enviados) console.log(`  Reporte administrativo enviado a ${r.enviados} persona(s).`);
    } catch (e) { console.warn('  Reporte admin (auto):', e && e.message || e); }
    finally { _repAdmCorriendo = false; }
  })();
}
const _repAdmTimer = setInterval(reporteAdminAutomatico, 60000);
if (_repAdmTimer.unref) _repAdmTimer.unref();

// --- Router -------------------------------------------------------------------
/* ================== TIMBRADO (PAC: Facturapi) ==================
   La llave del PAC vive SOLO en el servidor (secreto de Fly), nunca en el
   navegador. Con llave sk_test_… el timbrado es de PRUEBA (gratis, sin valor
   fiscal); con sk_live_… es real. El navegador manda los datos del ticket y
   recibe el XML timbrado, que se guarda igual que el que hoy se sube a mano. */
const FACTURAPI_KEY = process.env.FACTURAPI_KEY || '';
const FACTURAPI_URL = 'https://www.facturapi.io/v2';
const pacEsPrueba = () => /^sk_test/i.test(FACTURAPI_KEY);
async function pacFetch(ruta, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(FACTURAPI_URL + ruta, Object.assign({
      headers: {
        'Authorization': 'Bearer ' + FACTURAPI_KEY,
        'Content-Type': 'application/json',
      },
      signal: ctrl.signal,
    }, opts || {}));
    const txt = await r.text();
    return { status: r.status, ok: r.ok, texto: txt };
  } catch (e) {
    return { status: 0, ok: false, texto: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const p = u.pathname;
    satRevisionAutomatica();       // no bloquea la petición
    telegramAvisosAutomaticos();   // RF-204: tampoco
    reporteAdminAutomatico();      // RF-209: tampoco
    reporteDepositosAutomatico();  // RF-259: mensaje matutino de depósitos

    /* ---- Webhook de Telegram (RF-202) ----
       Telegram no puede mandar Basic Auth, así que este endpoint va ANTES de la
       puerta de acceso; se protege con un secreto propio (el header que Telegram
       reenvía). Al llegar "/start <código>" se vincula el chat con el asesor. */
    if (p === '/api/telegram/webhook' && req.method === 'POST') {
      const TG = await import('./telegram.mjs');
      const secretOk = !TG.tgWebhookSecret() ||
        req.headers['x-telegram-bot-api-secret-token'] === TG.tgWebhookSecret();
      if (!secretOk) { res.writeHead(401); res.end('no'); return; }
      let update = {};
      try { update = JSON.parse(await readBody(req)); } catch { /* body vacío/ inválido */ }
      try {
        const state = JSON.parse(leerStateValue() || '{}');
        const r = await TG.tgProcesarUpdate(update, state);
        if (r && r.cambio) { guardarState(JSON.stringify(state)); subirRev(); }
      } catch (e) { console.warn('  Telegram (webhook):', e && e.message || e); }
      return sendJSON(res, 200, { ok: true });   // Telegram solo necesita 200
    }

    /* RF-562: CALENDARIO SUSCRIBIBLE (.ics) — el iPhone/Android/Outlook se suscribe
       a "/cal/<token>.ics" y ve SUS eventos y recordatorios del embudo, siempre al
       día. Va ANTES del Basic Auth porque el teléfono no manda usuario/contraseña:
       el permiso es el TOKEN (32 hex, propio de cada usuario, revocable desde su
       perfil). Solo lectura: lo que se mueva en el teléfono no regresa al sistema. */
    if (req.method === 'GET' && /^\/cal\/[A-Za-z0-9]{16,64}\.ics$/.test(p)) {
      const token = p.slice(5, -4);
      let state = {};
      try { state = JSON.parse(leerStateValue() || '{}'); } catch { state = {}; }
      /* RF-572: 1º la tabla cal_tokens (sobrevive aunque el state pierda la clave);
         2º la ficha del state — y de paso se registra en la tabla para la próxima. */
      let ases = null;
      try {
        const row = calStmt.porToken.get(token);
        if (row && row.activo) ases = (state.asesores || []).find(a => a && nombreFicha(a) === row.usuario) || null;
      } catch {}
      if (!ases) {
        ases = (state.asesores || []).find(a => a && a.calToken === token) || null;
        if (ases) { try { calStmt.poner.run(token, nombreFicha(ases)); } catch {} }
      }
      if (!ases) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Calendario no encontrado'); return; }
      const yo = nombreFicha(ases);
      const esc = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
      // Plegado a 75 octetos como pide el RFC 5545 (si no, algunos clientes truncan)
      const fold = l => { const out = []; let s = l; while (Buffer.byteLength(s, 'utf8') > 73) { let i = 73; while (Buffer.byteLength(s.slice(0, i), 'utf8') > 73) i--; out.push(s.slice(0, i)); s = ' ' + s.slice(i); } out.push(s); return out.join('\r\n'); };
      const dt = (f, h) => String(f || '').replace(/-/g, '') + 'T' + String(h || '00:00').replace(':', '') + '00';
      const dia = f => String(f || '').replace(/-/g, '');
      const diaMas1 = f => { const [y, m, d] = String(f || '').split('-').map(Number); const x = new Date(y, (m || 1) - 1, (d || 1) + 1); return x.getFullYear() + String(x.getMonth() + 1).padStart(2, '0') + String(x.getDate()).padStart(2, '0'); };
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const host = req.headers.host || 'crm';
      const L = [];
      const push = (...xs) => xs.forEach(x => L.push(fold(x)));
      push('BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hauscrete//CRM//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'X-WR-CALNAME:' + esc((state.empresaNombre || 'Hauscrete') + ' · ' + yo),
        /* RF-569: se le pide al teléfono releer cada 15 min (antes 1 h). iPhone lo
           respeta según Ajustes → Calendario → Cuentas → Obtener datos; Google lo
           ignora (relee cada 8–24 h). Los cambios a un evento SÍ se propagan: mismo
           UID y DTSTAMP nuevo en cada lectura. */
        'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M');
      const alarmas = (avisos) => (Array.isArray(avisos) ? avisos : []).forEach(min => {
        const m = Number(min) || 0;
        push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Recordatorio',
          'TRIGGER:' + (m > 0 ? ('-PT' + (m % 60 === 0 ? (m / 60) + 'H' : m + 'M')) : 'PT0M'), 'END:VALARM');
      });
      const evento = (uid, titulo, fecha, horaIni, horaFin, todoElDia, lugar, desc, avisos) => {
        if (!fecha) return;
        push('BEGIN:VEVENT', 'UID:' + uid + '@' + host, 'DTSTAMP:' + stamp);
        if (todoElDia || !horaIni) { push('DTSTART;VALUE=DATE:' + dia(fecha), 'DTEND;VALUE=DATE:' + diaMas1(fecha)); }
        else {
          push('DTSTART:' + dt(fecha, horaIni));
          let hf = horaFin;
          if (!hf) { const [a, b] = String(horaIni).split(':').map(Number); const t = (a * 60 + (b || 0) + 60); hf = String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); }
          push('DTEND:' + dt(fecha, hf));
        }
        push('SUMMARY:' + esc(titulo || '(sin título)'));
        if (lugar) push('LOCATION:' + esc(lugar));
        if (desc) push('DESCRIPTION:' + esc(desc));
        alarmas(avisos);
        push('END:VEVENT');
      };
      const proyLbl = id => { const pr = (state.projects || []).find(x => x && x.id === id); return pr ? [pr.numHebel, pr.nombre].filter(Boolean).join(' · ') : ''; };
      // 1) Citas del calendario donde es dueño o invitado
      (state.eventos || []).forEach(ev => {
        if (!ev) return;
        const mio = (ev.para || '') === yo || (Array.isArray(ev.invitados) && ev.invitados.includes(yo));
        if (!mio) return;
        const desc = [proyLbl(ev.proyectoId) ? 'Proyecto: ' + proyLbl(ev.proyectoId) : '',
          (Array.isArray(ev.invitados) && ev.invitados.length) ? 'Con: ' + ev.invitados.join(', ') : '',
          ev.notas || ''].filter(Boolean).join('\n');
        evento('ev' + ev.id, ev.titulo, ev.fecha, ev.horaIni, ev.horaFin, ev.todoElDia, ev.lugar, desc, ev.avisos);
      });
      // 2) Recordatorios del embudo pendientes (bitácora de los proyectos)
      const QUE = { llamar: 'Llamar al cliente', visitar: 'Visitar al cliente', mensaje: 'Mandar mensaje', correo: 'Mandar correo', cotizar: 'Cotizar', otro: 'Seguimiento' };
      (state.projects || []).forEach(pr => (pr.bitacora || []).forEach((e, i) => {
        const r = e && e.rec; if (!r || r.hecho) return;
        const gente = [r.para, r.con].concat(Array.isArray(r.invitados) ? r.invitados : []).filter(Boolean);
        if (!gente.includes(yo)) return;
        const desc = ['Proyecto: ' + [pr.numHebel, pr.nombre].filter(Boolean).join(' · '),
          pr.cliente ? 'Cliente: ' + pr.cliente : '', r.con ? 'Con: ' + r.con : '', e.texto || ''].filter(Boolean).join('\n');
        evento('rec' + pr.id + '-' + i, (QUE[r.que] || 'Seguimiento') + ' · ' + (pr.cliente || pr.nombre || ''),
          r.fecha, r.horaIni, r.horaFin, !r.horaIni, '', desc, r.avisos);
      }));
      push('END:VCALENDAR');
      const body = L.join('\r\n') + '\r\n';
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="hauscrete.ics"',
        'Cache-Control': 'no-cache'
      });
      res.end(body);
      return;
    }

    // Puerta de acceso (solo activa si ACCESO_PASS está definida — en la nube).
    if (ACCESO_PASS) {
      const auth = req.headers['authorization'] || '';
      const m = auth.match(/^Basic (.+)$/);
      let ok = false;
      if (m) { const [usr, pwd] = Buffer.from(m[1], 'base64').toString().split(':'); ok = usr === ACCESO_USER && pwd === ACCESO_PASS; }
      if (!ok) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Hauscrete"' }); res.end('Acceso restringido'); return; }
    }

    // API de storage. Los valores son STRINGS opacos (como localStorage).
    // La clave STATE_KEY se enruta a las tablas normalizadas; el resto (adjuntos) a kv.
    if (p === '/api/storage/get' && req.method === 'GET') {
      const key = u.searchParams.get('key');
      if (key === STATE_KEY) {
        const value = leerStateValue();
        return sendJSON(res, 200, value === undefined ? {} : { value });
      }
      const row = stmt.get.get(key);
      if (!row) return sendJSON(res, 200, {}); // sin value => r.value undefined => primera vez
      return sendJSON(res, 200, { value: row.value });
    }
    if (p === '/api/storage/set' && req.method === 'POST') {
      const { key, value, force } = JSON.parse(await readBody(req));
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      if (key === STATE_KEY) {
        try { guardarState(str, { force: force === true }); }
        catch (e) {
          if (e && e.esGuardarrail) return sendJSON(res, 409, { error: e.message });
          throw e;
        }
      } else {
        stmt.set.run(key, str);
      }
      return sendJSON(res, 200, { ok: true, rev: subirRev() });
    }
    if (p === '/api/storage/merge' && req.method === 'POST') {
      const delta = JSON.parse(await readBody(req));
      try { fusionarDelta(delta); }
      catch (e) {
        if (e && e.esGuardarrail) return sendJSON(res, 409, { error: e.message });
        throw e;
      }
      return sendJSON(res, 200, { ok: true, rev: subirRev() });
    }
    if (p === '/api/storage/delete' && req.method === 'POST') {
      const { key } = JSON.parse(await readBody(req));
      stmt.del.run(key);
      return sendJSON(res, 200, { ok: true, rev: subirRev() });
    }
    if (p === '/api/storage/rev' && req.method === 'GET') {
      return sendJSON(res, 200, { rev: leerRev() });
    }
    if (p === '/api/storage/list' && req.method === 'GET') {
      const keys = stmt.list.all().map((r) => r.key).filter((k) => !k.startsWith('__'));
      return sendJSON(res, 200, { keys });
    }

    /* ---- e.firma para bajar facturas del SAT ----
       RF-171: la CONSULTA al SAT corre en los dos lados. En la nube la e.firma llega
       por secretos de Fly (cifrados, invisibles para el sistema y para los respaldos);
       en la computadora, de la carpeta SAT-Hauscrete.
       La CONFIGURACIÓN (subir archivos) sigue siendo solo local: en la nube la e.firma
       se pone con `flyctl secrets set`, nunca por HTTP. */
    if (p.startsWith('/api/sat/')) {
      const host = String(req.headers.host || '');
      const esLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
      const hayCredNube = !!(process.env.SAT_CER_B64 && process.env.SAT_KEY_B64 && process.env.SAT_PASS);
      const soloLocal = ['/api/sat/guardar'];
      if (soloLocal.includes(p) && !esLocal) {
        return sendJSON(res, 403, { error: 'La e.firma solo se sube desde la computadora. En la nube se configura con secretos (flyctl secrets set).' });
      }
      if (!esLocal && !hayCredNube) {
        return sendJSON(res, 403, { error: 'En la nube todavía no está cargada la e.firma (secretos SAT_CER_B64 / SAT_KEY_B64 / SAT_PASS).' });
      }

      const DIR_SAT = path.join(os.homedir(), 'SAT-Hauscrete');
      const DIR_FIEL = path.join(DIR_SAT, 'efirma');

      if (p === '/api/sat/estado' && req.method === 'GET') {
        const SAT = await import('./sat-descarga.mjs');
        const cfg = SAT.satConfig();
        let cer = '', key = '', dias = cfg ? cfg.dias : 30;
        if (cfg && cfg.origen === 'local') {
          try {
            const c = JSON.parse(fs.readFileSync(path.join(DIR_SAT, 'config.json'), 'utf8'));
            cer = path.basename(c.cer || ''); key = path.basename(c.key || '');
          } catch {}
        }
        let ultima = null, pendientes = [];
        try {
          const est = JSON.parse((stmt.get.get(SAT.KEY_ESTADO)||{}).value || '{}');
          ultima = { ultimoHasta: est.ultimoHasta || null, solicitudes: (est.solicitudes || []).length };
          pendientes = (est.solicitudes || []).map((s) => ({ id: s.id, desde: s.desde, hasta: s.hasta, creada: s.creada }));
        } catch {}
        let revisadoEn = 0;
        try { revisadoEn = Number((stmt.get.get(KEY_SAT_ULTIMA) || {}).value) || 0; } catch {}
        return sendJSON(res, 200, {
          carpeta: DIR_SAT, configurado: !!cfg, origen: cfg ? cfg.origen : null,
          cer, key, dias, ultima, puedeSubir: esLocal,
          pendientes, revisadoEn, intervaloMin: SAT_CADA_MS / 60000,
        });
      }

      if (p === '/api/sat/guardar' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req));
        if (!b.password) return sendJSON(res, 400, { error: 'Falta la contraseña de la llave privada.' });
        fs.mkdirSync(DIR_FIEL, { recursive: true });
        // Los archivos llegan en base64 desde el navegador
        const guardarArchivo = (b64, nombre) => {
          if (!b64) return null;
          const destino = path.join(DIR_FIEL, nombre);
          fs.writeFileSync(destino, Buffer.from(b64, 'base64'));
          return destino;
        };
        const cfgPath = path.join(DIR_SAT, 'config.json');
        const previo = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
        const cer = guardarArchivo(b.cerB64, b.cerNombre || 'efirma.cer') || previo.cer;
        const key = guardarArchivo(b.keyB64, b.keyNombre || 'efirma.key') || previo.key;
        if (!cer || !key) return sendJSON(res, 400, { error: 'Faltan los archivos .cer y .key.' });
        const cfg = {
          cer, key, password: b.password,
          diasAtras: Number(b.dias) || 30,
          crm: { url: b.crmUrl || 'https://hauscrete-crm.fly.dev', usuario: b.crmUsuario || 'hauscrete', password: b.crmPassword || '' },
        };
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        return sendJSON(res, 200, { ok: true, carpeta: DIR_SAT, cer: path.basename(cer), key: path.basename(key) });
      }

      if (p === '/api/sat/probar' && req.method === 'POST') {
        try {
          const SAT = await import('./sat-descarga.mjs');
          return sendJSON(res, 200, await SAT.satProbar());
        } catch (e) {
          return sendJSON(res, 200, { ok: false, mensaje: 'No se pudo leer la e.firma: ' + (e && e.message || e) + ' — ¿son los archivos de la e.firma (no del CSD) y la contraseña de la llave privada?' });
        }
      }
      /* RF-171: consulta al SAT desde el propio servidor (nube o computadora) y deja
         las facturas nuevas en la bandeja del sistema. El estado de las solicitudes
         se guarda en la base, así sobrevive a los reinicios de la nube. */
      if (p === '/api/sat/descargar' && req.method === 'POST') {
        const SAT = await import('./sat-descarga.mjs');
        if (!SAT.satConfigurado()) return sendJSON(res, 400, { error: 'Todavía no está configurada la e.firma.' });
        let desdeMinimo = null;   // RF-628: para llenar el concepto de lo que ya está en la bandeja
        try { const raw0 = leerStateValue(); desdeMinimo = SAT.satDesdeSinConcepto(raw0 ? JSON.parse(raw0) : {}); } catch {}
        const r = await SAT.satDescargar({
          leerEstado: async () => { try { return JSON.parse((stmt.get.get(SAT.KEY_ESTADO)||{}).value || '{}'); } catch { return {}; } },
          guardarEstado: async (est) => { stmt.set.run(SAT.KEY_ESTADO, JSON.stringify(est)); },
          desdeMinimo,
        });
        let agregadas = 0;
        if (r.ok && r.items.length) {
          const raw = leerStateValue();
          const state = raw ? JSON.parse(raw) : {};
          const completadas = SAT.satCompletarBandeja(r.items, state);   // RF-628
          const nuevos = SAT.satNuevosParaBandeja(r.items, state);
          if (nuevos.length || completadas) {
            state.satBandeja = (state.satBandeja || []).concat(nuevos);
            guardarState(JSON.stringify(state));
            subirRev();
            agregadas = nuevos.length;
            if (nuevos.length) r.log.push(`${nuevos.length} factura(s) nueva(s) en la bandeja.`);
            if (completadas) r.log.push(`${completadas} factura(s) de la bandeja con su concepto.`);
          } else r.log.push('Sin comprobantes nuevos (ya estaban registrados).');
        }
        return sendJSON(res, 200, { ok: true, salida: r.log.join('\n'), agregadas });
      }
      return sendJSON(res, 404, { error: 'Ruta del SAT no reconocida.' });
    }

    /* ---- Avisos por Telegram (RF-202) ----
       El token del bot va como secreto de Fly (TELEGRAM_BOT_TOKEN). La vinculación y
       el envío se piden desde el sistema; el disparo diario lo hace la tarea de la PC. */
    if (p.startsWith('/api/telegram/')) {
      const TG = await import('./telegram.mjs');
      const leerEstadoTG = async () => { try { return JSON.parse((stmt.get.get(TG.KEY_ESTADO) || {}).value || '{}'); } catch { return {}; } };
      const guardarEstadoTG = async (est) => { stmt.set.run(TG.KEY_ESTADO, JSON.stringify(est)); };

      if (p === '/api/telegram/estado' && req.method === 'GET') {
        const state = JSON.parse(leerStateValue() || '{}');
        const vinculados = (state.asesores || []).filter((a) => a.tg && a.tg.chatId)
          .map((a) => ({ nombre: ((a.nombre || '') + ' ' + (a.apellidos || '')).trim(), user: a.tg.user || '', desde: a.tg.vinculadoEn || '' }));
        let bot = '';
        if (TG.tgConfigurado()) { try { bot = (await TG.tgGetMe()).username || ''; } catch { /* token malo */ } }
        return sendJSON(res, 200, { configurado: TG.tgConfigurado(), bot, vinculados });
      }
      if (p === '/api/telegram/vincular' && req.method === 'POST') {
        if (!TG.tgConfigurado()) return sendJSON(res, 400, { error: 'El bot de Telegram todavía no está configurado (falta el token).' });
        const { asesor } = JSON.parse(await readBody(req));
        const state = JSON.parse(leerStateValue() || '{}');
        try {
          const r = await TG.tgGenerarCodigo(state, asesor);
          guardarState(JSON.stringify(state)); subirRev();
          return sendJSON(res, 200, { ok: true, ...r });
        } catch (e) { return sendJSON(res, 400, { error: String(e && e.message || e) }); }
      }
      if (p === '/api/telegram/enviar' && req.method === 'POST') {
        if (!TG.tgConfigurado()) return sendJSON(res, 400, { error: 'El bot de Telegram todavía no está configurado.' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const state = JSON.parse(leerStateValue() || '{}');
        try {
          const r = await TG.tgEnviarRecordatorios({ state, leerEstado: leerEstadoTG, guardarEstado: guardarEstadoTG, soloNombre: body.asesor || '' });
          // RF-204: el mismo disparo (tarea diaria / botón) también saca los avisos de eventos que ya tocaban
          const rAv = await TG.tgEnviarAvisosEventos({ state, leerEstado: leerEstadoTG, guardarEstado: guardarEstadoTG });
          return sendJSON(res, 200, { ok: true, ...r, avisosEventos: rAv.avisados });
        } catch (e) { return sendJSON(res, 400, { error: String(e && e.message || e) }); }
      }
      // RF-204: notificación directa al crear un evento o recordatorio (la manda el
      // sistema con la sesión ya autenticada; los nombres se resuelven a chats aquí)
      if (p === '/api/telegram/notificar' && req.method === 'POST') {
        if (!TG.tgConfigurado()) return sendJSON(res, 400, { error: 'El bot de Telegram todavía no está configurado.' });
        const { destinatarios, texto } = JSON.parse((await readBody(req)) || '{}');
        if (!Array.isArray(destinatarios) || !destinatarios.length || !texto) {
          return sendJSON(res, 400, { error: 'Faltan destinatarios o texto.' });
        }
        const state = JSON.parse(leerStateValue() || '{}');
        try {
          const r = await TG.tgNotificarPersonas(state, destinatarios, String(texto).slice(0, 3500));
          return sendJSON(res, 200, { ok: true, ...r });
        } catch (e) { return sendJSON(res, 400, { error: String(e && e.message || e) }); }
      }
      if (p === '/api/telegram/instalar-webhook' && req.method === 'POST') {
        if (!TG.tgConfigurado()) return sendJSON(res, 400, { error: 'Falta el token del bot.' });
        const host = String(req.headers.host || '');
        const url = 'https://' + host + '/api/telegram/webhook';
        try {
          await TG.tgInstalarWebhook(url, TG.tgWebhookSecret());
          return sendJSON(res, 200, { ok: true, url });
        } catch (e) { return sendJSON(res, 400, { error: String(e && e.message || e) }); }
      }
      return sendJSON(res, 404, { error: 'Ruta de Telegram no reconocida.' });
    }

    /* ---- RF-572: clave del calendario suscribible, guardada en el servidor ----
       {usuario}                → devuelve la clave activa (o adopta la de la ficha, o crea una)
       {usuario, nuevo:true}    → revoca las anteriores y crea una nueva
       {usuario, token:"…"}     → adopta una clave ya existente (p. ej. la que un teléfono
                                  ya tiene suscrita) para que vuelva a funcionar */
    if (p === '/api/cal/token' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch { b = {}; }
      const usuario = String(b.usuario || '').trim();
      if (!usuario) return sendJSON(res, 400, { error: 'Falta el usuario.' });
      if (b.token) {
        const t = String(b.token).trim();
        if (!/^[A-Za-z0-9]{16,64}$/.test(t)) return sendJSON(res, 400, { error: 'Clave inválida.' });
        calStmt.poner.run(t, usuario);
        return sendJSON(res, 200, { ok: true, token: t, adoptada: true });
      }
      if (b.nuevo) calStmt.revocar.run(usuario);
      let row = b.nuevo ? null : calStmt.porUsuario.get(usuario);
      if (!row && !b.nuevo) {
        // la ficha del state todavía trae clave → se adopta para NO romper suscripciones vivas
        let state = {}; try { state = JSON.parse(leerStateValue() || '{}'); } catch { state = {}; }
        const f = (state.asesores || []).find(a => a && nombreFicha(a) === usuario);
        if (f && f.calToken && /^[A-Za-z0-9]{16,64}$/.test(f.calToken)) { calStmt.poner.run(f.calToken, usuario); row = { token: f.calToken }; }
      }
      if (!row) { const t = calNuevoToken(); calStmt.poner.run(t, usuario); row = { token: t }; }
      return sendJSON(res, 200, { ok: true, token: row.token });
    }

    /* ---- RF-209: reporte administrativo diario (previa + envío manual) ---- */
    if (p === '/api/reporte-admin/previa' && req.method === 'GET') {
      const REP = await import('./reporte-admin.mjs');
      const state = JSON.parse(leerStateValue() || '{}');
      const texto = REP.repAdminTexto(state, 'Hauscrete');
      const destinatarios = (state.asesores || []).filter((a) => a.tgInfoAdmin && a.tg && a.tg.chatId)
        .map((a) => ((a.nombre || '') + ' ' + (a.apellidos || '')).trim());
      return sendJSON(res, 200, { ok: true, texto, cfg: REP.repCfg(state), campos: REP.REP_CAMPOS, destinatarios });
    }
    if (p === '/api/reporte-admin/enviar' && req.method === 'POST') {
      const TG = await import('./telegram.mjs');
      if (!TG.tgConfigurado()) return sendJSON(res, 400, { error: 'El bot de Telegram no está configurado.' });
      const REP = await import('./reporte-admin.mjs');
      const state = JSON.parse(leerStateValue() || '{}');
      // ?auto=1 (la tarea de la PC de las 6 PM): respeta la hora y el "ya se mandó hoy";
      // sin auto (el botón de prueba de Ajustes): manda siempre.
      const esAuto = u.searchParams.get('auto') === '1';
      if (esAuto) {
        const row = stmt.get.get('__repadmin');
        if (!REP.repAdminToca(state, row ? row.value : '')) return sendJSON(res, 200, { ok: true, omitido: true });
      }
      const r = await enviarReporteAdmin(state, TG, REP);
      stmt.set.run('__repadmin', REP.repAhoraLocal().toISOString().slice(0, 10));
      return sendJSON(res, 200, { ok: true, ...r });
    }
    // RF-259: mensaje MATUTINO de depósitos programados
    if (p === '/api/reporte-depositos/previa' && req.method === 'GET') {
      const REP = await import('./reporte-admin.mjs');
      const state = JSON.parse(leerStateValue() || '{}');
      const texto = REP.repDepositosTexto(state, 'Hauscrete') || '(hoy no hay depósitos programados)';
      const destinatarios = (state.asesores || []).filter((a) => a.tgInfoAdmin && a.tg && a.tg.chatId)
        .map((a) => ((a.nombre || '') + ' ' + (a.apellidos || '')).trim());
      return sendJSON(res, 200, { ok: true, texto, hora: REP.repDepositosHora(state), destinatarios });
    }
    if (p === '/api/reporte-depositos/enviar' && req.method === 'POST') {
      const TG = await import('./telegram.mjs');
      if (!TG.tgConfigurado()) return sendJSON(res, 400, { error: 'El bot de Telegram no está configurado.' });
      const REP = await import('./reporte-admin.mjs');
      const state = JSON.parse(leerStateValue() || '{}');
      const esAuto = u.searchParams.get('auto') === '1';
      if (esAuto) {
        const row = stmt.get.get('__repdepositos');
        if (!REP.repDepositosToca(state, row ? row.value : '')) return sendJSON(res, 200, { ok: true, omitido: true });
      }
      const r = await enviarReporteDepositos(state, TG, REP);
      if (esAuto) stmt.set.run('__repdepositos', REP.repAhoraLocal().toISOString().slice(0, 10));
      return sendJSON(res, 200, { ok: true, ...r });
    }

    // --- Timbrado con el PAC (Facturapi) ---
    if (p === '/api/pac/estado' && req.method === 'GET') {
      return sendJSON(res, 200, { configurado: !!FACTURAPI_KEY, prueba: pacEsPrueba() });
    }
    if (p === '/api/pac/timbrar' && req.method === 'POST') {
      if (!FACTURAPI_KEY) return sendJSON(res, 200, { ok: false, error: 'El PAC no está configurado (falta el secreto FACTURAPI_KEY).' });
      const factura = JSON.parse(await readBody(req));
      // 1) Crear y timbrar la factura
      const cre = await pacFetch('/invoices', { method: 'POST', body: JSON.stringify(factura) });
      let datos = null;
      try { datos = JSON.parse(cre.texto); } catch (e) { /* respuesta no-JSON */ }
      if (!cre.ok) {
        const msg = (datos && (datos.message || datos.error)) || cre.texto || 'Error al timbrar';
        return sendJSON(res, 200, { ok: false, error: msg, detalle: datos });
      }
      // 2) Descargar el XML timbrado (es lo que el sistema guarda y manda al cliente)
      const xml = await pacFetch('/invoices/' + datos.id + '/xml', { method: 'GET' });
      return sendJSON(res, 200, {
        ok: true, prueba: pacEsPrueba(), id: datos.id, uuid: datos.uuid,
        serie: datos.series || '', folio: datos.folio_number,
        xml: xml.ok ? xml.texto : '', xmlError: xml.ok ? '' : xml.texto,
      });
    }
    /* Complemento de Pago (REP): cuando una factura es PPD, el SAT exige emitir un
       CFDI de tipo "P" por cada pago recibido, a más tardar el día 5 del mes
       siguiente. El cuerpo llega armado desde el navegador. */
    if (p === '/api/pac/complemento' && req.method === 'POST') {
      if (!FACTURAPI_KEY) return sendJSON(res, 200, { ok: false, error: 'El PAC no está configurado.' });
      const cuerpo = JSON.parse(await readBody(req));
      const cre = await pacFetch('/invoices', { method: 'POST', body: JSON.stringify(cuerpo) });
      let datos = null; try { datos = JSON.parse(cre.texto); } catch (e) {}
      if (!cre.ok) return sendJSON(res, 200, { ok: false, error: (datos && (datos.message || datos.error)) || cre.texto });
      const xml = await pacFetch('/invoices/' + datos.id + '/xml', { method: 'GET' });
      return sendJSON(res, 200, {
        ok: true, prueba: pacEsPrueba(), id: datos.id, uuid: datos.uuid,
        serie: datos.series || '', folio: datos.folio_number, xml: xml.ok ? xml.texto : '',
      });
    }
    /* PDF de un comprobante timbrado por el PAC. Lo genera Facturapi (para los
       complementos de pago trae el desglose oficial: parcialidad, saldos, etc.),
       y aquí se entrega como descarga. */
    /* RF-415: XML del CFDI timbrado, directo del PAC (mismo esquema que el PDF) */
    if (p === '/api/pac/xml' && req.method === 'GET') {
      if (!FACTURAPI_KEY) { res.writeHead(400); return res.end('El PAC no está configurado.'); }
      const id = u.searchParams.get('id') || '';
      if (!/^[A-Za-z0-9]+$/.test(id)) { res.writeHead(400); return res.end('id inválido'); }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 45000);
      try {
        const r = await fetch(FACTURAPI_URL + '/invoices/' + id + '/xml', {
          headers: { Authorization: 'Bearer ' + FACTURAPI_KEY }, signal: ctrl.signal,
        });
        if (!r.ok) { res.writeHead(502); return res.end('El PAC no entregó el XML (' + r.status + ')'); }
        const buf = Buffer.from(await r.arrayBuffer());
        const nom = (u.searchParams.get('nombre') || 'comprobante.xml').replace(/[\/:*?"<>|\r\n]+/g, '').slice(0, 140);
        res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Disposition': 'attachment; filename="' + nom + '"' });
        return res.end(buf);
      } finally { clearTimeout(t); }
    }
    if (p === '/api/pac/pdf' && req.method === 'GET') {
      if (!FACTURAPI_KEY) { res.writeHead(400); return res.end('El PAC no está configurado.'); }
      const id = u.searchParams.get('id') || '';
      if (!/^[A-Za-z0-9]+$/.test(id)) { res.writeHead(400); return res.end('id inválido'); }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 45000);
      try {
        const r = await fetch(FACTURAPI_URL + '/invoices/' + id + '/pdf', {
          headers: { Authorization: 'Bearer ' + FACTURAPI_KEY }, signal: ctrl.signal,
        });
        if (!r.ok) { res.writeHead(502); return res.end('El PAC no entregó el PDF (' + r.status + ')'); }
        const buf = Buffer.from(await r.arrayBuffer());
        const nom = (u.searchParams.get('nombre') || 'comprobante.pdf').replace(/[\\/:*?"<>|\r\n]+/g, '').slice(0, 140);
        // Con inline=1 el PDF se MUESTRA en el visor (preliminar); sin él, se descarga
        const disp = u.searchParams.get('inline') ? 'inline' : 'attachment';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': disp + '; filename="' + nom + '"',
          'Content-Length': buf.length, 'Cache-Control': 'no-store',
        });
        return res.end(buf);
      } catch (e) {
        res.writeHead(502); return res.end('No se pudo bajar el PDF: ' + (e && e.message || e));
      } finally { clearTimeout(t); }
    }
    if (p === '/api/pac/cancelar' && req.method === 'POST') {
      if (!FACTURAPI_KEY) return sendJSON(res, 200, { ok: false, error: 'El PAC no está configurado.' });
      const { id, motivo, sustituye } = JSON.parse(await readBody(req));
      const qs = '?motive=' + encodeURIComponent(motivo || '02') + (sustituye ? '&substitution=' + encodeURIComponent(sustituye) : '');
      const r = await pacFetch('/invoices/' + id + qs, { method: 'DELETE' });
      let datos = null; try { datos = JSON.parse(r.texto); } catch (e) {}
      return r.ok
        ? sendJSON(res, 200, { ok: true, estatus: datos && datos.status })
        : sendJSON(res, 200, { ok: false, error: (datos && (datos.message || datos.error)) || r.texto });
    }

    // HTML principal
    if (p === '/' || p === '/index.html' || p === '/' + HTML_FILE) {
      return serveHTML(res);
    }

    // RF-272: app móvil de ENTREGAS (PWA) — remisión digital con firma en pantalla
    // RF-334: la app se llama "Móvil" y vive en /movil; /entregas (la liga vieja, la que
    // ya tienen instalada los teléfonos) redirige para que nadie se quede fuera.
    if (p === '/entregas') { res.writeHead(302, { Location: '/movil' }); return res.end(); }
    if (p === '/movil') {
      // RF-287: sin caché — el celular recibe SIEMPRE la versión recién desplegada
      // (sin esto, la app se quedaba con la copia guardada en el teléfono).
      try {
        const buf = await readFile(path.join(__dirname, 'entregas.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store, must-revalidate' });
        res.end(buf);
      } catch { res.writeHead(404); res.end('No encontrado'); }
      return;
    }

    // Archivos estáticos (logos externos, etc.)
    return serveStatic(res, p);
  } catch (err) {
    console.error('Error:', err);
    sendJSON(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Hauscrete CRM  ·  puerto ${PORT}`);
  console.log(`  Base:   ${DB_FILE}`);
  console.log(`  HTML:   ${HTML_FILE}`);
  console.log(`  Acceso: ${ACCESO_PASS ? 'con contraseña (Basic Auth)' : 'abierto (local)'}`);
  console.log(`  Local:  http://localhost:${PORT}\n`);
});

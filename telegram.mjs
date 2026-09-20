/* ================== Avisos por Telegram (RF-202) ==================
   Bot de Telegram para avisar a cada persona SUS recordatorios (vencidos y de hoy).
   - El TOKEN del bot vive como secreto de Fly (TELEGRAM_BOT_TOKEN), nunca en la base
     ni en los respaldos —igual que la e.firma del SAT.
   - Cada usuario se vincula una vez: abre el bot con un código; el webhook captura su
     chat_id y lo guarda en su ficha de asesor (state.asesores[i].tg).
   - El envío corre por un endpoint que dispara la tarea diaria de la PC (la máquina de
     Fly se apaga cuando nadie la usa, así que no puede haber temporizadores propios).
   Módulo SIN estado propio: recibe el `state` y funciones para leer/guardar. */

const API = 'https://api.telegram.org/bot';
export const KEY_ESTADO = '__tg_estado';   // kv: control de duplicados de envío

export function tgConfigurado() { return !!process.env.TELEGRAM_BOT_TOKEN; }
const _token = () => process.env.TELEGRAM_BOT_TOKEN || '';
export const tgWebhookSecret = () => process.env.TELEGRAM_WEBHOOK_SECRET || '';

// Llamada cruda a la API del bot
async function tgApi(method, payload) {
  const token = _token();
  if (!token) throw new Error('Falta el token del bot (TELEGRAM_BOT_TOKEN).');
  const r = await fetch(API + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j || !j.ok) throw new Error('Telegram: ' + ((j && j.description) || ('HTTP ' + r.status)));
  return j.result;
}

export const tgEnviar = (chatId, texto) =>
  tgApi('sendMessage', { chat_id: chatId, text: texto, parse_mode: 'HTML', disable_web_page_preview: true });

export const tgGetMe = () => tgApi('getMe', {});

// Registra la URL del webhook en Telegram (una sola vez / al cambiar dominio)
export const tgInstalarWebhook = (url, secret) =>
  tgApi('setWebhook', { url, secret_token: secret || undefined, allowed_updates: ['message'] });

// ---- Datos de asesores / vinculación ----
const nombreCompleto = (a) => ((a.nombre || '') + ' ' + (a.apellidos || '')).trim();

// Genera un código de vinculación para un asesor (por su nombre completo) y lo guarda
// en su ficha. Devuelve {code, botUser} para armar el enlace t.me/<botUser>?start=<code>.
export async function tgGenerarCodigo(state, nombre) {
  const a = (state.asesores || []).find((x) => nombreCompleto(x) === nombre);
  if (!a) throw new Error('No encontré al asesor "' + nombre + '".');
  const code = 'H' + Math.random().toString(36).slice(2, 8).toUpperCase();
  a.tgCode = code;
  let botUser = '';
  try { botUser = (await tgGetMe()).username || ''; } catch { /* sin token aún */ }
  return { code, botUser };
}

// Procesa un "update" entrante del webhook. Si es "/start <code>", vincula el chat con
// el asesor dueño de ese código. Devuelve {cambio, nombre, chatId} y responde al usuario.
export async function tgProcesarUpdate(update, state) {
  const msg = update && update.message;
  const text = String((msg && msg.text) || '').trim();
  const chat = msg && msg.chat;
  if (!chat) return { cambio: false };
  const chatId = chat.id;
  const mStart = text.match(/^\/start\s+([A-Za-z0-9]+)/);
  if (mStart) {
    const code = mStart[1].toUpperCase();
    const a = (state.asesores || []).find((x) => String(x.tgCode || '').toUpperCase() === code);
    if (a) {
      a.tg = {
        chatId,
        user: (msg.from && msg.from.username) || '',
        nombre: [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' '),
        vinculadoEn: new Date().toISOString().slice(0, 19).replace('T', ' '),
      };
      delete a.tgCode;
      try {
        await tgEnviar(chatId, '✅ <b>Listo, ' + (nombreCompleto(a) || 'tu cuenta') +
          '</b>.\nTu Telegram quedó vinculado a Hauscrete CRM. Aquí te llegarán tus recordatorios pendientes.');
      } catch { /* el link ya quedó guardado aunque falle el aviso */ }
      return { cambio: true, nombre: nombreCompleto(a), chatId };
    }
    try { await tgEnviar(chatId, '❌ Ese código de vinculación no es válido o ya se usó. Pídelo de nuevo en el sistema (Ajustes → Datos empresa → Telegram).'); } catch {}
    return { cambio: false, chatId };
  }
  // Cualquier otro mensaje: ayuda breve
  try {
    await tgEnviar(chatId, 'Hola 👋 Soy el bot de <b>Hauscrete CRM</b>.\nPara vincular tu cuenta, entra al sistema → <b>Ajustes → Datos empresa → Telegram</b> y usa el botón "Vincular mi Telegram".');
  } catch {}
  return { cambio: false, chatId };
}

// ---- Recordatorios pendientes por persona (vencidos y de hoy) ----
const REC_ACT = { llamar: 'Llamar al cliente', cotizacion: 'Mandar cotización', correo: 'Mandar correo', visita: 'Visitar al cliente', junta: 'Junta', cobrar: 'Cobrar', otro: 'Otro' };
const hoyISO = () => new Date().toISOString().slice(0, 10);
const fmtD = (s) => { const [y, m, d] = String(s || '').slice(0, 10).split('-'); return d ? `${d}/${m}/${y}` : ''; };

// Devuelve { "<nombre>": [ {que, fecha, estado, proyecto, key} ] } solo con vencidos/hoy
export function tgRecordatoriosPorPersona(state) {
  const h = hoyISO();
  const out = {};
  (state.projects || []).forEach((p) => {
    (p.bitacora || []).forEach((e, i) => {
      const rec = e && e.rec;
      if (!rec || rec.hecho || !rec.fecha) return;
      const f = String(rec.fecha).slice(0, 10);
      const estado = f < h ? 'vencido' : (f === h ? 'hoy' : null);
      if (!estado) return;   // solo lo urgente
      const para = rec.para || '';
      (out[para] = out[para] || []).push({
        que: REC_ACT[rec.que] || 'Pendiente', fecha: f, estado,
        proyecto: [(p.numHebel || ''), (p.nombre || '')].filter(Boolean).join(' · '),
        key: p.id + '|' + i + '|' + f,
      });
    });
  });
  return out;
}

/* ---- RF-204: notificación directa a una lista de personas (por nombre) ----
   Se usa al CREAR un evento o recordatorio: el sistema manda el texto a cada
   involucrado que tenga su Telegram vinculado; los no vinculados solo se reportan. */
export async function tgNotificarPersonas(state, nombres, texto) {
  if (!tgConfigurado()) return { enviados: [], sinTelegram: nombres || [] };
  const enviados = [], sinTelegram = [];
  const vistos = new Set();
  for (const n of (nombres || [])) {
    const nombre = String(n || '').trim();
    if (!nombre || vistos.has(nombre)) continue;
    vistos.add(nombre);
    const a = (state.asesores || []).find((x) => nombreCompleto(x) === nombre);
    if (!a || !a.tg || !a.tg.chatId) { sinTelegram.push(nombre); continue; }
    try { await tgEnviar(a.tg.chatId, texto); enviados.push(nombre); }
    catch (e) { sinTelegram.push(nombre + ' (' + ((e && e.message) || e) + ')'); }
  }
  return { enviados, sinTelegram };
}

/* ---- RF-204: avisos programados de EVENTOS del calendario ----
   Cada evento trae `avisos` (minutos antes: 0, 5, 15, 30, 60, 120, 720, 1440, 10080).
   Este chequeo corre cada minuto mientras la máquina está despierta (y con cada
   tráfico): manda el aviso cuando su hora ya llegó, sin duplicar (kv __tg_estado).
   Si la máquina dormía, el aviso sale al despertar — pero si el evento ya pasó
   hace más de 6 horas, se descarta para no molestar con avisos rancios.
   Las horas del sistema son de Hermosillo (UTC-7 fijo, Sonora no tiene horario
   de verano); se puede ajustar con el secreto TELEGRAM_TZ_MIN. */
const TZ_MIN = Number(process.env.TELEGRAM_TZ_MIN ?? -420);
const _ahoraLocal = () => new Date(Date.now() + TZ_MIN * 60000);   // reloj local leído en campos UTC
const AVISO_LBL = (min) => min === 0 ? 'ya es hora' : min < 60 ? `en ${min} min` :
  min < 1440 ? `en ${Math.round(min / 60)} hora(s)` : min === 1440 ? 'mañana' : `en ${Math.round(min / 1440)} día(s)`;

export async function tgEnviarAvisosEventos({ state, leerEstado, guardarEstado }) {
  if (!tgConfigurado()) return { avisados: 0 };
  const est = (await leerEstado()) || {};
  est.avisos = est.avisos || {};
  const ahora = _ahoraLocal();
  let avisados = 0, cambio = false;
  for (const ev of (state.eventos || [])) {
    if (!ev || !ev.fecha || !Array.isArray(ev.avisos) || !ev.avisos.length) continue;
    const hhmm = (ev.todoElDia || !ev.horaIni) ? '08:00' : ev.horaIni;   // todo el día: referencia 8 AM
    const ini = new Date(ev.fecha + 'T' + hhmm + ':00Z');                // en el "reloj local"
    if (isNaN(ini)) continue;
    for (const min of ev.avisos) {
      const clave = ev.id + '|' + min;
      if (est.avisos[clave]) continue;
      const cuando = new Date(ini.getTime() - Number(min) * 60000);
      if (ahora < cuando) continue;                                       // todavía no toca
      cambio = true;
      if (ahora.getTime() - ini.getTime() > 6 * 3600000) { est.avisos[clave] = 'vencido-sin-avisar'; continue; }
      const hora = ev.todoElDia ? 'todo el día' : (ev.horaIni + (ev.horaFin ? '–' + ev.horaFin : ''));
      const eh = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const texto = `🔔 <b>${eh(ev.titulo) || 'Evento'}</b> — ${AVISO_LBL(Number(min))}\n` +
        `🗓 ${fmtD(ev.fecha)} · ${hora}` + (ev.lugar ? `\n📍 ${eh(ev.lugar)}` : '') +
        (ev.notas ? `\n📝 ${eh(ev.notas)}` : '');
      const r = await tgNotificarPersonas(state, [ev.para, ...(ev.invitados || [])], texto);
      est.avisos[clave] = new Date().toISOString().slice(0, 19);
      avisados += r.enviados.length;
    }
  }
  // Limpieza: fuera claves de eventos que ya no existen o de hace más de 30 días
  const vivos = new Set((state.eventos || []).map((e) => String(e.id)));
  for (const k of Object.keys(est.avisos)) {
    if (!vivos.has(k.split('|')[0])) { delete est.avisos[k]; cambio = true; }
  }
  if (cambio) await guardarEstado(est);
  return { avisados };
}

// Envía a cada asesor VINCULADO sus recordatorios urgentes que aún no se le hayan
// mandado hoy. `leerEstado`/`guardarEstado` manejan el control de duplicados (kv).
export async function tgEnviarRecordatorios({ state, leerEstado, guardarEstado, soloNombre }) {
  if (!tgConfigurado()) throw new Error('El bot de Telegram no está configurado (falta el token).');
  const est = (await leerEstado()) || {};
  est.enviados = est.enviados || {};
  const hoy = hoyISO();
  const porPersona = tgRecordatoriosPorPersona(state);
  const resumen = [];
  for (const a of (state.asesores || [])) {
    const nombre = nombreCompleto(a);
    if (soloNombre && nombre !== soloNombre) continue;
    if (!a.tg || !a.tg.chatId) continue;                 // no vinculado
    const items = (porPersona[nombre] || []).filter((it) => est.enviados[it.key] !== hoy);
    if (!items.length) continue;
    const venc = items.filter((it) => it.estado === 'vencido').length;
    const hoyN = items.length - venc;
    const lineas = items
      .sort((x, y) => (x.estado === y.estado ? 0 : x.estado === 'vencido' ? -1 : 1))
      .map((it) => `${it.estado === 'vencido' ? '🔴' : '🟠'} <b>${it.que}</b> — ${it.proyecto} <i>(${it.estado === 'vencido' ? 'vencido ' + fmtD(it.fecha) : 'hoy'})</i>`);
    const encabezado = '⏰ <b>Recordatorios Hauscrete</b>\n' +
      (venc ? `${venc} vencido${venc > 1 ? 's' : ''}` : '') + (venc && hoyN ? ' y ' : '') + (hoyN ? `${hoyN} para hoy` : '') + ':\n';
    try {
      await tgEnviar(a.tg.chatId, encabezado + lineas.join('\n'));
      items.forEach((it) => { est.enviados[it.key] = hoy; });
      resumen.push({ nombre, enviados: items.length });
    } catch (e) {
      resumen.push({ nombre, error: (e && e.message) || String(e) });
    }
  }
  // Limpieza: conservar solo lo marcado HOY (los de días viejos ya no importan)
  const limpio = {};
  for (const [k, v] of Object.entries(est.enviados)) if (v === hoy) limpio[k] = v;
  est.enviados = limpio;
  await guardarEstado(est);
  return { resumen, hoy };
}

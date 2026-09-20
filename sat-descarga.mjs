/* ============================================================================
   Descarga de CFDI RECIBIDOS del SAT  →  Bandeja del CRM
   ============================================================================
   Corre igual en los dos lados:
     · EN LA NUBE  : la e.firma llega por variables de entorno (secretos de Fly).
                     Los secretos están cifrados, no se ven en el sistema ni en los
                     respaldos, y solo los lee este proceso.
     · EN LA COMPU : si no hay secretos, usa la carpeta SAT-Hauscrete del usuario.

   El SAT trabaja por solicitudes y tarda de minutos a horas: si el paquete aún no
   está listo se guarda el folio de la solicitud y la siguiente corrida lo retoma.
   El estado se guarda en la propia base (clave __sat_estado), así sobrevive a los
   reinicios de la nube.
   ============================================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_ESTADO = '__sat_estado';

/* ---------- Configuración: secretos de la nube o archivos locales ---------- */
export function satConfig() {
  const env = process.env;
  if (env.SAT_CER_B64 && env.SAT_KEY_B64 && env.SAT_PASS) {
    return {
      origen: 'nube',
      cer: Buffer.from(env.SAT_CER_B64, 'base64'),
      key: Buffer.from(env.SAT_KEY_B64, 'base64'),
      password: env.SAT_PASS,
      dias: Number(env.SAT_DIAS || 30),
    };
  }
  const dir = path.join(os.homedir(), 'SAT-Hauscrete');
  const cfgPath = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return {
      origen: 'local',
      cer: fs.readFileSync(c.cer),
      key: fs.readFileSync(c.key),
      password: c.password,
      dias: Number(c.diasAtras || 30),
      dirPaquetes: path.join(dir, 'paquetes'),
    };
  } catch { return null; }
}

export function satConfigurado() { return !!satConfig(); }

/* ---------- Validar la e.firma (para el botón "Probar e.firma") ---------- */
export async function satProbar() {
  const cfg = satConfig();
  if (!cfg) return { ok: false, mensaje: 'Todavía no se ha configurado la e.firma.' };
  try {
    const { Fiel } = await import('@nodecfdi/sat-ws-descarga-masiva');
    const fiel = Fiel.create(cfg.cer.toString('binary'), cfg.key.toString('binary'), cfg.password);
    if (!fiel.isValid()) return { ok: false, mensaje: 'La e.firma no es válida: revisa que el .cer y el .key sean el par correcto, que la contraseña sea la de la LLAVE PRIVADA y que el certificado no esté vencido.' };
    const dato = (fn) => { try { return String(fn() || ''); } catch { return ''; } };
    return { ok: true, origen: cfg.origen, rfc: dato(() => fiel.getRfc()), serie: dato(() => fiel.getCertificateSerial()) };
  } catch (e) {
    return { ok: false, mensaje: 'No se pudo leer la e.firma: ' + (e && e.message || e) + ' — ¿son los archivos de la e.firma (no del CSD) y la contraseña de la llave privada?' };
  }
}

/* ---------- Descarga: crea/retoma la solicitud y devuelve los comprobantes ----------
   leerEstado/guardarEstado los inyecta el servidor (se guardan en la base).      */
/* ---------- RF-628: datos de un CFDI a partir de su XML ----------
   Antes se pedía al SAT solo la "metadata" (emisor, fecha, monto, UUID), que NO trae
   los conceptos. Ahora se piden los XML completos y de aquí sale todo, más el
   CONCEPTO de la factura para la Bandeja del SAT. */
const _xmlTxt = (s) => String(s || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const _xmlAttr = (tag, nombre) => { const m = new RegExp('\\s' + nombre + '\\s*=\\s*"([^"]*)"').exec(tag || ''); return m ? _xmlTxt(m[1]) : ''; };
const _xmlTag = (xml, nombre) => { const m = new RegExp('<(?:\\w+:)?' + nombre + '\\b[^>]*>').exec(xml || ''); return m ? m[0] : ''; };
export function satDatosCfdi(xml) {
  const comp = _xmlTag(xml, 'Comprobante'), emisor = _xmlTag(xml, 'Emisor'), timbre = _xmlTag(xml, 'TimbreFiscalDigital');
  const conceptos = [...String(xml || '').matchAll(/<(?:\w+:)?Concepto\b[^>]*>/g)].map((m) => _xmlAttr(m[0], 'Descripcion').replace(/\s+/g, ' ').trim()).filter(Boolean);
  let concepto = conceptos.slice(0, 3).join(' · ');
  if (conceptos.length > 3) concepto += ` (+${conceptos.length - 3} más)`;
  if (concepto.length > 300) concepto = concepto.slice(0, 297) + '…';
  return {
    uuid: _xmlAttr(timbre, 'UUID'),
    rfcEmisor: _xmlAttr(emisor, 'Rfc'),
    nombreEmisor: _xmlAttr(emisor, 'Nombre'),
    fecha: _xmlAttr(comp, 'Fecha'),
    total: Number(_xmlAttr(comp, 'Total') || 0),
    efecto: _xmlAttr(comp, 'TipoDeComprobante'),
    estatus: '',            // el SAT solo entrega en XML los comprobantes vigentes
    concepto,
  };
}

export async function satDescargar({ leerEstado, guardarEstado, desde, hasta, desdeMinimo } = {}) {
  const log = [];
  const decir = (t) => { log.push(t); };
  const cfg = satConfig();
  if (!cfg) return { ok: false, log: ['No hay e.firma configurada.'], items: [] };

  const M = await import('@nodecfdi/sat-ws-descarga-masiva');
  const { Fiel, HttpsWebClient, FielRequestBuilder, Service, QueryParameters, DateTimePeriod,
          DownloadType, RequestType, DocumentStatus, MetadataPackageReader, CfdiPackageReader } = M;

  const fiel = Fiel.create(cfg.cer.toString('binary'), cfg.key.toString('binary'), cfg.password);
  if (!fiel.isValid()) return { ok: false, log: ['La e.firma no es válida.'], items: [] };
  decir('e.firma válida (' + cfg.origen + ').');

  // Timeout explícito: sin él la librería revienta con un error que oculta la causa
  const service = new Service(new FielRequestBuilder(fiel), new HttpsWebClient(undefined, undefined, 120000));

  const estado = (await leerEstado?.()) || { solicitudes: [], ultimoHasta: null };
  estado.solicitudes = estado.solicitudes || [];

  const MAX_HORAS_SOLICITUD = 72;   // RF-356: el SAT conserva el paquete ~3 días
  const hoyISO = () => new Date().toISOString().slice(0, 10);
  const restar = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  let f_desde = desde || estado.ultimoHasta || restar(hoyISO(), cfg.dias);
  /* RF-628: la PRIMERA solicitud en XML arranca desde la factura más vieja de la
     bandeja que no tiene concepto, para que también a esas se les llene. */
  const relleno = !desde && !estado.xmlRelleno && desdeMinimo && desdeMinimo < f_desde;
  if (relleno) f_desde = desdeMinimo;
  const f_hasta = hasta || hoyISO();

  const items = [];
  const quedan = [];

  // 1) Retomar lo pendiente
  for (const sol of estado.solicitudes) {
    decir(`Revisando la solicitud ${sol.id} (${sol.desde} a ${sol.hasta})…`);
    /* RF-356: una solicitud CADUCA en el SAT (guarda el paquete ~72 h). Si ya no la
       encuentra —o lleva demasiados días—, hay que DESCARTARLA: si se deja pendiente,
       bloquea para siempre las solicitudes nuevas ("no se pide otra hasta que
       terminen") y la bandeja se queda vacía sin que nadie sepa por qué. */
    const horasDeVida = sol.creada ? (Date.now() - new Date(sol.creada).getTime()) / 3600000 : 0;
    const vencida = horasDeVida > MAX_HORAS_SOLICITUD;
    let verify;
    try { verify = await service.verify(sol.id); }
    catch (e) {
      decir('  No se pudo verificar: ' + (e && e.message || e));
      if (vencida) { decir(`  Lleva ${Math.round(horasDeVida)} h sin respuesta: se descarta y se vuelve a pedir el periodo.`); continue; }
      quedan.push(sol); continue;
    }

    if (!verify.getStatus().isAccepted()) {
      const msg = verify.getStatus().getMessage() || '';
      decir('  El SAT respondió: ' + msg);
      // "No se encontró la información" = la solicitud ya no existe en el SAT
      const noExiste = /no se encontr/i.test(msg);   // "No se encontro/encontró la informacion"
      if (noExiste || vencida) { decir('  Esa solicitud ya no sirve: se descarta y se vuelve a pedir el periodo.'); continue; }
      quedan.push(sol); continue;
    }

    const est = verify.getStatusRequest();
    const codigo = typeof est?.getValue === 'function' ? Number(est.getValue()) : null;
    const nombre = { 1: 'Aceptada', 2: 'En proceso', 3: 'Terminada', 4: 'Error', 5: 'Rechazada', 6: 'Vencida' }[codigo] || ('código ' + codigo);
    const cfdis = typeof verify.getNumberCfdis === 'function' ? verify.getNumberCfdis() : null;

    if (codigo === 1 || codigo === 2) { decir(`  Estado en el SAT: ${nombre}. Se retoma en la próxima corrida.`); quedan.push(sol); continue; }
    if (codigo === 4 || codigo === 5 || codigo === 6) { decir(`  La solicitud quedó como ${nombre}; se descarta y se pedirá de nuevo.`); estado.ultimoHasta = estado.ultimoHasta; continue; }

    const paquetes = verify.getPackageIds() || [];
    if (!paquetes.length) { decir(`  Terminada: ${cfdis ?? 0} comprobante(s); sin paquetes que bajar.`); estado.ultimoHasta = sol.hasta; continue; }
    decir(`  Terminada: ${cfdis ?? '?'} comprobante(s) · ${paquetes.length} paquete(s).`);

    for (const pid of paquetes) {
      const dl = await service.download(pid);
      if (!dl.getStatus().isAccepted()) { decir(`  No se pudo bajar el paquete ${pid}.`); continue; }
      const contenido = Buffer.from(dl.getPackageContent(), 'base64');
      const esXml = sol.tipo === 'xml';   // RF-628: las solicitudes viejas (sin tipo) son de metadata
      const Lector = esXml ? CfdiPackageReader : MetadataPackageReader;
      let reader;
      if (cfg.dirPaquetes) {   // en la compu se conserva el ZIP
        fs.mkdirSync(cfg.dirPaquetes, { recursive: true });
        const zip = path.join(cfg.dirPaquetes, pid + '.zip');
        fs.writeFileSync(zip, contenido);
        reader = await Lector.createFromFile(zip);
      } else {                 // en la nube se lee en memoria
        reader = await Lector.createFromContents(contenido.toString('binary'));
      }
      if (esXml) {
        for await (const m of reader.cfdis()) {
          for (const [, xml] of m) { const d = satDatosCfdi(xml); if (d.uuid) items.push(d); }
        }
        continue;
      }
      for await (const item of reader.metadata()) {
        const d = typeof item.all === 'function' ? item.all() : item;
        const g = (...ks) => { for (const k of ks) { const v = d instanceof Map ? d.get(k) : d[k]; if (v != null && v !== '') return String(v); } return ''; };
        items.push({
          uuid: g('Uuid', 'uuid', 'UUID'),
          rfcEmisor: g('RfcEmisor', 'rfcEmisor'),
          nombreEmisor: g('NombreEmisor', 'nombreEmisor'),
          fecha: g('FechaEmision', 'fechaEmision'),
          total: Number(g('Monto', 'monto', 'Total') || 0),
          efecto: g('EfectoComprobante', 'efectoComprobante'),
          estatus: g('Estatus', 'estatus'),
        });
      }
    }
    estado.ultimoHasta = sol.hasta;
  }

  // 2) Si no quedó ninguna en proceso, se pide el periodo nuevo
  if (!quedan.length) {
    decir(`Pidiendo al SAT los comprobantes RECIBIDOS del ${f_desde} al ${f_hasta}…`);
    const params = QueryParameters.create()
      .withPeriod(DateTimePeriod.createFromValues(`${f_desde} 00:00:00`, `${f_hasta} 23:59:59`))
      .withDownloadType(new DownloadType('received'))   // la CLAVE del enum, no su valor
      .withRequestType(new RequestType('xml'))            // RF-628: XML completo (trae los conceptos)
      .withDocumentStatus(new DocumentStatus('active'));  // de los recibidos, el SAT solo da en XML los vigentes
    const q = await service.query(params);
    if (!q.getStatus().isAccepted()) decir('  El SAT no aceptó la solicitud: ' + q.getStatus().getMessage());
    else {
      const id = q.getRequestId();
      decir(`  Solicitud creada: ${id}. El SAT tarda de minutos a horas en prepararla.`);
      quedan.push({ id, desde: f_desde, hasta: f_hasta, creada: new Date().toISOString(), tipo: 'xml' });
      if (relleno) estado.xmlRelleno = true;
    }
  } else {
    decir(`Hay ${quedan.length} solicitud(es) en proceso; no se pide otra hasta que terminen.`);
  }

  estado.solicitudes = quedan;
  await guardarEstado?.(estado);
  return { ok: true, log, items, estado };
}

/* ---------- Filtra lo que ya se conoce y arma los renglones de la bandeja ---------- */
export function satNuevosParaBandeja(items, state) {
  const yaEnBandeja = new Set((state.satBandeja || []).map((x) => String(x.uuid || '').toUpperCase()));
  const yaAceptados = new Set();
  (state.pagosSemanas || []).forEach((c) => (c.pagos || []).forEach((p) => { if (p.satUuid) yaAceptados.add(String(p.satUuid).toUpperCase()); }));
  return items.filter((it) => {
    const u = String(it.uuid || '').toUpperCase();
    if (!u || yaEnBandeja.has(u) || yaAceptados.has(u)) return false;
    if (it.efecto && !/^I/i.test(it.efecto) && !/ingreso/i.test(it.efecto)) return false; // solo facturas
    if (it.estatus && /^0/.test(it.estatus)) return false;                                 // sin canceladas
    return true;
  }).map((it) => ({
    id: Date.now() + Math.floor(Math.random() * 1e6),
    uuid: it.uuid, rfcEmisor: it.rfcEmisor, proveedor: it.nombreEmisor,
    fecha: (it.fecha || '').slice(0, 10), total: it.total,
    concepto: it.concepto || '',   // RF-628
    estado: 'pendiente', bajadoEl: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }));
}

/* RF-628: a las facturas que YA están en la bandeja sin concepto se les pone el que
   trae su XML. Devuelve cuántas se completaron. */
export function satCompletarBandeja(items, state) {
  const porUuid = new Map(items.filter((it) => it.concepto).map((it) => [String(it.uuid || '').toUpperCase(), it]));
  let n = 0;
  (state.satBandeja || []).forEach((b) => {
    if (!b || b.concepto) return;
    const it = porUuid.get(String(b.uuid || '').toUpperCase());
    if (it) { b.concepto = it.concepto; n++; }
  });
  return n;
}
/* RF-628: fecha de la factura más vieja de la bandeja que aún no tiene concepto */
export function satDesdeSinConcepto(state) {
  const f = (state.satBandeja || []).filter((b) => b && !b.concepto && (b.estado || 'pendiente') === 'pendiente' && b.fecha).map((b) => String(b.fecha).slice(0, 10)).sort();
  return f[0] || null;
}

export { KEY_ESTADO };

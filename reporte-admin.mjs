/* ================== Reporte administrativo diario (RF-209) ==================
   Se manda por Telegram todos los días (6:00 PM por default) a los usuarios con
   la casilla "información administrativa" (tgInfoAdmin) y Telegram conectado.
   Las fórmulas REPLICAN exactamente las del corte semanal de Pago a Proveedores
   (RN-38 / actualizarResumenCorte del HTML):
     · Saldo en bancos (al día)  = saldo al inicio + ingresos − pagado   (renglón "Pagado")
     · Pagos programados         = Σ montoProgramado del corte
     · Pagado a hoy              = Σ abonos del corte
     · Saldo tras programados    = saldo al inicio + ingresos − programado (renglón "Programado")
     · Cuentas por pagar         = Σ saldo pendiente de TODOS los pagos registrados (todas las semanas)
     · Cuentas por cobrar        = Σ pendiente de cobro de las facturas de clientes (prefacturas)
   Módulo sin estado: recibe el `state`; cada servidor manda con su propia infra. */

const TZ_MIN = Number(process.env.REPORTE_TZ_MIN ?? -420);   // Hermosillo / Los Cabos (sin horario de verano)
export const repAhoraLocal = () => new Date(Date.now() + TZ_MIN * 60000);   // reloj local leído en campos UTC

const dinero = (v) => '$' + (Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fLarga = (iso) => { const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number); return d ? `${d} de ${MESES[m - 1]}` : ''; };
const fCorta = (iso) => { const [y, m, d] = String(iso || '').slice(0, 10).split('-'); return d ? `${d}/${m}/${y}` : ''; };

/* ---- Fórmulas del corte (idénticas al cliente) ---- */
const abonado = (p) => (p.abonos || []).reduce((s, a) => s + (Number(a.monto) || 0), 0);
// RF-228: p.saldadaManual marca la factura saldada sin abonos (no cuenta en CxP)
const saldoActual = (p) => (p && p.saldadaManual) ? 0 : Math.max(0, (Number(p.saldoInicial) || 0) - abonado(p));
/* RF-568: MISMAS fórmulas que el letrero del sistema (antes divergían):
   · programado = solo los pagos FIJADOS (p.programadoFijo), como totalProgramado del HTML
   · abonadoBanco excluye prepago Y nota de crédito (PAGO_SIN_BANCO, RF-364) — una NC
     de $24,687.05 hacía que el Telegram diera $24,687.05 menos de saldo que el sistema */
const totalProgramado = (c) => (c.pagos || []).filter((p) => p.programadoFijo).reduce((s, p) => s + (Number(p.montoProgramado) || 0), 0);
const PAGO_SIN_BANCO = new Set(['prepago', 'notaCredito']);
const abonadoBanco = (p) => (p.abonos || []).reduce((s, a) => s + (PAGO_SIN_BANCO.has(a.tipoPago) ? 0 : (Number(a.monto) || 0)), 0);
/* RF-535: igual que en el CRM — los abonos HISTÓRICOS (fecha anterior al lunes de
   la semana Y anterior a la fecha del saldo inicial de bancos) no cuentan como
   pagado de la semana: ya están reflejados en el saldo inicial. */
const abonoEsHistorico = (state, a, c) => {
  const f = String(a.fecha || "").slice(0, 10);
  if (!f || !c || !c.lunes || f >= c.lunes) return false;
  const F = saldoInicialInfo(state).fecha;
  return !!(F && f < F);
};
const totalPagado = (state, c) => (c.pagos || []).reduce((s, p) => s +
  (p.abonos || []).reduce((t2, a) => t2 + ((PAGO_SIN_BANCO.has(a.tipoPago) || abonoEsHistorico(state, a, c)) ? 0 : (Number(a.monto) || 0)), 0)
, 0);
// RF-270: los ingresos viven en state.ingresos (independientes de las semanas); las
// entradas de una semana son los ingresos cuya fecha cae en ella + restos sin migrar.
const entradasDe = (state, c) => ((state.ingresos || []).filter((r) => r.fecha >= c.lunes && r.fecha <= String(c.domingo || c.lunes)).reduce((s, e) => s + (Number(e.monto) || 0), 0))
  + ((c.saldos || []).reduce((s, e) => s + (Number(e.monto) || 0), 0));
function saldoInicialInfo(state) {
  let monto = 0, fecha = null;
  (state.cuentasCat || []).forEach((ct) => {
    if (Number(ct.saldoInicial)) {
      monto += Number(ct.saldoInicial) || 0;
      const f = ct.saldoInicialFecha || null;
      if (f && (!fecha || f < fecha)) fecha = f;
    }
  });
  return { monto, fecha };
}
const cortesOrdenados = (state) => (state.pagosSemanas || []).slice().sort((a, b) => String(a.lunes || '').localeCompare(String(b.lunes || '')));
const ledgerIncluye = (state, c) => { const F = saldoInicialInfo(state).fecha; return !F || String(c.domingo || c.lunes || '') >= F; };
function saldoAntesTotal(state, c) {
  let s = saldoInicialInfo(state).monto;
  for (const x of cortesOrdenados(state)) {
    if (ledgerIncluye(state, x)) s += entradasDe(state, x);
    if (x.id === c.id) break;
    if (ledgerIncluye(state, x)) s -= totalPagado(state, x);
  }
  return s;
}
/* ---- Facturas de clientes (prefacturas): total y cobrado ---- */
function totalesDoc(doc) {
  let sub = 0, imp = 0;
  (doc.partidas || []).forEach((pt) => {
    const s = (Number(pt.cantidad) || 0) * (Number(pt.precio) || 0);
    sub += s; imp += s * (1 - (Number(pt.desc) || 0) / 100);
  });
  return imp + imp * (Number(doc.iva) || 0) / 100;   // total con IVA
}
function cobradoDeFactura(state, pf) {
  let cobrado = 0;
  // RF-270: ingresos en state.ingresos; un depósito puede repartirse en varias facturas
  const suma = (e) => {
    if (Array.isArray(e.facturas) && e.facturas.length) {
      e.facturas.forEach((f) => { if (String(f.pfId || '') === String(pf.id)) cobrado += Number(f.monto) || 0; });
    } else if (e.concepto === 'pagoFactura' && String(e.pfId || '') === String(pf.id)) cobrado += Number(e.monto) || 0;
  };
  (state.ingresos || []).forEach(suma);
  (state.pagosSemanas || []).forEach((c) => (c.saldos || []).forEach(suma));
  // RF-222/568: las notas de crédito ligadas SALDAN el pendiente (igual que el sistema)
  (state.notasCredito || []).forEach((nc) => { if (String(nc.pfId || '') === String(pf.id)) cobrado += Number(nc.total) || 0; });
  return cobrado;
}

// Corte de la semana que cubre HOY (o el más reciente si hoy no cae en ninguno)
function corteActual(state, hoyISO) {
  const cortes = cortesOrdenados(state);
  const cubre = cortes.find((c) => c.lunes && hoyISO >= c.lunes && hoyISO <= String(c.domingo || c.lunes));
  return cubre || cortes[cortes.length - 1] || null;
}

/* RF-568: el reporte REPLICA el letrero de la semana en Pago a Proveedores (RF-509):
   saldo al inicio + ingresos − pagos = disponible en bancos − acreedores + por cobrar
   + inventario = dinero a futuro. Las llaves viejas se conservan para respetar lo
   que cada quien ya tenía marcado en Ajustes. */
export const REP_CAMPOS = [
  { k: 'saldoInicio',   lbl: 'Saldo en bancos al inicio de la semana' },
  { k: 'ingresos',      lbl: 'Ingresos de la semana' },
  { k: 'pagado',        lbl: 'Pagos de la semana (pagado a hoy)' },
  { k: 'saldoDia',      lbl: 'Disponible en bancos (dinero hoy en las cuentas)' },
  { k: 'programado',    lbl: 'Pagos programados de la semana' },
  { k: 'saldoTrasProg', lbl: 'Saldo después de pagos programados' },
  { k: 'acreedores',    lbl: 'Total de acreedores (compromisos pendientes de la semana)' },
  { k: 'cxc',           lbl: 'Cuentas por cobrar (facturas de clientes pendientes)' },
  { k: 'inventario',    lbl: 'Inventario (inv. para venta a precio de venta con descuento)' },
  { k: 'futuro',        lbl: 'Dinero a futuro (disponible − acreedores + por cobrar + inventario)' },
  { k: 'cxp',           lbl: 'Facturas de proveedor sin pagar — TODAS las semanas (dato aparte)' },
];
export function repCfg(state) {
  const base = { hora: '18:00', campos: {} };
  REP_CAMPOS.forEach((c) => { base.campos[c.k] = true; });
  const g = state.reporteAdminCfg || {};
  return { hora: g.hora || base.hora, campos: Object.assign(base.campos, g.campos || {}) };
}

export function repAdminDatos(state) {
  const hoyISO = repAhoraLocal().toISOString().slice(0, 10);
  const c = corteActual(state, hoyISO);
  if (!c) return null;
  const enLedger = ledgerIncluye(state, c);
  const ing = enLedger ? entradasDe(state, c) : 0;
  const saldoIni = saldoAntesTotal(state, c) - ing;   // lo que había el lunes, sin ingresos
  const prog = totalProgramado(c);
  const pag = enLedger ? totalPagado(state, c) : 0;
  const tb = saldoIni + ing;                          // dinero disponible antes de pagar
  // Cuentas por pagar: SOLO facturas de proveedores pendientes (tipo "factura").
  // Fuera las OCs (folio "OC ##": todavía no son factura), la nómina, préstamos,
  // comisiones, gobierno y domiciliados. Sin contar dos veces las facturas que el
  // sistema arrastra a la semana nueva (mismo proveedor + folio: manda la copia
  // MÁS RECIENTE).
  let cxp = 0, cxpN = 0;
  const porLlave = new Map();
  const sueltos = [];
  for (const x of cortesOrdenados(state)) {
    for (const p of (x.pagos || [])) {
      if (String(p.tipo || '') !== 'factura') continue;          // puras facturas
      const folio = String(p.folio || '').trim();
      if (/^oc[\s\-#.]*\d/i.test(folio)) continue;               // las OC no cuentan
      const s = saldoActual(p);
      const esClave = folio && !/^(na|n\/a|—|-)$/i.test(folio);
      // La copia MÁS RECIENTE manda AUNQUE esté en $0: la factura que no se paga se
      // pasa a la semana siguiente, y ahí es donde se registra su pago — la copia
      // vieja se queda "pendiente" pero es historia, no deuda.
      if (esClave) { porLlave.set(String(p.proveedor || '').toLowerCase() + '|' + folio.toLowerCase(), s); continue; }
      if (s > 0.005) sueltos.push(s);
    }
  }
  for (const s of porLlave.values()) { if (s > 0.005) { cxp += s; cxpN++; } }
  for (const s of sueltos) { cxp += s; cxpN++; }
  // Cuentas por cobrar: MISMO criterio que totalPorCobrar del sistema (RF-354/508):
  // fuera las CANCELADAS y las HISTÓRICAS de otro sistema (pf.externa — no son ingreso);
  // las notas de crédito ya cuentan como cobrado; tolerancia de medio centavo.
  let cxc = 0, cxcN = 0;
  (state.prefacturas || []).forEach((pf) => {
    if (!pf || pf.cancelada || pf.estatus === 'Cancelada' || pf.externa) return;
    const pend = totalesDoc(pf) - cobradoDeFactura(state, pf);
    if (pend > 0.005) { cxc += pend; cxcN++; }
  });
  // RF-568: acreedores = lo que FALTA por pagar de todo lo registrado en la semana
  // (facturas, nómina, gobierno, comisiones…), igual que el letrero
  const acreedores = (c.pagos || []).reduce((s, p) => s + saldoActual(p), 0);
  // RF-568: el INVENTARIO lo calcula el navegador (cadena completa: físico, entradas,
  // remisiones, resguardo, facturado, valuación) y deja una FOTO en state.invValorFoto
  // por mes; aquí se toma la del mes que le toca a la semana (RF-563: si incluye hoy,
  // el mes de hoy; si no, el mes en que termina).
  const finSem0 = c.domingo || c.lunes || hoyISO;
  const mesInv = (c.lunes && hoyISO >= c.lunes && hoyISO <= String(finSem0)) ? hoyISO.slice(0, 7) : String(finSem0).slice(0, 7);
  const foto = (state.invValorFoto || {})[mesInv] || null;
  const inventario = foto ? (Number(foto.valor) || 0) : 0;
  const finSemana = c.domingo || (() => { const d = new Date(c.lunes + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); })();
  // Número de semana: el del corte o, si no lo trae, la semana ISO del lunes
  const semanaISO = (iso) => { const d = new Date(iso + 'T00:00:00Z'); const j = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - j) / 86400000) + j.getUTCDay() + 1) / 7); };
  const dispBancos = tb - pag;
  return {
    semana: c.semana || (c.lunes ? semanaISO(c.lunes) : ''), lunes: c.lunes || '', domingo: finSemana, hoy: hoyISO,
    saldoInicio: saldoIni, ingresos: ing, pagado: pag, saldoDia: dispBancos,
    programado: prog, saldoTrasProg: tb - prog,
    acreedores, cxc, cxcN,
    inventario, invMes: mesInv, invFoto: foto,
    futuro: dispBancos - acreedores + cxc + inventario,
    cxp, cxpN,
  };
}

// RF-258: "depósitos" = pagos con FECHA PROGRAMADA de pago = HOY y saldo pendiente. Si se
// pasa nombreUsuario, solo los que ESA persona fijó (p.fijadoPor). Sirve para avisarle a
// quien programó el pago que hoy le toca depositar.
const _nomNorm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function depositosDeHoy(state, nombreUsuario) {
  const hoy = repAhoraLocal().toISOString().slice(0, 10);
  const out = [];
  (state.pagosSemanas || []).forEach((c) => (c.pagos || []).forEach((p) => {
    if (String(p.fechaProgramada || '').slice(0, 10) !== hoy) return;
    if (saldoActual(p) <= 0.005) return;
    if (nombreUsuario && _nomNorm(p.fijadoPor) !== _nomNorm(nombreUsuario)) return;
    out.push(p);
  }));
  return out;
}

export function repAdminTexto(state, empresa) {
  const d = repAdminDatos(state);
  if (!d) return null;
  const cfg = repCfg(state);
  const anio = String(d.domingo || d.lunes).slice(0, 4);
  const filas = [];
  filas.push(`📋 <b>Reporte administrativo — ${empresa}</b>`);
  filas.push(`Semana ${d.semana} · ${fLarga(d.lunes)} al ${fLarga(d.domingo)} del ${anio}`);
  filas.push(`Fecha: ${fCorta(d.hoy)}`);
  filas.push('');
  /* RF-568: mismo orden y mismos números que el letrero de la semana en el sistema */
  const MESES_C = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  if (cfg.campos.saldoInicio)   filas.push(`🏦 Saldo en bancos al inicio (${fCorta(d.lunes)}): <b>${dinero(d.saldoInicio)}</b>`);
  if (cfg.campos.ingresos)      filas.push(`➕ Ingresos de la semana: ${dinero(d.ingresos)}`);
  if (cfg.campos.pagado)        filas.push(`➖ Pagos de la semana (pagado a hoy): ${dinero(d.pagado)}`);
  if (cfg.campos.saldoDia)      filas.push(`= 💵 Disponible en bancos: <b>${dinero(d.saldoDia)}</b>`);
  if (cfg.campos.programado || cfg.campos.saldoTrasProg) filas.push('');
  if (cfg.campos.programado)    filas.push(`📅 Pagos programados de la semana: ${dinero(d.programado)}`);
  if (cfg.campos.saldoTrasProg) filas.push(`💰 Saldo después de pagos programados: <b>${dinero(d.saldoTrasProg)}</b>`);
  filas.push('');
  if (cfg.campos.acreedores)    filas.push(`➖ Total de acreedores (pendiente de la semana): ${dinero(d.acreedores)}`);
  if (cfg.campos.cxc)           filas.push(`➕ Cuentas por cobrar: ${dinero(d.cxc)}${d.cxcN ? ` (${d.cxcN} factura${d.cxcN === 1 ? '' : 's'})` : ' (todo cobrado)'}`);
  if (cfg.campos.inventario) {
    const mm = String(d.invMes || '').slice(5, 7), aa = String(d.invMes || '').slice(0, 4);
    const lblMes = mm ? `${MESES_C[Number(mm) - 1]} ${aa}` : '';
    filas.push(d.invFoto
      ? `➕ Inventario para venta (${lblMes}): ${dinero(d.inventario)} <i>(foto del ${fCorta(d.invFoto.fecha)} ${d.invFoto.hora || ''})</i>`
      : `➕ Inventario para venta (${lblMes}): — <i>(abre Reportes → Inventarios en el sistema para actualizarlo)</i>`);
  }
  if (cfg.campos.futuro)        filas.push(`= 🟢 Dinero a futuro: <b>${dinero(d.futuro)}</b>`);
  if (cfg.campos.cxp) { filas.push(''); filas.push(`📥 Facturas de proveedor sin pagar (todas las semanas): ${dinero(d.cxp)} (${d.cxpN} factura${d.cxpN === 1 ? '' : 's'})`); }
  return filas.join('\n');
}

/* ===== RF-259: REPORTE DE DEPÓSITOS (mensaje MATUTINO, aparte del administrativo) =====
   A primera hora del día, a cada usuario se le avisa SOLO los pagos que ÉL fijó con fecha
   programada = HOY (los que le toca depositar). Tiene su propia hora de envío. */
export const repDepositosHora = (state) => (state.reporteDepositosCfg && state.reporteDepositosCfg.hora) || '07:00';
export function repDepositosTexto(state, empresa, nombreUsuario) {
  const deps = depositosDeHoy(state, nombreUsuario || null);
  if (!deps.length) return null;   // sin depósitos hoy: no se manda
  const tot = deps.reduce((s, p) => s + saldoActual(p), 0);
  const hoyISO = repAhoraLocal().toISOString().slice(0, 10);
  const filas = [];
  filas.push(`💵 <b>Depósitos programados para HOY — ${empresa}</b>`);
  filas.push(`Fecha: ${fCorta(hoyISO)}`);
  filas.push('');
  filas.push(`${nombreUsuario ? 'Tienes' : 'Hay'} <b>${deps.length}</b> depósito(s) que pagar hoy · Total <b>${dinero(tot)}</b>:`);
  deps.forEach((p) => filas.push(`   • ${p.proveedor || p.concepto || '—'} — ${dinero(saldoActual(p))}${(!nombreUsuario && p.fijadoPor) ? ` (${p.fijadoPor})` : ''}`));
  return filas.join('\n');
}
// ¿ya toca el matutino? (hora local >= hora config y no se ha mandado hoy)
export function repDepositosToca(state, enviadoHoy) {
  const local = repAhoraLocal();
  const hoyISO = local.toISOString().slice(0, 10);
  if (enviadoHoy === hoyISO) return false;
  const [h, m] = String(repDepositosHora(state)).split(':').map(Number);
  return (local.getUTCHours() * 60 + local.getUTCMinutes()) >= (h * 60 + (m || 0));
}

// ¿Ya toca mandarlo? (hora local >= cfg.hora y no se ha mandado hoy)
export function repAdminToca(state, enviadoHoy) {
  const cfg = repCfg(state);
  const local = repAhoraLocal();
  const hoyISO = local.toISOString().slice(0, 10);
  if (enviadoHoy === hoyISO) return false;
  const [h, m] = String(cfg.hora || '18:00').split(':').map(Number);
  return (local.getUTCHours() * 60 + local.getUTCMinutes()) >= (h * 60 + (m || 0));
}

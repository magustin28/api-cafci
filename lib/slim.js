// ─────────────────────────────────────────────────────────────
//  Payload liviano para el dashboard: GET /api/fondos?fields=slim
//
//  El dashboard sólo usa 22 de los 47 campos que trae la planilla de CAFCI (~15% del JSON).
//  Este módulo arma la versión compacta: un diccionario `campos` con los nombres ESTABLES
//  (los que consume la UI) y, por cada fondo, un array de valores en ese orden. Así el
//  cliente deja de depender de los títulos del Excel (que CAFCI puede renombrar) y el JSON
//  baja de ~5,6 MB a ~0,84 MB.
//
//  El endpoint devuelve el payload COMPLETO por defecto: el liviano es opt-in.
// ─────────────────────────────────────────────────────────────

// nombre estable (contrato con el dashboard) → encabezado en el Excel de CAFCI
// `ref`: si la clave real lleva la fecha de referencia, acá va el nombre en `referencias`.
const CAMPOS = [
  { nombre: "cnv",             excel: "Codigo CNV" },
  { nombre: "fondo",           excel: "Fondo" },
  { nombre: "moneda",          excel: "Moneda Fondo" },
  { nombre: "region",          excel: "Clasificación_Región" },
  { nombre: "horizonte",       excel: "Clasificación_Horizonte" },
  { nombre: "varMes",          excel: "Variacion cuotaparte %",  ref: "variacion_fecha1" },
  { nombre: "varAnio",         excel: "Variacion cuotaparte %",  ref: "variacion_fecha2" },
  { nombre: "varAnual",        excel: "Variacion cuotaparte %",  ref: "variacion_fecha3" },
  { nombre: "patrimonio",      excel: "Patrimonio_Actual" },
  { nombre: "socGerente",      excel: "Sociedad Gerente" },
  { nombre: "cafci",           excel: "Código CAFCI" },
  { nombre: "valor",           excel: "Valor (mil cuotapartes)_Actual" },
  { nombre: "valorVarPct",     excel: "Valor (mil cuotapartes)_Variac. %" },
  { nombre: "socDepositaria",  excel: "Sociedad Depositaria" },
  { nombre: "honSD",           excel: "Honorarios Adm. SD" },
  { nombre: "honSG",           excel: "Honorarios Adm. SG" },
  { nombre: "minimoInversion", excel: "Mínimo de Inversión" },
  { nombre: "patrimonioAnt",   excel: "Patrimonio",               ref: "patrimonio_fecha_anterior" },
  { nombre: "valorAnt",        excel: "Valor (mil cuotapartes)",   ref: "valor_fecha_anterior" },
  { nombre: "valorReexp",      excel: "Valor (mil cuotapartes)_Reexp.Pesos" },
  { nombre: "clasificacion",   excel: "Código de Clasificación" },
  { nombre: "plazoLiq",        excel: "Plazo Liq." }, // valor crudo en días (la UI lo formatea)
];

// Clave real en el fondo para un campo (resuelve los que llevan fecha de referencia)
function claveExcel(campo, referencias) {
  if (!campo.ref) return campo.excel;
  const sufijo = (referencias && referencias[campo.ref]) || "";
  return `${campo.excel}_${sufijo}`;
}

// datos completos de la planilla → versión liviana
function slimear(datos) {
  const referencias = datos.referencias || {};
  const claves = CAMPOS.map((c) => claveExcel(c, referencias));

  const listado_fondos = (datos.listado_fondos || []).map((cat) => ({
    categoria_fondo: cat.categoria_fondo,
    fondos: (cat.fondos || []).map((f) => claves.map((k) => f[k] ?? null)),
  }));

  return { referencias, campos: CAMPOS.map((c) => c.nombre), listado_fondos };
}

module.exports = { CAMPOS, claveExcel, slimear };

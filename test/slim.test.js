// ─────────────────────────────────────────────────────────────
//  Tests del payload liviano (lib/slim.js).
//  Correr:  npm test
// ─────────────────────────────────────────────────────────────
const test = require("node:test");
const assert = require("node:assert/strict");
const { CAMPOS, claveExcel, slimear } = require("../lib/slim");

const REFS = {
  variacion_fecha1: "30/09/26",
  variacion_fecha2: "30/12/25",
  variacion_fecha3: "30/09/25",
  valor_fecha_anterior: "15/10/26",
  patrimonio_fecha_anterior: "15/10/26",
};

// Fondo como viene en el Excel (los 22 campos que importan + algunos que NO van al slim)
function fondoExcel(extra = {}) {
  return {
    "Codigo CNV": 1246,
    "Fondo": "IOL Cash Management - Clase A",
    "Moneda Fondo": "ARS",
    "Clasificación_Región": "Glo",
    "Clasificación_Horizonte": "Med",
    "Variacion cuotaparte %_30/09/26": 1.156,
    "Variacion cuotaparte %_30/12/25": 23.617,
    "Variacion cuotaparte %_30/09/25": 35.008,
    "Patrimonio_Actual": 114749940857.55,
    "Sociedad Gerente": "Adcap Asset Management S.G.F.C.I.S.A.",
    "Código CAFCI": 3697,
    "Valor (mil cuotapartes)_Actual": 12433.02,
    "Valor (mil cuotapartes)_Variac. %": 0.189,
    "Sociedad Depositaria": "Banco Comafi S.A.",
    "Honorarios Adm. SD": 0.121,
    "Honorarios Adm. SG": 2.52,
    "Mínimo de Inversión": 1,
    "Patrimonio_15/10/26": 114450639020.37,
    "Valor (mil cuotapartes)_15/10/26": 12409.513,
    "Valor (mil cuotapartes)_Reexp.Pesos": 12433.02,
    "Código de Clasificación": 2,
    "Plazo Liq.": 1,
    "Market Share": 0.513,          // el dashboard no lo usa: no debe ir al slim
    "Tipo de Dinero": "No Aplica",  // idem
    ...extra,
  };
}

function datosExcel(fondos = [fondoExcel()]) {
  return {
    fechaArchivo: "16/10/26",
    referencias: REFS,
    listado_fondos: [{ categoria_fondo: "Renta Fija Peso Argentina", fondos }],
  };
}

test("CAMPOS: 22 nombres estables, sin repetidos", () => {
  assert.equal(CAMPOS.length, 22);
  const nombres = CAMPOS.map((c) => c.nombre);
  assert.equal(new Set(nombres).size, 22);
  assert.equal(nombres.includes("plazoLiq"), true);
});

test("claveExcel: resuelve las claves que llevan fecha de referencia", () => {
  assert.equal(claveExcel({ excel: "Fondo" }, REFS), "Fondo");
  assert.equal(claveExcel({ excel: "Patrimonio_Actual" }, REFS), "Patrimonio_Actual");
  assert.equal(claveExcel({ excel: "Patrimonio", ref: "patrimonio_fecha_anterior" }, REFS), "Patrimonio_15/10/26");
  assert.equal(claveExcel({ excel: "Valor (mil cuotapartes)", ref: "valor_fecha_anterior" }, REFS), "Valor (mil cuotapartes)_15/10/26");
  assert.equal(claveExcel({ excel: "Variacion cuotaparte %", ref: "variacion_fecha2" }, REFS), "Variacion cuotaparte %_30/12/25");
  // sin referencias queda el grupo con guion bajo (comportamiento degradado, no rompe)
  assert.equal(claveExcel({ excel: "Patrimonio", ref: "patrimonio_fecha_anterior" }, {}), "Patrimonio_");
});

test("slimear: estructura y orden de los campos", () => {
  const slim = slimear(datosExcel());
  assert.deepEqual(Object.keys(slim), ["referencias", "campos", "listado_fondos"]);
  assert.deepEqual(slim.campos, CAMPOS.map((c) => c.nombre));
  assert.deepEqual(slim.referencias, REFS);
  assert.equal(slim.listado_fondos.length, 1);
  assert.equal(slim.listado_fondos[0].categoria_fondo, "Renta Fija Peso Argentina");
  assert.equal(slim.listado_fondos[0].fondos[0].length, 22);
});

test("slimear: EQUIVALENCIA con el payload completo, campo por campo", () => {
  const fondo = fondoExcel();
  const slim = slimear(datosExcel([fondo]));
  const fila = slim.listado_fondos[0].fondos[0];

  CAMPOS.forEach((c, i) => {
    const clave = claveExcel(c, REFS);
    assert.equal(fila[i], fondo[clave] ?? null, `campo "${c.nombre}" ← "${clave}"`);
  });

  const val = (n) => fila[slim.campos.indexOf(n)];
  assert.equal(val("cnv"), 1246);
  assert.equal(val("fondo"), "IOL Cash Management - Clase A");
  assert.equal(val("varAnio"), 23.617);
  assert.equal(val("patrimonioAnt"), 114450639020.37);
  assert.equal(val("valorAnt"), 12409.513);
  assert.equal(val("clasificacion"), 2);
  assert.equal(val("plazoLiq"), 1);
});

test("slimear: un campo faltante queda en null (no rompe)", () => {
  const fondoSinPlazo = fondoExcel();
  delete fondoSinPlazo["Plazo Liq."];
  const slim = slimear(datosExcel([fondoSinPlazo]));
  const fila = slim.listado_fondos[0].fondos[0];
  assert.equal(fila[slim.campos.indexOf("plazoLiq")], null);
});

test("slimear: conserva la cadena vacía (no la convierte en null)", () => {
  const slim = slimear(datosExcel([fondoExcel({ "Sociedad Depositaria": "" })]));
  const fila = slim.listado_fondos[0].fondos[0];
  assert.equal(fila[slim.campos.indexOf("socDepositaria")], "");
});

test("slimear: no incluye los campos que el dashboard no usa", () => {
  const slim = slimear(datosExcel());
  assert.equal(slim.campos.includes("Market Share"), false);
  assert.equal(slim.campos.includes("Tipo de Dinero"), false);
  assert.equal(slim.listado_fondos[0].fondos[0].length, 22);
});

test("slimear: datos vacíos o incompletos no rompen", () => {
  const vacio = slimear({});
  assert.deepEqual(vacio.campos, CAMPOS.map((c) => c.nombre));
  assert.deepEqual(vacio.listado_fondos, []);
  assert.deepEqual(vacio.referencias, {});

  const sinFondos = slimear({ referencias: REFS, listado_fondos: [{ categoria_fondo: "X" }] });
  assert.deepEqual(sinFondos.listado_fondos[0].fondos, []);
  assert.equal(sinFondos.listado_fondos[0].categoria_fondo, "X");
});

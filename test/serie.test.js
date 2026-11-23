// ─────────────────────────────────────────────────────────────
//  Tests de la serie histórica (lib/serie.js).
//  Correr:  npm test
// ─────────────────────────────────────────────────────────────
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizarCafci, buscarFondo, extraerSerie, recortar } = require("../lib/serie");

// Fondo como viene en el JSONB guardado (claves del Excel completo).
function fondoExcel(cafci, valor, extra = {}) {
  return {
    "Codigo CNV": 1246,
    "Fondo": "IOL Cash Management - Clase A",
    "Moneda Fondo": "ARS",
    "Código CAFCI": cafci,
    "Valor (mil cuotapartes)_Actual": valor,
    ...extra,
  };
}

// Planilla con la forma real: { listado_fondos: [{ categoria_fondo, fondos: [...] }] }
function planilla(fondos) {
  return { listado_fondos: [{ categoria_fondo: "Mercado de Dinero Peso Argentina", fondos }] };
}

test("normalizarCafci: acepta enteros positivos", () => {
  assert.equal(normalizarCafci(6419), 6419);
  assert.equal(normalizarCafci("6419"), 6419);
  assert.equal(normalizarCafci(6419.0), 6419);
});

test("normalizarCafci: rechaza null, texto, decimales y negativos", () => {
  assert.equal(normalizarCafci(null), null);
  assert.equal(normalizarCafci(undefined), null);
  assert.equal(normalizarCafci(""), null);
  assert.equal(normalizarCafci("abc"), null);
  assert.equal(normalizarCafci(6419.5), null);
  assert.equal(normalizarCafci(-6419), null);
  assert.equal(normalizarCafci(0), null);
});

test("buscarFondo: encuentra el fondo por código CAFCI", () => {
  const datos = planilla([fondoExcel(6419, 969.565), fondoExcel(1234, 10.5)]);
  const encontrado = buscarFondo(datos, 6419);
  assert.deepEqual(encontrado, { valor: 969.565, fondo: "IOL Cash Management - Clase A", moneda: "ARS" });
});

test("buscarFondo: devuelve null si el fondo no está en la planilla", () => {
  const datos = planilla([fondoExcel(6419, 969.565)]);
  assert.equal(buscarFondo(datos, 9999), null);
});

test("buscarFondo: devuelve null si el valor no es numérico", () => {
  const datos = planilla([fondoExcel(6419, "sin dato")]);
  assert.equal(buscarFondo(datos, 6419), null);
});

test("buscarFondo: tolera una planilla vacía o sin listado_fondos", () => {
  assert.equal(buscarFondo({}, 6419), null);
  assert.equal(buscarFondo(null, 6419), null);
  assert.equal(buscarFondo({ listado_fondos: [] }, 6419), null);
});

test("extraerSerie: arma los puntos y descarta los días sin el fondo", () => {
  const filas = [
    { fecha: "2026-11-18", datos: planilla([fondoExcel(6419, 960.1)]) },
    { fecha: "2026-11-19", datos: planilla([fondoExcel(1234, 10.5)]) }, // el fondo no está
    { fecha: "2026-11-20", datos: planilla([fondoExcel(6419, 969.565)]) },
  ];
  const { puntos, fondo, moneda } = extraerSerie(filas, 6419);
  assert.deepEqual(puntos, [
    { fecha: "2026-11-18", valor: 960.1 },
    { fecha: "2026-11-20", valor: 969.565 },
  ]);
  assert.equal(fondo, "IOL Cash Management - Clase A");
  assert.equal(moneda, "ARS");
});

test("extraerSerie: sin datos devuelve la serie vacía", () => {
  const { puntos, fondo, moneda } = extraerSerie([], 6419);
  assert.deepEqual(puntos, []);
  assert.equal(fondo, null);
  assert.equal(moneda, null);
});

test("recortar: devuelve los últimos N puntos", () => {
  const puntos = [1, 2, 3, 4, 5].map((n) => ({ fecha: `2026-11-${String(n).padStart(2, "0")}`, valor: n }));
  assert.deepEqual(recortar(puntos, 2).map((p) => p.valor), [4, 5]);
});

test("recortar: sin límite válido devuelve todos los puntos", () => {
  const puntos = [1, 2, 3].map((n) => ({ fecha: `2026-11-${String(n).padStart(2, "0")}`, valor: n }));
  assert.equal(recortar(puntos, undefined).length, 3);
  assert.equal(recortar(puntos, 0).length, 3);
  assert.equal(recortar(puntos, -5).length, 3);
  assert.equal(recortar(puntos, "x").length, 3);
});

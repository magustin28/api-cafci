// ─────────────────────────────────────────────────────────────
// Tests del mapa de ids (lib/ids.js).
// Las funciones puras (armarMapa, enriquecerConIds) se prueban sin red ni Supabase.
// ─────────────────────────────────────────────────────────────
const test = require("node:test");
const assert = require("node:assert/strict");
const { armarMapa, enriquecerConIds } = require("../lib/ids");

// Catálogo con la forma real de /consulta-de-fondos.json (recortado).
const CATALOGO = {
  generated_at: "2026-11-20T10:00:00Z",
  total_fondos: 3,
  total_clases: 4,
  fondos: [
    {
      id: 304,
      nombre: "1810 Ahorro",
      clases: [
        { id: 308, nombre: "1810 Ahorro" },
        { id: 309, nombre: "1810 Ahorro - Clase B" },
      ],
    },
    { id: 394, nombre: "Delta Pesos", clases: [{ id: 715, nombre: "Delta Pesos" }] },
    { id: 999, nombre: "Sin clases", clases: [] },
  ],
};

test("armarMapa: idClase → idFondo con todas las clases", () => {
  const mapa = armarMapa(CATALOGO);
  assert.deepEqual(mapa, { 308: 304, 309: 304, 715: 394 });
});

test("armarMapa: tolera fondos sin clases, clases sin id y fondos sin id", () => {
  const mapa = armarMapa({
    fondos: [{ id: 1, clases: [{ id: 2 }, { nombre: "sin id" }] }, { id: 3 }, { clases: [{ id: 4 }] }],
  });
  // La clase 4 se omite: su fondo no tiene id, así que no hay a dónde linkear.
  assert.deepEqual(mapa, { 2: 1 });
});

test("armarMapa: catálogo vacío o inválido devuelve mapa vacío", () => {
  assert.deepEqual(armarMapa({}), {});
  assert.deepEqual(armarMapa(null), {});
  assert.deepEqual(armarMapa({ fondos: [] }), {});
});

// Payload slim mínimo: 2 campos para no repetir los 22.
const SLIM = {
  referencias: {},
  campos: ["cnv", "cafci"],
  listado_fondos: [
    { categoria_fondo: "Renta Fija", fondos: [[394, 308], [351, 275]] },
    { categoria_fondo: "Renta Variable", fondos: [[974, 1682]] },
  ],
};

test("enriquecerConIds: agrega idFondo al final de campos y de cada fila", () => {
  const out = enriquecerConIds(SLIM, { 308: 304, 275: 275, 1682: 1682 });
  assert.deepEqual(out.campos, ["cnv", "cafci", "idFondo"]);
  assert.deepEqual(out.listado_fondos[0].fondos, [
    [394, 308, 304],
    [351, 275, 275],
  ]);
  assert.deepEqual(out.listado_fondos[1].fondos, [[974, 1682, 1682]]);
});

test("enriquecerConIds: una clase sin mapeo queda en null", () => {
  const out = enriquecerConIds(SLIM, { 308: 304 });
  assert.deepEqual(out.listado_fondos[0].fondos[1], [351, 275, null]);
});

test("enriquecerConIds: no muta el payload original", () => {
  const copia = JSON.parse(JSON.stringify(SLIM));
  enriquecerConIds(SLIM, { 308: 304 });
  assert.deepEqual(SLIM, copia);
});

test("enriquecerConIds: sin mapa devuelve el payload tal cual", () => {
  assert.equal(enriquecerConIds(SLIM, {}), SLIM);
  assert.equal(enriquecerConIds(SLIM, null), SLIM);
});

test("enriquecerConIds: no duplica si ya está enriquecido", () => {
  const unaVez = enriquecerConIds(SLIM, { 308: 304 });
  const dosVeces = enriquecerConIds(unaVez, { 308: 304 });
  assert.equal(dosVeces, unaVez);
  assert.equal(dosVeces.campos.filter((c) => c === "idFondo").length, 1);
});

test("enriquecerConIds: sin campo cafci no puede enriquecer", () => {
  const sinCafci = { campos: ["cnv"], listado_fondos: [{ fondos: [[394]] }] };
  assert.equal(enriquecerConIds(sinCafci, { 308: 304 }), sinCafci);
});

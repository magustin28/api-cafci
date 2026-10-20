// Tests de lib/planilla.js: la clave de la fila es la FECHA REAL DEL ARCHIVO y el guardado es
// idempotente. Cubre los dos incidentes reales (corrida retrasada que cruza la medianoche y
// feriados) además de los casos crear / actualizar / sin cambios.
const test = require("node:test");
const assert = require("node:assert");
const { claveDePlanilla, guardarPlanilla } = require("../lib/planilla.js");

// Cliente Supabase falso: imita las dos cadenas que usa el helper
//   .from(t).select(x).eq(c, v).maybeSingle()   y   .from(t).upsert(fila, opciones)
function clienteFalso(filas = {}) {
  const ops = { upserts: [], selects: [] };
  return {
    filas,
    ops,
    from(tabla) {
      assert.strictEqual(tabla, "planillas_cafci");
      return {
        select(columnas) {
          ops.selects.push(columnas);
          return {
            eq(col, valor) {
              return {
                maybeSingle() {
                  const fila = filas[valor];
                  return {
                    data: fila ? { fechaArchivo: fila.datos.fechaArchivo } : null,
                    error: null,
                  };
                },
              };
            },
          };
        },
        upsert(fila, opciones) {
          ops.upserts.push({ fila, opciones });
          filas[fila.fecha] = fila;
          return { error: null };
        },
      };
    },
  };
}

const datos19 = { fechaArchivo: "19/10/26", referencias: {}, listado_fondos: [{ categoria_fondo: "X", fondos: [{ Fondo: "A" }] }] };

test("claveDePlanilla usa la fecha del archivo (DD/MM/AA y DD/MM/AAAA)", () => {
  assert.strictEqual(claveDePlanilla({ fechaArchivo: "01/04/26" }), "2026-04-01");
  assert.strictEqual(claveDePlanilla({ fechaArchivo: "19/10/2026" }), "2026-10-19");
});

test("claveDePlanilla tira error si no hay fecha de archivo", () => {
  assert.throws(() => claveDePlanilla({}), /fecha de archivo/);
  assert.throws(() => claveDePlanilla(null), /fecha de archivo/);
});

test("crea la fila cuando no existe (bajo la fecha del archivo, no la del run)", async () => {
  const sb = clienteFalso();
  const r = await guardarPlanilla(sb, datos19);
  assert.deepStrictEqual(r, { fecha: "2026-10-19", estado: "creada" });
  assert.strictEqual(sb.ops.upserts.length, 1);
  assert.strictEqual(sb.ops.upserts[0].fila.fecha, "2026-10-19");
  assert.deepStrictEqual(sb.ops.upserts[0].fila.datos, datos19);
  assert.deepStrictEqual(sb.ops.upserts[0].opciones, { onConflict: "fecha" });
});

test("no escribe nada si la fila ya existe con el mismo archivo", async () => {
  const sb = clienteFalso({ "2026-10-19": { fecha: "2026-10-19", datos: datos19 } });
  const r = await guardarPlanilla(sb, datos19);
  assert.deepStrictEqual(r, { fecha: "2026-10-19", estado: "sin cambios" });
  assert.strictEqual(sb.ops.upserts.length, 0);
});

test("actualiza la fila si CAFCI republicó el mismo día con otro archivo", async () => {
  const sb = clienteFalso({ "2026-10-19": { fecha: "2026-10-19", datos: { ...datos19, fechaArchivo: "18/10/26" } } });
  const r = await guardarPlanilla(sb, datos19);
  assert.deepStrictEqual(r, { fecha: "2026-10-19", estado: "actualizada" });
  assert.strictEqual(sb.ops.upserts.length, 1);
});

test("incidente 20/10: una corrida retrasada NO crea la fila del día siguiente", async () => {
  // Es el caso real: el 20/10 a las 03:34 corrió el workflow, con el archivo todavía en 19/10.
  const sb = clienteFalso({ "2026-10-19": { fecha: "2026-10-19", datos: datos19 } });
  const r = await guardarPlanilla(sb, datos19);
  assert.strictEqual(r.fecha, "2026-10-19"); // la fecha del archivo, no la del run (2026-10-20)
  assert.strictEqual(r.estado, "sin cambios");
  assert.strictEqual(sb.filas["2026-10-20"], undefined); // no hay ninguna fila del 20/10
});

test("feriado: el archivo del último día hábil no genera una fila nueva", async () => {
  // El 01/05 (feriado) el cron corrió y el archivo seguía siendo el del 30/04.
  const datos30 = { ...datos19, fechaArchivo: "30/04/26" };
  const sb = clienteFalso({ "2026-04-30": { fecha: "2026-04-30", datos: datos30 } });
  const r = await guardarPlanilla(sb, datos30);
  assert.strictEqual(r.fecha, "2026-04-30");
  assert.strictEqual(r.estado, "sin cambios");
  assert.strictEqual(sb.filas["2026-05-01"], undefined);
});

test("una fecha de archivo inválida no llega a guardar", async () => {
  const sb = clienteFalso();
  await assert.rejects(() => guardarPlanilla(sb, { fechaArchivo: "sin fecha" }), /Formato de fecha inválido/);
  assert.strictEqual(sb.ops.upserts.length, 0);
});

// Tests de lib/planilla.js: la clave de la fila es la FECHA REAL DEL ARCHIVO y el guardado es
// idempotente. Cubre los dos incidentes reales (corrida retrasada que cruza la medianoche y
// feriados) además de los casos crear / actualizar / sin cambios.
const test = require("node:test");
const assert = require("node:assert");
const { claveDePlanilla, guardarPlanilla, resolverFechaArchivo } = require("../lib/planilla.js");
const { fechaDelNombre } = require("../lib/leerExcel.js");

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

// ── Nombre del archivo ────────────────────────────────────────────────────────
// CAFCI no acepta parámetros de fecha: sólo publica la última planilla, pero la respuesta trae el
// nombre real del archivo (20261019_Planilla_Diaria_A.xlsx) en Content-Disposition. Es la única
// pista de fecha aparte de E12 y se usa para verificarla (y para no perder un archivo sin E12).

test("fechaDelNombre lee la fecha del nombre del archivo de CAFCI", () => {
  assert.strictEqual(fechaDelNombre('attachment; filename="20261019_Planilla_Diaria_A.xlsx"'), "19/10/2026");
  assert.strictEqual(fechaDelNombre("20260102_Planilla_Diaria_A.xlsx"), "02/01/2026");
});

test("fechaDelNombre devuelve null si no hay una fecha válida", () => {
  assert.strictEqual(fechaDelNombre("Planilla_Diaria_A.xlsx"), null);
  assert.strictEqual(fechaDelNombre("99999999_Planilla.xlsx"), null); // mes y día imposibles
  assert.strictEqual(fechaDelNombre(null), null);
  assert.strictEqual(fechaDelNombre(undefined), null);
});

test("resolverFechaArchivo no avisa si el nombre coincide con E12", () => {
  const r = resolverFechaArchivo({ fechaArchivo: "19/10/26" }, 'attachment; filename="20261019_Planilla_Diaria_A.xlsx"');
  assert.deepStrictEqual(r, { fechaArchivo: "19/10/26", aviso: null });
});

test("resolverFechaArchivo avisa si el nombre y E12 no coinciden (y usa E12)", () => {
  const r = resolverFechaArchivo({ fechaArchivo: "19/10/26" }, "20261020_Planilla_Diaria_A.xlsx");
  assert.strictEqual(r.fechaArchivo, "19/10/26");
  assert.match(r.aviso, /se usa E12/);
});

test("resolverFechaArchivo completa la fecha con el nombre si E12 viene vacío", () => {
  const r = resolverFechaArchivo({ fechaArchivo: null }, "20261019_Planilla_Diaria_A.xlsx");
  assert.strictEqual(r.fechaArchivo, "19/10/2026");
  assert.match(r.aviso, /E12 vacío/);
});

test("resolverFechaArchivo tira error si no hay ninguna fecha disponible", () => {
  assert.throws(() => resolverFechaArchivo({ fechaArchivo: null }, "planilla.xlsx"), /no trae la fecha del archivo/);
  assert.throws(() => resolverFechaArchivo(null, null), /no trae la fecha del archivo/);
});

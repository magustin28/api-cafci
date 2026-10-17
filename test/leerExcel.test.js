// ─────────────────────────────────────────────────────────────
//  Tests del parser compartido (lib/leerExcel.js).
//  Correr:  npm test        (runner de Node, sin dependencias nuevas)
//
//  El Excel de prueba se genera EN MEMORIA con la propia librería `xlsx`,
//  replicando la estructura del archivo diario de CAFCI:
//    fila  8 (índice  7) → encabezados de grupo
//    fila  9 (índice  8) → sub-encabezados ("Actual" y las fechas de referencia)
//    fila 12 (índice 11) → E12 = fecha del archivo
//    fila 13 en adelante → categoría (fila de un solo valor) y luego sus fondos
// ─────────────────────────────────────────────────────────────
const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const { leerExcel, fechaHoy, convertirFecha, validarPlanilla } = require("../lib/leerExcel");

// Valores reales de los sub-encabezados (fila 9 del Excel de CAFCI)
const REF_VALOR = "13/10/26";     // G9 → referencias.valor_fecha_anterior
const REF_VAR1  = "30/09/26";     // J9 → referencias.variacion_fecha1
const REF_VAR2  = "30/12/25";     // K9 → referencias.variacion_fecha2
const REF_VAR3  = "30/09/25";     // L9 → referencias.variacion_fecha3
const REF_PATR  = "13/10/26";     // P9 → referencias.patrimonio_fecha_anterior
const FECHA_ARCHIVO = "16/10/26"; // E12

const COL = {
  FONDO: 0, CNV: 1, MONEDA: 2, CLASIF: 3, CODMON: 4, REGION: 5,
  VALOR_ANT: 6, VALOR_ACT: 7, VAR1: 9, VAR2: 10, VAR3: 11,
  PATR_ANT: 15, PATR_ACT: 16,
};

// Fila de fondo con los campos que usa el dashboard (el resto queda vacío)
function filaFondo(nombre, cnv, clasif, valor, var1, patrimonio) {
  const f = [];
  f[COL.FONDO] = nombre;
  f[COL.CNV] = cnv;
  f[COL.MONEDA] = "ARS";
  f[COL.CLASIF] = clasif;
  f[COL.CODMON] = 1;
  f[COL.REGION] = "Arg";
  f[COL.VALOR_ANT] = valor;
  f[COL.VALOR_ACT] = 1094.438;
  f[COL.VAR1] = var1;
  f[COL.VAR2] = 0.5;
  f[COL.VAR3] = 1.25;
  f[COL.PATR_ANT] = patrimonio - 1000;
  f[COL.PATR_ACT] = patrimonio;
  return f;
}

// Excel mínimo (en memoria) con la misma forma que el de CAFCI
function excelDePrueba() {
  const filas = [];
  // filas 1..7: título y notas de la planilla. En el archivo real NO están vacías (si el
  // fixture las dejara vacías, xlsx recortaría el rango de la hoja y todo quedaría
  // desplazado: el parser lee posiciones fijas).
  const TITULOS = [
    "FONDOS COMUNES DE INVERSION - Planilla diaria",
    "Cuotapartes, patrimonio y variaciones",
    "Información de referencia",
    "Elaborado por CAFCI",
    "Uso informativo",
    "Valores en miles de cuotapartes",
    "Ver advertencia al pie",
  ];
  for (const t of TITULOS) filas.push([t]);

  // fila 8: encabezados de grupo. TIENE QUE QUEDAR DENSA (un valor en cada columna que
  // abarca el grupo): sheet_to_json devuelve arrays con HUECOS en las celdas vacías y el
  // parser arma los nombres con encabezado1.map(...) — y map/forEach SALTEAN los huecos.
  // En el archivo real cada grupo se repite a lo ancho de sus columnas, por eso funciona.
  const h1 = [];
  h1[COL.FONDO] = "Fondo";
  h1[COL.CNV] = "Código CNV";
  h1[COL.MONEDA] = "Moneda Fondo";
  h1[COL.CLASIF] = "Código de Clasificación";
  h1[COL.CODMON] = "Código de Moneda";
  h1[COL.REGION] = "Clasificación_Región";
  for (let i = COL.VALOR_ANT; i <= COL.VALOR_ACT + 1; i++) h1[i] = "Valor (mil cuotapartes)";
  for (let i = COL.VAR1; i <= COL.VAR3 + 3; i++) h1[i] = "Variacion cuotaparte %";
  for (let i = COL.PATR_ANT; i <= COL.PATR_ACT; i++) h1[i] = "Patrimonio";
  filas.push(h1);

  const h2 = [];                              // fila 9: sub-encabezados
  h2[COL.VALOR_ANT] = REF_VALOR;
  h2[COL.VALOR_ACT] = "Actual";
  h2[COL.VAR1] = REF_VAR1;
  h2[COL.VAR2] = REF_VAR2;
  h2[COL.VAR3] = REF_VAR3;
  h2[COL.PATR_ANT] = REF_PATR;
  h2[COL.PATR_ACT] = "Actual";
  filas.push(h2);

  filas.push([]);                             // fila 10
  filas.push([]);                             // fila 11
  const filaFecha = [];                       // fila 12: E12 = fecha del archivo
  filaFecha[0] = "Fecha de la planilla";
  filaFecha[4] = FECHA_ARCHIVO;
  filas.push(filaFecha);

  filas.push(["Renta Fija Peso Argentina"]);  // fila 13: categoría
  filas.push(filaFondo("Fondo Uno - Clase A", 1901, 2, 1000.5, 0.125, 790407962));
  filas.push(filaFondo("Fondo Dos - Clase B", 1902, 2, 2000.25, -0.5, 12345678.9));

  filas.push(['Advertencia: "Los rendimientos atribuidos..."']); // fila 16: leyenda
  filas.push(["Mercado de Dinero Peso Argentina"]);              // fila 17: categoría
  filas.push(filaFondo("Fondo Tres - Clase A", 1903, 3, 3000.75, 1.5, 5000000));

  const filaSinNombre = [];                   // fila 19: datos pero SIN nombre de fondo
  filaSinNombre[COL.CNV] = 9999;
  filaSinNombre[COL.MONEDA] = "ARS";
  filaSinNombre[COL.CLASIF] = 2;
  filas.push(filaSinNombre);

  const hoja = XLSX.utils.aoa_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, hoja, "Hoja1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// Claves que consume el dashboard (deben existir en cada fila de fondo)
const CAMPOS_ESPERADOS = [
  "Fondo",
  "Código CNV",
  "Moneda Fondo",
  "Código de Clasificación",
  "Código de Moneda",
  "Clasificación_Región",
  "Valor (mil cuotapartes)_Actual",
  `Valor (mil cuotapartes)_${REF_VALOR}`,
  `Variacion cuotaparte %_${REF_VAR1}`,
  `Variacion cuotaparte %_${REF_VAR2}`,
  `Variacion cuotaparte %_${REF_VAR3}`,
  "Patrimonio_Actual",
  `Patrimonio_${REF_PATR}`,
];

test("leerExcel: lee la fecha del archivo, las referencias, las categorías y sus fondos", () => {
  const res = leerExcel(excelDePrueba());

  assert.equal(res.fechaArchivo, FECHA_ARCHIVO);
  assert.deepEqual(res.referencias, {
    valor_fecha_anterior: REF_VALOR,
    variacion_fecha1: REF_VAR1,
    variacion_fecha2: REF_VAR2,
    variacion_fecha3: REF_VAR3,
    patrimonio_fecha_anterior: REF_PATR,
  });

  assert.deepEqual(
    res.listado_fondos.map((c) => c.categoria_fondo),
    ["Renta Fija Peso Argentina", "Mercado de Dinero Peso Argentina"]
  );
  assert.deepEqual(res.listado_fondos.map((c) => c.fondos.length), [2, 1]);
});

test("leerExcel: descarta las leyendas y las categorías sin fondos", () => {
  const res = leerExcel(excelDePrueba());
  const nombres = res.listado_fondos.map((c) => c.categoria_fondo);

  // La fila de leyenda, la de la fecha (E12) y cualquier categoría vacía no deben quedar
  assert.equal(nombres.some((n) => /advertencia/i.test(n)), false, "quedó la leyenda");
  assert.equal(nombres.includes(FECHA_ARCHIVO), false, "quedó la fila de la fecha");
  assert.equal(nombres.includes("undefined"), false, "quedó una categoría sin nombre");
  assert.equal(res.listado_fondos.every((c) => c.fondos.length > 0), true, "hay categorías vacías");
});

test("leerExcel: ignora las filas con datos pero sin nombre de fondo", () => {
  const res = leerExcel(excelDePrueba());
  const total = res.listado_fondos.reduce((s, c) => s + c.fondos.length, 0);
  assert.equal(total, 3, "2 de Renta Fija + 1 de Mercado de Dinero (la fila sin nombre se ignora)");
});

test("leerExcel: combina el grupo con el sub-encabezado para armar la clave de cada columna", () => {
  const res = leerExcel(excelDePrueba());
  const f = res.listado_fondos[0].fondos[0];

  for (const campo of CAMPOS_ESPERADOS) {
    assert.ok(campo in f, `falta el campo "${campo}"`);
  }
  assert.equal(f["Fondo"], "Fondo Uno - Clase A");
  assert.equal(f["Código CNV"], 1901);
  assert.equal(f["Código de Clasificación"], 2);
  assert.equal(f["Código de Moneda"], 1);
  assert.equal(f["Clasificación_Región"], "Arg");
  assert.equal(f[`Valor (mil cuotapartes)_${REF_VALOR}`], 1000.5);
  assert.equal(f["Valor (mil cuotapartes)_Actual"], 1094.438);
  assert.equal(f[`Variacion cuotaparte %_${REF_VAR1}`], 0.125);
  assert.equal(f[`Variacion cuotaparte %_${REF_VAR2}`], 0.5);
  assert.equal(f[`Variacion cuotaparte %_${REF_VAR3}`], 1.25);
  assert.equal(f[`Patrimonio_${REF_PATR}`], 790406962);
  assert.equal(f["Patrimonio_Actual"], 790407962);
});

test("convertirFecha: convierte DD/MM/AA y DD/MM/AAAA a YYYY-MM-DD", () => {
  assert.equal(convertirFecha("14/10/26"), "2026-10-14");
  assert.equal(convertirFecha("01/02/2026"), "2026-02-01");
  assert.equal(convertirFecha("1/2/26"), "2026-02-01");
});

test("convertirFecha: formato inválido → error", () => {
  assert.throws(() => convertirFecha("14-10-2026"), /Formato de fecha inválido/);
  assert.throws(() => convertirFecha("16/10"), /Formato de fecha inválido/);
  assert.throws(() => convertirFecha("cualquiera"), /Formato de fecha inválido/);
});

test("fechaHoy: devuelve YYYY-MM-DD", () => {
  assert.match(fechaHoy(), /^\d{4}-\d{2}-\d{2}$/);
});

test("fechaHoy: usa la fecha de Argentina, no la de UTC", (t) => {
  // 01:00 UTC del 17/10 es 22:00 del 16/10 en Argentina (UTC-3): el día cambia
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-17T01:00:00Z") });
  assert.equal(fechaHoy(), "2026-10-16");
  t.mock.timers.setTime(Date.parse("2026-10-17T03:00:00Z")); // 00:00 del 17 en Argentina
  assert.equal(fechaHoy(), "2026-10-17");
  t.mock.timers.reset();
});

// Planilla mínima válida: 4 fondos en 2 categorías
const PLANILLA_OK = {
  fechaArchivo: "16/10/26",
  listado_fondos: [
    { categoria_fondo: "Renta Fija", fondos: [{}, {}, {}] },
    { categoria_fondo: "Mercado de Dinero", fondos: [{}] },
  ],
};

test("validarPlanilla: acepta una planilla con datos y devuelve el total de fondos", () => {
  assert.equal(validarPlanilla(PLANILLA_OK, 4), 4);
  assert.equal(validarPlanilla(PLANILLA_OK, 1), 4);
});

test("validarPlanilla: rechaza si falta la fecha del archivo (celda E12)", () => {
  assert.throws(
    () => validarPlanilla({ ...PLANILLA_OK, fechaArchivo: null }, 1),
    /no trae la fecha del archivo/
  );
});

test("validarPlanilla: rechaza si no hay categorías", () => {
  assert.throws(
    () => validarPlanilla({ fechaArchivo: "16/10/26", listado_fondos: [] }, 1),
    /no tiene categorías/
  );
});

test("validarPlanilla: rechaza si hay categorías pero ningún fondo", () => {
  const sinFondos = { fechaArchivo: "16/10/26", listado_fondos: [{ categoria_fondo: "X", fondos: [] }] };
  assert.throws(() => validarPlanilla(sinFondos, 1), /Planilla sospechosa/);
});

test("validarPlanilla: rechaza una planilla incompleta (menos fondos que el mínimo)", () => {
  assert.throws(() => validarPlanilla(PLANILLA_OK, 5), /Planilla sospechosa: 4 fondos en 2 categorías/);
});

test("validarPlanilla: el mínimo por argumento tiene prioridad sobre MIN_FONDOS", (t) => {
  const previo = process.env.MIN_FONDOS;
  process.env.MIN_FONDOS = "1";
  t.after(() => {
    if (previo === undefined) delete process.env.MIN_FONDOS;
    else process.env.MIN_FONDOS = previo;
  });
  assert.equal(validarPlanilla(PLANILLA_OK, 3), 4); // el argumento (3) gana sobre el env (1)
  assert.throws(() => validarPlanilla(PLANILLA_OK, 10), /mínimo exigido: 10/);
});

test("validarPlanilla: usa MIN_FONDOS del entorno cuando no se pasa mínimo", (t) => {
  const previo = process.env.MIN_FONDOS;
  process.env.MIN_FONDOS = "2";
  t.after(() => {
    if (previo === undefined) delete process.env.MIN_FONDOS;
    else process.env.MIN_FONDOS = previo;
  });
  assert.equal(validarPlanilla(PLANILLA_OK), 4);
  process.env.MIN_FONDOS = "50";
  assert.throws(() => validarPlanilla(PLANILLA_OK), /mínimo exigido: 50/);
});

test("validarPlanilla: sin argumento ni MIN_FONDOS exige 1000 (default de producción)", (t) => {
  const previo = process.env.MIN_FONDOS;
  delete process.env.MIN_FONDOS;
  t.after(() => {
    if (previo !== undefined) process.env.MIN_FONDOS = previo;
  });
  assert.throws(() => validarPlanilla(PLANILLA_OK), /mínimo exigido: 1000/);
});



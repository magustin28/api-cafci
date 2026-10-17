// ─────────────────────────────────────────────────────────────
//  Parser de la planilla diaria de CAFCI.
//  Antes estaba duplicado en server.js, descargar.js y cargar-historico.js.
//  Lo usan los tres (este último también `convertirFecha`).
// ─────────────────────────────────────────────────────────────
const XLSX = require("xlsx");

// Fecha de hoy en Argentina como YYYY-MM-DD
function fechaHoy() {
  return new Date().toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).split("/").reverse().join("-");
}

// "DD/MM/YY" o "DD/MM/AAAA" → "AAAA-MM-DD" (tira error si el formato no es válido)
function convertirFecha(fechaExcel) {
  const partes = fechaExcel.toString().split("/");
  if (partes.length !== 3) throw new Error(`Formato de fecha inválido: ${fechaExcel}`);
  const [dia, mes, anio] = partes;
  const anioCompleto = anio.length === 2 ? `20${anio}` : anio;
  return `${anioCompleto}-${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`;
}

function leerExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const hoja = workbook.Sheets[workbook.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1 });

  // Fila 9 (índice 8): sub-encabezados con fechas de referencia
  const filaRefs = filas[8];

  // G9=6, J9=9, K9=10, L9=11, P9=15
  const referencias = {
    valor_fecha_anterior:      filaRefs[6]  || null,
    variacion_fecha1:          filaRefs[9]  || null,
    variacion_fecha2:          filaRefs[10] || null,
    variacion_fecha3:          filaRefs[11] || null,
    patrimonio_fecha_anterior: filaRefs[15] || null,
  };

  // Fecha del archivo desde E12 (fila índice 11, columna índice 4)
  const fechaArchivo = filas[11] && filas[11][4] ? filas[11][4] : null;

  // Encabezados en filas 8 y 9 (índice 7 y 8)
  const encabezado1 = filas[7];
  const encabezado2 = filas[8];

  let grupoActual = "";
  const columnas = encabezado1.map((col, i) => {
    if (col && col.toString().trim() !== "") {
      grupoActual = col.toString().trim();
    }
    const sub = encabezado2[i];
    if (sub && sub.toString().trim() !== "") {
      return `${grupoActual}_${sub.toString().trim()}`;
    }
    return grupoActual;
  });

  const listado_fondos = [];
  let categoriaActual = null;

  for (let i = 10; i < filas.length; i++) {
    const fila = filas[i];
    if (!fila || fila.length === 0) continue;

    const valoresNoVacios = fila.filter((v) => v !== undefined && v !== "");
    if (valoresNoVacios.length === 1) {
      // Fila con un solo valor: encabeza una categoría nueva
      categoriaActual = { categoria_fondo: String(fila[0]).trim(), fondos: [] };
      listado_fondos.push(categoriaActual);
      continue;
    }

    if (!categoriaActual) continue;

    const fondo = {};
    columnas.forEach((col, idx) => {
      if (col) fondo[col] = fila[idx] ?? null;
    });

    // Sólo aceptamos filas que tengan nombre de fondo: descarta leyendas y filas sueltas
    const nombre = fondo["Fondo"];
    if (typeof nombre !== "string" || nombre.trim() === "") continue;

    categoriaActual.fondos.push(fondo);
  }

  // Las leyendas del Excel (advertencias, notas al pie, "(*) Determinación…") quedan como
  // categorías SIN fondos. No aportan datos y ensucian la respuesta: no las guardamos.
  return {
    fechaArchivo,
    referencias,
    listado_fondos: listado_fondos.filter((c) => c.fondos.length > 0),
  };
}

// Valida que la planilla tenga sentido ANTES de guardarla: evita guardar un archivo vacío o
// incompleto (p. ej. si CAFCI publica una planilla a medio generar). Tira error con el motivo.
function validarPlanilla({ fechaArchivo, listado_fondos }, minimo) {
  const min = Number(minimo || process.env.MIN_FONDOS || 1000);
  if (!fechaArchivo) throw new Error("El Excel no trae la fecha del archivo (celda E12)");
  if (!Array.isArray(listado_fondos) || listado_fondos.length === 0) {
    throw new Error("El Excel no tiene categorías");
  }
  const total = listado_fondos.reduce((s, c) => s + c.fondos.length, 0);
  if (total < min) {
    throw new Error(`Planilla sospechosa: ${total} fondos en ${listado_fondos.length} categorías (mínimo exigido: ${min}). No se guarda.`);
  }
  return total;
}

module.exports = { leerExcel, fechaHoy, convertirFecha, validarPlanilla };

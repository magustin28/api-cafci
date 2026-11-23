// ─────────────────────────────────────────────────────────────
//  Serie histórica de un fondo (GET /api/serie/:cafci).
//
//  Dos caminos, misma respuesta:
//   1. La función RPC `serie_fondo` en Supabase (recomendado: la hace
//      Postgres y devuelve solo las filas de la serie).
//   2. El fallback de este módulo: recorre el JSONB de las planillas en
//      memoria. Sirve cuando la RPC todavía no se corrió, y es lo que
//      testean los tests unitarios.
//
//  El identificador es el CÓDIGO CAFCI (número), no el nombre: el nombre
//  puede cambiar entre planillas y el código no.
// ─────────────────────────────────────────────────────────────

// Claves del JSONB guardado (las del Excel completo, ver lib/leerExcel.js).
const CLAVE_CAFCI = "Código CAFCI";
const CLAVE_VALOR = "Valor (mil cuotapartes)_Actual";
const CLAVE_FONDO = "Fondo";
const CLAVE_MONEDA = "Moneda Fondo";

// Código CAFCI válido: entero positivo. Cualquier otra cosa (null, texto,
// decimal, negativo) se rechaza para no confundir fondos distintos.
function normalizarCafci(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Busca un fondo por código CAFCI dentro de `datos.listado_fondos`.
// Devuelve { valor, fondo, moneda } o null si no está en esa planilla.
function buscarFondo(datos, cafci) {
  const objetivo = normalizarCafci(cafci);
  if (objetivo === null) return null;

  for (const categoria of datos?.listado_fondos || []) {
    for (const fondo of categoria?.fondos || []) {
      if (normalizarCafci(fondo?.[CLAVE_CAFCI]) !== objetivo) continue;
      const valor = Number(fondo[CLAVE_VALOR]);
      if (!Number.isFinite(valor)) return null;
      return {
        valor,
        fondo: fondo[CLAVE_FONDO] ?? null,
        moneda: fondo[CLAVE_MONEDA] ?? null,
      };
    }
  }
  return null;
}

// Arma la serie a partir de las filas de planillas_cafci: [{ fecha, datos }].
// Descarta los días en los que el fondo no aparece o el valor no es numérico.
// Devuelve { puntos: [{ fecha, valor }], fondo, moneda }.
function extraerSerie(filas, cafci) {
  const puntos = [];
  let fondo = null;
  let moneda = null;

  for (const fila of filas || []) {
    const encontrado = buscarFondo(fila?.datos, cafci);
    if (!encontrado) continue;
    puntos.push({ fecha: fila.fecha, valor: encontrado.valor });
    fondo = encontrado.fondo ?? fondo;
    moneda = encontrado.moneda ?? moneda;
  }

  return { puntos, fondo, moneda };
}

// Corta los últimos N puntos (el rango se pide desde el final: "últimos 30 días").
function recortar(puntos, limite) {
  const n = Number(limite);
  if (!Number.isInteger(n) || n <= 0) return puntos;
  return puntos.slice(-n);
}

module.exports = { CLAVE_CAFCI, CLAVE_VALOR, CLAVE_FONDO, CLAVE_MONEDA, normalizarCafci, buscarFondo, extraerSerie, recortar };

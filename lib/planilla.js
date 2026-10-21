// ─────────────────────────────────────────────────────────────
//  Clave y guardado de una planilla.
//
//  La fila se guarda con la FECHA REAL DEL ARCHIVO (datos.fechaArchivo), no con la fecha del run.
//  CAFCI publica los cierres a la noche: si el proceso corre más tarde (o si es feriado, o si no
//  hubo operatoria), el archivo TODAVÍA trae la planilla del día anterior. Usando `fechaHoy()`
//  como clave eso generaba filas con datos viejos:
//   - el 20/10/2026 el cron externo de GitHub Actions corrió 5 h tarde (ya pasado el cambio de
//     día) y quedó una fila 2026-10-20 con la planilla del 19/10;
//   - en los feriados (7 casos desde abril) el cron de lun-vie guardó el último archivo
//     disponible bajo la fecha del feriado;
//   - y encima el chequeo "ya existe la planilla de hoy" BLOQUEABA la descarga real de ese día.
//
//  Con la fecha del archivo:
//   - cada planilla cae siempre en su propio día;
//   - volver a correr la descarga es inofensivo (idempotente): si nada cambió, no escribe;
//   - un feriado no crea una fila nueva (actualiza la del último día hábil);
//   - una corrida retrasada no puede etiquetar datos viejos con la fecha de hoy.
//
//  Lo comparten server.js (Render) y los scripts locales descargar.js / cargar-historico.js.
// ─────────────────────────────────────────────────────────────
const { convertirFecha, fechaDelNombre } = require("./leerExcel");

// Fecha (AAAA-MM-DD) con la que se guarda la planilla: la que declara el propio archivo de CAFCI.
function claveDePlanilla(datos) {
  if (!datos || !datos.fechaArchivo) {
    throw new Error("La planilla no trae fecha de archivo (datos.fechaArchivo)");
  }
  return convertirFecha(datos.fechaArchivo);
}

// Guarda la planilla bajo su fecha real.
//   - no existe la fila            → la crea
//   - existe con otro fechaArchivo → la actualiza (CAFCI republicó/corrigió ese día)
//   - existe con el mismo          → no escribe nada
// Devuelve { fecha, estado: "creada" | "actualizada" | "sin cambios" }.
async function guardarPlanilla(supabase, datos) {
  const fecha = claveDePlanilla(datos);

  const { data: existente, error: errorSelect } = await supabase
    .from("planillas_cafci")
    .select("fechaArchivo:datos->>fechaArchivo")
    .eq("fecha", fecha)
    .maybeSingle();

  if (errorSelect) throw errorSelect;

  if (existente && existente.fechaArchivo === datos.fechaArchivo) {
    return { fecha, estado: "sin cambios" };
  }

  const { error } = await supabase
    .from("planillas_cafci")
    .upsert({ fecha, datos }, { onConflict: "fecha" });

  if (error) throw error;

  return { fecha, estado: existente ? "actualizada" : "creada" };
}

// La fecha de la planilla sale de la celda E12 (lo que CAFCI declara ADENTRO del archivo).
// El nombre del archivo (Content-Disposition en la respuesta de la API, o el nombre del .xlsx
// guardado a mano) es la única otra pista de fecha que existe: CAFCI NO acepta parámetros de
// fecha, sólo publica la última planilla (ver README, "Recarga histórica"). Se usa para:
//   - completar la fecha si E12 viniera vacío (antes eso abortaba la carga del día);
//   - avisar si no coinciden, que es la señal de un archivo mal etiquetado o de un archivo viejo.
// E12 manda siempre. Devuelve { fechaArchivo, aviso } (aviso = null si todo está en orden).
function resolverFechaArchivo(datos, nombre) {
  const delNombre = fechaDelNombre(nombre);

  if (!datos || !datos.fechaArchivo) {
    if (!delNombre) {
      throw new Error("El Excel no trae la fecha del archivo (celda E12) y el nombre tampoco la tiene");
    }
    return { fechaArchivo: delNombre, aviso: `E12 vacío: se usó la fecha del nombre del archivo (${delNombre})` };
  }

  if (delNombre && convertirFecha(datos.fechaArchivo) !== convertirFecha(delNombre)) {
    return {
      fechaArchivo: datos.fechaArchivo,
      aviso: `El nombre del archivo dice ${delNombre} y E12 dice ${datos.fechaArchivo}: se usa E12, revisar si CAFCI publicó un archivo mal etiquetado`,
    };
  }

  return { fechaArchivo: datos.fechaArchivo, aviso: null };
}

module.exports = { claveDePlanilla, guardarPlanilla, resolverFechaArchivo };

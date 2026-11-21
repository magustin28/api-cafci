// ─────────────────────────────────────────────────────────────
// Mapa idClase → idFondo de CAFCI, para el link "ver ficha" del dashboard.
//
// La ficha del sitio de estadísticas se arma con DOS ids:
//   https://estadisticas.cafci.org.ar/fondos/{idFondo}?clase={idClase}
// El idClase es el "Código CAFCI" de la planilla (campo `cafci` del slim). El idFondo NO
// viene en el Excel: sale del catálogo público del sitio
// (https://estadisticas.cafci.org.ar/consulta-de-fondos.json).
//
// Ese catálogo se baja con ETag: si no cambió, responde 304 y no se gasta ancho de banda.
// El mapa se guarda en Supabase (tabla `cafci_ids`, UNA sola fila: se reemplaza, no se
// acumula) y se cachea en memoria para no leer la base en cada request.
//
// Se refresca junto con la descarga diaria (server.js) y a demanda con
// POST /api/ids/refrescar. No corre por cron propio: la planilla se publica una vez al día.
// ─────────────────────────────────────────────────────────────
const axios = require("axios");

const IDS_URL = "https://estadisticas.cafci.org.ar/consulta-de-fondos.json";
// El sitio bloquea con 403 los requests sin User-Agent de navegador.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FILA = "mapa"; // clave fija de la única fila de cafci_ids

// Cache en memoria: { mapa, etag, generated_at, actualizado }
let cache = null;
// Si la tabla todavía no existe o Supabase falla, no se reintenta en cada request: se espera
// un minuto. Evita llenar los logs cuando la migración de cafci_ids no se corrió todavía.
let ultimoFallo = 0;
const ESPERA_FALLO = 60 * 1000;

// Arma { "308": 304, ... } recorriendo el catálogo. Puro: se testea sin red.
function armarMapa(catalogo) {
  const mapa = {};
  for (const fondo of catalogo?.fondos || []) {
    if (fondo?.id == null) continue;
    for (const clase of fondo.clases || []) {
      if (clase?.id == null) continue;
      mapa[String(clase.id)] = fondo.id;
    }
  }
  return mapa;
}

// Agrega `idFondo` al final de `campos` y de cada fila del payload slim. Puro.
// Si no hay mapa, no hay campo `cafci` o ya está enriquecido, devuelve el payload tal cual.
function enriquecerConIds(datos, mapa) {
  if (!datos?.campos || !datos.listado_fondos || !mapa || !Object.keys(mapa).length) return datos;
  if (datos.campos.includes("idFondo")) return datos;
  const iCafci = datos.campos.indexOf("cafci");
  if (iCafci < 0) return datos;

  const campos = [...datos.campos, "idFondo"];
  const listado_fondos = datos.listado_fondos.map((cat) => ({
    ...cat,
    fondos: (cat.fondos || []).map((f) => [...f, mapa[String(f[iCafci])] ?? null]),
  }));
  return { ...datos, campos, listado_fondos };
}

async function leerFila(supabase) {
  const { data, error } = await supabase.from("cafci_ids").select("*").eq("id", FILA).maybeSingle();
  if (error) throw error;
  return data;
}

// Devuelve el mapa: memoria → Supabase → {} (sin tirar).
async function obtenerMapa(supabase) {
  if (cache) return cache.mapa;
  if (Date.now() - ultimoFallo < ESPERA_FALLO) return {};
  try {
    const fila = await leerFila(supabase);
    if (fila) {
      cache = { mapa: fila.mapa || {}, etag: fila.etag, generated_at: fila.generated_at, actualizado: fila.actualizado };
      return cache.mapa;
    }
    // Sin fila: el mapa todavía no se refrescó. Se espera un minuto antes de volver a consultar.
    ultimoFallo = Date.now();
  } catch (error) {
    ultimoFallo = Date.now();
    console.warn("ids: no se pudo leer el mapa de Supabase:", error.message);
  }
  return {};
}

// Baja el catálogo y actualiza el mapa. Nunca tira: devuelve { ok, estado, ... }.
async function refrescarIds(supabase, { forzar = false } = {}) {
  try {
    const guardado = cache || (await leerFila(supabase));
    const headers = { "User-Agent": UA, Accept: "application/json" };
    if (guardado?.etag && !forzar) headers["If-None-Match"] = guardado.etag;

    const res = await axios.get(IDS_URL, { headers, timeout: 60 * 1000, validateStatus: () => true });

    if (res.status === 304) {
      if (guardado) cache = { ...guardado };
      return { ok: true, estado: "sin cambios", total: cache ? Object.keys(cache.mapa).length : 0 };
    }
    if (res.status !== 200) {
      return { ok: false, estado: "error", error: `HTTP ${res.status} al bajar el catálogo de CAFCI` };
    }

    const mapa = armarMapa(res.data);
    const total = Object.keys(mapa).length;
    if (!total) return { ok: false, estado: "error", error: "El catálogo de CAFCI vino sin clases" };

    const fila = {
      id: FILA,
      mapa,
      etag: res.headers.etag || null,
      generated_at: res.data.generated_at || null,
      total_fondos: res.data.total_fondos ?? null,
      total_clases: res.data.total_clases ?? null,
      actualizado: new Date().toISOString(),
    };
    const { error } = await supabase.from("cafci_ids").upsert(fila, { onConflict: "id" });
    if (error) throw error;

    cache = fila;
    return { ok: true, estado: "actualizado", total, total_fondos: fila.total_fondos, total_clases: fila.total_clases };
  } catch (error) {
    return { ok: false, estado: "error", error: error.message };
  }
}

// Sólo para tests: limpia la cache en memoria.
function limpiarCache() {
  cache = null;
}

module.exports = { IDS_URL, armarMapa, enriquecerConIds, obtenerMapa, refrescarIds, limpiarCache };

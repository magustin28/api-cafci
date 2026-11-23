require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { leerExcel, fechaHoy, validarPlanilla } = require("./lib/leerExcel");
const { claveDePlanilla, guardarPlanilla, resolverFechaArchivo } = require("./lib/planilla");
const { slimear } = require("./lib/slim");
const { refrescarIds, obtenerMapa, enriquecerConIds } = require("./lib/ids");
const { normalizarCafci, extraerSerie, recortar } = require("./lib/serie");
const pkg = require("./package.json");

const startedAt = new Date();

const app = express();
app.use(cors());

const EXCEL_URL = "https://api.pub.cafci.org.ar/pb_get";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Un intento de descarga. Nunca tira: devuelve { ok, ... } para que lo puedan usar
// tanto el cron interno (con reintentos) como el endpoint POST /api/descargar.
//
// La fila se guarda bajo la FECHA REAL DEL ARCHIVO (lib/planilla), no bajo la fecha del run:
// una corrida retrasada (el schedule de GitHub Actions puede llegar horas tarde) o un feriado
// no pueden crear filas con datos de otro día, y repetir la descarga es inofensivo.
async function descargarYGuardarUnaVez(dry = false) {
  try {
    // Sólo para los logs: la clave de la fila la define el archivo.
    const run = fechaHoy();

    console.log(`Descargando planilla CAFCI... (run del ${run})`);
    // timeout: sin él, si CAFCI deja la conexión abierta el request queda colgado indefinidamente
    // (axios no tiene timeout por defecto) y el job del cron externo también. La planilla pesa
    // ~950 KB: 60 s es holgado.
    const response = await axios.get(EXCEL_URL, { responseType: "arraybuffer", timeout: 60 * 1000 });
    const leida = leerExcel(response.data);

    // CAFCI manda el nombre real del archivo en Content-Disposition (ej. 20261019_Planilla_Diaria_A.xlsx):
    // sirve para confirmar la fecha de E12 y para completarla si viniera vacía (E12 manda siempre).
    const { fechaArchivo, aviso } = resolverFechaArchivo(leida, response.headers["content-disposition"]);
    if (aviso) console.warn("⚠️ ", aviso);

    // No se guardan planillas vacías o incompletas
    const totalFondos = validarPlanilla({ fechaArchivo, listado_fondos: leida.listado_fondos });
    const fecha = claveDePlanilla({ fechaArchivo }); // la fecha REAL de la planilla
    console.log("fecha archivo:", fechaArchivo, "→ clave:", fecha);
    console.log("categorias:", leida.listado_fondos.length, "| fondos:", totalFondos);

    const datos = { fechaArchivo, referencias: leida.referencias, listado_fondos: leida.listado_fondos };

    if (dry) {
      console.log("Modo dry: la planilla se parseó y validó, no se guarda");
      return { ok: true, dry: true, fecha, fechaArchivo, categorias: datos.listado_fondos.length, fondos: totalFondos, ...(aviso ? { aviso } : {}) };
    }

    const { estado } = await guardarPlanilla(supabase, datos);
    console.log(`Planilla ${estado} en Supabase:`, fecha);

    // El mapa de ids se refresca en el mismo run: es barato (manda el ETag, así que si el
    // catálogo no cambió CAFCI responde 304) y mantiene al día el link a la ficha de cada
    // fondo. Si falla, no rompe la descarga: el payload sale sin idFondo y el dashboard usa
    // su mapa local.
    const ids = await refrescarIds(supabase);
    if (ids.ok) console.log(`Mapa de ids: ${ids.estado} (${ids.total} clases)`);
    else console.warn("⚠️ Mapa de ids:", ids.error);

    return { ok: true, fecha, fechaArchivo, estado, ...(ids.ok ? { ids: ids.estado } : {}), categorias: datos.listado_fondos.length, fondos: totalFondos, ...(aviso ? { aviso } : {}) };
  } catch (error) {
    console.error("Error al descargar:", error.message);
    return { ok: false, fecha: fechaHoy(), error: error.message };
  }
}

// Con reintentos cada 30 minutos (lo usa el cron interno de Render)
async function descargarYGuardar(intento = 1) {
  const resultado = await descargarYGuardarUnaVez();
  if (resultado.ok) return resultado;

  if (intento < 3) {
    console.log(`Reintentando en 30 minutos... (venía del intento ${intento})`);
    setTimeout(() => descargarYGuardar(intento + 1), 30 * 60 * 1000);
  } else {
    console.error("Se agotaron los reintentos.");
  }
  return resultado;
}

// Descarga automática lunes a viernes a las 22:30hs Argentina
cron.schedule("30 22 * * 1-5", () => {
  descargarYGuardar();
}, {
  timezone: "America/Argentina/Buenos_Aires",
});

// ─────────────────────────────────────────────────────────────
// POST /api/descargar → dispara la descarga a demanda.
// Lo usa el cron externo de GitHub Actions (.github/workflows/descarga-diaria.yml)
// y sirve para pruebas manuales. Requiere: Authorization: Bearer <CRON_TOKEN>
// ─────────────────────────────────────────────────────────────
app.post("/api/descargar", async (req, res) => {
  const token = process.env.CRON_TOKEN;
  if (!token) {
    return res.status(503).json({ error: "Falta CRON_TOKEN en las variables de entorno del servicio" });
  }
  const enviado = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (enviado !== token) {
    return res.status(401).json({ error: "Token inválido" });
  }
  // ?dry=1 → descarga, parsea y valida, pero NO escribe (para probar sin riesgo)
  const dry = req.query.dry === "1" || req.query.dry === "true";
  const resultado = await descargarYGuardarUnaVez(dry);
  res.status(resultado.ok ? 200 : 502).json(resultado);
});

// Payload de una planilla. En modo slim se enriquece con idFondo (el link a la ficha de
// CAFCI necesita el id del FONDO, que no viene en el Excel: ver lib/ids). Si el mapa no está
// disponible, se devuelve el slim sin enriquecer y el dashboard usa su mapa local: una falla
// de CAFCI no debe romper la respuesta.
async function responderPlanilla(datos, slim) {
  if (!slim) {
    return { referencias: datos.referencias, listado_fondos: datos.listado_fondos };
  }
  const payload = slimear(datos);
  try {
    return enriquecerConIds(payload, await obtenerMapa(supabase));
  } catch (error) {
    console.warn("ids: no se pudo enriquecer el payload:", error.message);
    return payload;
  }
}

// Endpoint: último día disponible
app.get("/api/fondos", async (req, res) => {
  const { data, error } = await supabase
    .from("planillas_cafci")
    .select("fecha, datos")
    .order("fecha", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "Todavía no hay datos disponibles" });
  }

  // ?fields=slim (o ?slim=1) → payload liviano: los 22 campos que usa el dashboard (~15%),
  // más idFondo al final cuando el mapa de ids está disponible (lib/ids.js)
  const slim = req.query.fields === "slim" || req.query.slim === "1";
  res.json({
    fecha: data.datos.fechaArchivo || data.fecha,
    slim: slim || undefined, // en modo completo la clave no se serializa (respuesta idéntica)
    datos: await responderPlanilla(data.datos, slim),
  });
});

// Endpoint: fecha específica → /api/fondos/2026-03-01
app.get("/api/fondos/:fecha", async (req, res) => {
  const { data, error } = await supabase
    .from("planillas_cafci")
    .select("fecha, datos")
    .eq("fecha", req.params.fecha)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: `No hay datos para la fecha ${req.params.fecha}` });
  }

  const slim = req.query.fields === "slim" || req.query.slim === "1";
  res.json({
    fecha: data.datos.fechaArchivo || data.fecha,
    slim: slim || undefined,
    datos: await responderPlanilla(data.datos, slim),
  });
});

// Endpoint: listar todas las fechas disponibles
app.get("/api/fechas", async (req, res) => {
  const { data, error } = await supabase
    .from("planillas_cafci")
    .select("fecha")
    .order("fecha", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map((d) => d.fecha));
});

// ─────────────────────────────────────────────────────────────
// GET /api/serie/:cafci → serie histórica de un fondo (código CAFCI).
// Usa la función RPC `serie_fondo` (docs/sql/serie_fondo.sql): la hace
// Postgres y devuelve solo las filas de la serie. Si la función todavía no
// se corrió, cae al fallback en memoria (lib/serie.js) y avisa por consola.
// Cachea 10 min en memoria: el histórico cambia una vez al día.
// ─────────────────────────────────────────────────────────────
const SERIE_TTL_MS = 10 * 60 * 1000;
const serieCache = new Map(); // clave -> { ts, respuesta }

// La RPC no existe hasta que se corre el DDL: PostgREST responde 42883.
function esFuncionInexistente(error) {
  return error?.code === "42883" || /does not exist|no existe/i.test(error?.message || "");
}

// Arma la respuesta con el mismo formato para los dos caminos (RPC y fallback).
function armarRespuestaSerie(cafci, puntos, fondo, moneda, limite) {
  const recortados = recortar(puntos, limite);
  return {
    cafci,
    fondo,
    moneda,
    puntos: recortados,
    total: puntos.length,
    desde: recortados[0]?.fecha ?? null,
    hasta: recortados[recortados.length - 1]?.fecha ?? null,
  };
}

async function serieConRpc(cafci, limite) {
  const { data, error } = await supabase.rpc("serie_fondo", { p_cafci: cafci });
  if (error) throw error;
  const filas = data || [];
  const puntos = filas.map((f) => ({ fecha: f.fecha, valor: Number(f.valor) }));
  const ultimo = filas[filas.length - 1];
  return armarRespuestaSerie(cafci, puntos, ultimo?.fondo ?? null, ultimo?.moneda ?? null, limite);
}

// Fallback: baja todas las planillas y filtra en memoria. Es lento (cada
// planilla pesa ~880 KB), así que sólo se usa mientras falta la RPC.
async function serieConFallback(cafci, limite) {
  const { data, error } = await supabase
    .from("planillas_cafci")
    .select("fecha, datos")
    .order("fecha", { ascending: true });
  if (error) throw error;
  const { puntos, fondo, moneda } = extraerSerie(data || [], cafci);
  return armarRespuestaSerie(cafci, puntos, fondo, moneda, limite);
}

app.get("/api/serie/:cafci", async (req, res) => {
  const cafci = normalizarCafci(req.params.cafci);
  if (cafci === null) {
    return res.status(400).json({ error: "El código CAFCI debe ser un entero positivo" });
  }

  const limite = Number(req.query.limite) || null;
  const clave = `${cafci}:${limite || "todo"}`;
  const cacheado = serieCache.get(clave);
  if (cacheado && Date.now() - cacheado.ts < SERIE_TTL_MS) {
    return res.json(cacheado.respuesta);
  }

  let respuesta;
  try {
    respuesta = await serieConRpc(cafci, limite);
  } catch (error) {
    if (!esFuncionInexistente(error)) {
      return res.status(502).json({ error: "No se pudo leer la serie", detalle: error.message });
    }
    console.warn("serie: falta la función serie_fondo; se usa el fallback en memoria");
    try {
      respuesta = await serieConFallback(cafci, limite);
    } catch (errorFallback) {
      return res.status(502).json({ error: "No se pudo leer la serie", detalle: errorFallback.message });
    }
  }

  if (!respuesta.puntos.length) {
    return res.status(404).json({ error: `No hay datos para el código CAFCI ${cafci}` });
  }

  // Cache acotado: si crece demasiado, se descartan las entradas vencidas.
  if (serieCache.size > 200) {
    for (const [k, v] of serieCache) {
      if (Date.now() - v.ts >= SERIE_TTL_MS) serieCache.delete(k);
    }
  }
  serieCache.set(clave, { ts: Date.now(), respuesta });
  res.json(respuesta);
});

// ─────────────────────────────────────────────────────────────
// Mapa de ids de CAFCI (idClase → idFondo), para el link a la ficha.
// GET /api/ids → estado + mapa. POST /api/ids/refrescar → fuerza la descarga.
// ─────────────────────────────────────────────────────────────
app.get("/api/ids", async (req, res) => {
  const mapa = await obtenerMapa(supabase);
  const total = Object.keys(mapa).length;
  if (!total) return res.status(404).json({ error: "Todavía no hay mapa de ids" });
  res.json({ total, ids: mapa });
});

app.post("/api/ids/refrescar", async (req, res) => {
  const token = process.env.CRON_TOKEN;
  if (!token) {
    return res.status(503).json({ error: "Falta CRON_TOKEN en las variables de entorno del servicio" });
  }
  const enviado = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (enviado !== token) return res.status(401).json({ error: "Token inválido" });

  // ?forzar=1 ignora el ETag guardado y vuelve a bajar el catálogo completo.
  const forzar = req.query.forzar === "1" || req.query.forzar === "true";
  const resultado = await refrescarIds(supabase, { forzar });
  res.status(resultado.ok ? 200 : 502).json(resultado);
});

// ─────────────────────────────────────────────────────────────
// GET /  → información del servicio (en vez del 404 HTML de Express)
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    api: pkg.name,
    version: pkg.version,
    node: process.version,
    endpoints: ["/api/fondos", "/api/fondos/:fecha", "/api/fechas", "/api/serie/:cafci", "/api/ids", "/health", "/health/db", "POST /api/descargar", "POST /api/ids/refrescar"],
    repo: "https://github.com/magustin28/api-cafci",
  });
});

// ─────────────────────────────────────────────────────────────
// GET /health → LIVENESS. No usa red: responde siempre en < 5s.
// Es el path recomendado para Render → Settings → Health Checks.
// ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    startedAt: startedAt.toISOString(),
    node: process.version,
  });
});

// ─────────────────────────────────────────────────────────────
// GET /health/db → READINESS. Consulta real a Supabase.
// Devuelve 503 si la base no responde (útil para uptime monitors).
// NO usarlo como Health Check Path de Render: si Supabase tiene un pico
// de latencia > 5s, Render reiniciaría la instancia sin necesidad.
// ─────────────────────────────────────────────────────────────
app.get("/health/db", async (req, res) => {
  const t0 = Date.now();
  const { data, error } = await supabase
    .from("planillas_cafci")
    .select("fecha")
    .order("fecha", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return res.status(503).json({ ok: false, error: error.message });

  res.json({
    ok: true,
    ms: Date.now() - t0,
    ultimaFecha: data ? data.fecha : null,
  });
});

// 404 en JSON para cualquier ruta no definida
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API corriendo en puerto ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});

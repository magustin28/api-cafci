require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { leerExcel, fechaHoy, validarPlanilla } = require("./lib/leerExcel");
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
async function descargarYGuardarUnaVez(dry = false) {
  try {
    const fecha = fechaHoy();

    if (!dry) {
      const { data: existente } = await supabase
        .from("planillas_cafci")
        .select("id")
        .eq("fecha", fecha)
        .single();

      if (existente) {
        console.log("Ya existe la planilla de hoy:", fecha);
        return { ok: true, yaExistia: true, fecha };
      }
    }

    console.log(`Descargando planilla CAFCI... ${fecha}`);
    const response = await axios.get(EXCEL_URL, { responseType: "arraybuffer" });
    const { fechaArchivo, referencias, listado_fondos } = leerExcel(response.data);

    // No se guardan planillas vacías o incompletas
    const totalFondos = validarPlanilla({ fechaArchivo, listado_fondos });
    console.log("fecha archivo:", fechaArchivo);
    console.log("categorias:", listado_fondos.length, "| fondos:", totalFondos);

    if (dry) {
      console.log("Modo dry: la planilla se parseó y validó, no se guarda");
      return { ok: true, dry: true, fecha, fechaArchivo, categorias: listado_fondos.length, fondos: totalFondos };
    }

    const datos = { fechaArchivo, referencias, listado_fondos };

    const { error } = await supabase
      .from("planillas_cafci")
      .insert({ fecha, datos });

    if (error) throw error;
    console.log("Planilla guardada en Supabase:", fecha);
    return { ok: true, fecha, fechaArchivo, categorias: listado_fondos.length, fondos: totalFondos };
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

  res.json({
    fecha: data.datos.fechaArchivo || data.fecha,
    datos: {
      referencias: data.datos.referencias,
      listado_fondos: data.datos.listado_fondos,
    },
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

  res.json({
    fecha: data.datos.fechaArchivo || data.fecha,
    datos: {
      referencias: data.datos.referencias,
      listado_fondos: data.datos.listado_fondos,
    },
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
// GET /  → información del servicio (en vez del 404 HTML de Express)
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    api: pkg.name,
    version: pkg.version,
    node: process.version,
    endpoints: ["/api/fondos", "/api/fondos/:fecha", "/api/fechas", "/health", "/health/db", "POST /api/descargar"],
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

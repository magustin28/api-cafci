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

async function descargarYGuardar(intento = 1) {
  try {
    const fecha = fechaHoy();

    const { data: existente } = await supabase
      .from("planillas_cafci")
      .select("id")
      .eq("fecha", fecha)
      .single();

    if (existente) {
      console.log("Ya existe la planilla de hoy:", fecha);
      return;
    }

    console.log(`Descargando planilla CAFCI... ${fecha} (intento ${intento})`);
    const response = await axios.get(EXCEL_URL, { responseType: "arraybuffer" });
    const { fechaArchivo, referencias, listado_fondos } = leerExcel(response.data);

    // No se guardan planillas vacías o incompletas: si falla, tira error y dispara los reintentos
    const totalFondos = validarPlanilla({ fechaArchivo, listado_fondos });
    console.log("fecha archivo:", fechaArchivo);
    console.log("categorias:", listado_fondos.length, "| fondos:", totalFondos);

    const datos = { fechaArchivo, referencias, listado_fondos };

    const { error } = await supabase
      .from("planillas_cafci")
      .insert({ fecha, datos });

    if (error) throw error;
    console.log("Planilla guardada en Supabase:", fecha);
  } catch (error) {
    console.error(`Error al descargar (intento ${intento}):`, error.message);

    if (intento < 3) {
      console.log(`Reintentando en 30 minutos...`);
      setTimeout(() => descargarYGuardar(intento + 1), 30 * 60 * 1000);
    } else {
      console.error("Se agotaron los reintentos.");
    }
  }
}

// Descarga automática lunes a viernes a las 22:30hs Argentina
cron.schedule("30 22 * * 1-5", () => {
  descargarYGuardar();
}, {
  timezone: "America/Argentina/Buenos_Aires",
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
    endpoints: ["/api/fondos", "/api/fondos/:fecha", "/api/fechas", "/health", "/health/db"],
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

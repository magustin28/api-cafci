require("dotenv").config();
const express = require("express");
const cors = require("cors");
const XLSX = require("xlsx");
const cron = require("node-cron");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());

const EXCEL_URL = "https://api.pub.cafci.org.ar/pb_get";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function fechaHoy() {
  return new Date().toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).split("/").reverse().join("-");
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
      categoriaActual = { categoria_fondo: fila[0], fondos: [] };
      listado_fondos.push(categoriaActual);
      continue;
    }

    if (categoriaActual) {
      const fondo = {};
      columnas.forEach((col, idx) => {
        if (col) fondo[col] = fila[idx] ?? null;
      });
      categoriaActual.fondos.push(fondo);
    }
  }

  return { fechaArchivo, referencias, listado_fondos };
}

async function descargarYGuardar(intento = 1) {
  try {
    const fecha = fechaHoy();

    const { data: existente } = await supabase
      .from("PlanillasCAFCI")
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

    console.log("fecha archivo:", fechaArchivo);
    console.log("primera categoria_fondo:", listado_fondos[0].categoria_fondo);
    console.log("cantidad fondos:", listado_fondos[0].fondos.length);

    const datos = { fechaArchivo, referencias, listado_fondos };

    const { error } = await supabase
      .from("PlanillasCAFCI")
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
    .from("PlanillasCAFCI")
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
    .from("PlanillasCAFCI")
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
    .from("PlanillasCAFCI")
    .select("fecha")
    .order("fecha", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map((d) => d.fecha));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API corriendo en puerto ${PORT}`));

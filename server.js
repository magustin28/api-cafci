const express = require("express");
const cors = require("cors");
const XLSX = require("xlsx");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

const EXCEL_URL = "https://api.pub.cafci.org.ar/pb_get";
const CARPETA = path.join(__dirname, "historico");

// Crear carpeta si no existe
if (!fs.existsSync(CARPETA)) fs.mkdirSync(CARPETA);

function fechaHoy() {
  return new Date().toISOString().split("T")[0]; // "2026-02-24"
}

function leerExcel(rutaArchivo) {
  const workbook = XLSX.readFile(rutaArchivo);
  const hoja = workbook.Sheets[workbook.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1 });

  // Encabezados están en filas 8 y 9 (índice 7 y 8)
  const encabezado1 = filas[7];
  const encabezado2 = filas[8];

  // Propagar el valor del grupo cuando la celda está vacía (celdas mergeadas)
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

  const categorias = [];
  let categoriaActual = null;

  // Procesar desde la fila 11 en adelante (índice 10)
  for (let i = 10; i < filas.length; i++) {
    const fila = filas[i];
    if (!fila || fila.length === 0) continue;

    // Si la fila tiene solo un valor, es una categoría
    const valoresNoVacios = fila.filter((v) => v !== undefined && v !== "");
    if (valoresNoVacios.length === 1) {
      categoriaActual = { categoria: fila[0], fondos: [] };
      categorias.push(categoriaActual);
      continue;
    }

    // Si hay categoría activa, agregar el fondo
    if (categoriaActual) {
      const fondo = {};
      columnas.forEach((col, idx) => {
        if (col) fondo[col] = fila[idx] ?? null;
      });
      categoriaActual.fondos.push(fondo);
    }
  }

  return categorias;
}

async function descargarExcel() {
  try {
    const fecha = fechaHoy();
    const destino = path.join(CARPETA, `${fecha}.xlsx`);

    // Si ya se descargó hoy, no vuelve a descargar
    if (fs.existsSync(destino)) {
      console.log("Ya existe el Excel de hoy:", fecha);
      return;
    }

    console.log("Descargando planilla CAFCI...", fecha);
    const response = await axios.get(EXCEL_URL, { responseType: "arraybuffer" });
    fs.writeFileSync(destino, response.data);
    console.log("Planilla guardada:", destino);
  } catch (error) {
    console.error("Error al descargar:", error.message);
  }
}

// Descarga automática lunes a viernes a las 20:30hs Argentina
cron.schedule(
  "30 20 * * 1-5",
  () => {
    descargarExcel();
  },
  {
    timezone: "America/Argentina/Buenos_Aires",
  },
);

// Endpoint: último día disponible
app.get("/api/fondos", (req, res) => {
  const archivos = fs
    .readdirSync(CARPETA)
    .filter((f) => f.endsWith(".xlsx"))
    .sort();

  if (archivos.length === 0) {
    return res.status(404).json({ error: "Todavía no hay datos disponibles" });
  }

  const ultimo = archivos[archivos.length - 1];
  const datos = leerExcel(path.join(CARPETA, ultimo));
  const fechaConsulta = new Date().toLocaleDateString("es-AR");
  res.json({ fecha: fechaConsulta, datos });
});

// Endpoint: fecha específica → /api/fondos/2026-02-21
app.get("/api/fondos/:fecha", (req, res) => {
  const archivo = path.join(CARPETA, `${req.params.fecha}.xlsx`);

  if (!fs.existsSync(archivo)) {
    return res.status(404).json({ error: `No hay datos para la fecha ${req.params.fecha}` });
  }

  const datos = leerExcel(archivo);
  const fechaConsulta = new Date().toLocaleDateString("es-AR");
  res.json({ fecha: fechaConsulta, datos });
});

// Endpoint: listar todas las fechas disponibles
app.get("/api/fechas", (req, res) => {
  const fechas = fs
    .readdirSync(CARPETA)
    .filter((f) => f.endsWith(".xlsx"))
    .map((f) => f.replace(".xlsx", ""))
    .sort();
  res.json(fechas);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API corriendo en puerto ${PORT}`));

# api-cafci

API REST que sirve las planillas diarias de **Fondos Comunes de Inversión (CAFCI)**.
La consume el dashboard [`cafci-dashboard`](https://github.com/magustin28/dashboard-cafci).

- **Producción:** https://api-cafci-x8m6.onrender.com (Render · plan free)
- **Base de datos:** Supabase (Postgres) — tabla `planillas_cafci` (`fecha`, `datos`)
- **Fuente:** planilla diaria publicada por CAFCI (`https://api.pub.cafci.org.ar/pb_get`)

## Cómo funciona

```
planilla CAFCI (.xls)
   │  cron lun-vie 22:30 (America/Argentina/Buenos_Aires)
   ▼
server.js (Render)  ──insert──►  Supabase · planillas_cafci (fecha, datos jsonb)
   │
   │  GET /api/fondos · /api/fondos/:fecha · /api/fechas
   ▼
cafci-dashboard (GitHub Pages)
```

Cada fila guarda el día completo del Excel ya normalizado:
`{ fechaArchivo, referencias, listado_fondos: [{ categoria_fondo, fondos: [ … ] }] }`.
`referencias` contiene las fechas de comparación leídas del propio Excel
(`variacion_fecha1`, `variacion_fecha2`, `variacion_fecha3`, `valor_fecha_anterior`,
`patrimonio_fecha_anterior`).

El parser vive en **`lib/leerExcel.js`** (lo comparten `server.js`, `descargar.js` y
`cargar-historico.js`) y hace tres cosas más que antes:

- **Descarta las filas de leyenda** del Excel (advertencias y notas al pie como
  `(*) Determinación…`) y las **categorías que quedan sin fondos**, que antes se guardaban
  como 10 categorías vacías por planilla.
- **Valida antes de guardar** (`validarPlanilla`): que exista la fecha del archivo, que haya
  al menos una categoría con fondos y que el total supere un mínimo (env `MIN_FONDOS`,
  default `1000`). Si no pasa, **no guarda** y el error dispara los reintentos del cron.
- Expone `fechaHoy()` (fecha ART) y `convertirFecha()` (DD/MM/AA → AAAA-MM-DD).

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/` | Información del servicio (nombre, versión, endpoints) |
| GET | `/api/fondos` | Último día disponible |
| GET | `/api/fondos/:fecha` | Día específico, `YYYY-MM-DD` (ej. `/api/fondos/2026-10-14`) |
| GET | `/api/fechas` | Fechas disponibles, ascendente, `YYYY-MM-DD` |
| GET | `/health` | **Liveness** — sin acceso a red, responde siempre en < 5 s |
| GET | `/health/db` | **Readiness** — consulta a Supabase; devuelve 503 si falla |
| POST | `/api/descargar` | Dispara la descarga a demanda (header `Authorization: Bearer <CRON_TOKEN>`). Con `?dry=1` descarga, parsea y valida **sin escribir** (para probar sin riesgo). Lo usa el cron externo de GitHub Actions |

### Respuesta de `/api/fondos`

```jsonc
{
  "fecha": "14/10/26",                       // datos.fechaArchivo || columna fecha
  "datos": {
    "referencias": {
      "variacion_fecha1": "30/09/26",
      "variacion_fecha2": "30/12/25",
      "variacion_fecha3": "30/09/25",
      "valor_fecha_anterior": "13/10/26",
      "patrimonio_fecha_anterior": "13/10/26"
    },
    "listado_fondos": [
      {
        "categoria_fondo": "Renta Variable Peso Argentina",
        "fondos": [
          {
            "Codigo CNV": 1901,
            "Fondo": "BAVSA Renta Balanceado IX - Clase A",
            "Código CAFCI": 6419,
            "Moneda Fondo": "ARS",
            "Clasificación_Región": "Arg",
            "Clasificación_Horizonte": "Flex",
            "Patrimonio_Actual": 790407961.95,
            "Patrimonio_13/10/26": 801028919.72,
            "Variacion cuotaparte %_30/09/26": 0.125,
            "Valor (mil cuotapartes)_Actual": 1094.438
          }
        ]
      }
    ]
  }
}
```

> Los nombres de las claves de `fondos` son los encabezados del Excel de CAFCI, e
> **incluyen las fechas** (`Variacion cuotaparte %_30/09/26`, `Patrimonio_13/10/26`).
> Eso es intencional: Supabase (`jsonb`) reordena las claves alfabéticamente, así que
> el dashboard no puede depender del orden ni de índices de columna.
> Si CAFCI cambia un encabezado, cambian las claves → revisar
> `cafci-dashboard/src/hooks/useFondos.js`.

## Variables de entorno

| Variable | Requerida | Descripción |
| --- | --- | --- |
| `SUPABASE_URL` | ✔ | Project URL de Supabase |
| `SUPABASE_KEY` | ✔ | Clave **secreta** (`sb_secret_…` / service role). **Saltea RLS**: sólo se usa del lado servidor |
| `PORT` | — | Puerto local (default `3000`). Render inyecta `PORT` (default `10000`) |
| `CRON_TOKEN` | ✔ (cron externo) | Token que protege `POST /api/descargar`. Se carga en Render → Environment **y** como secret en GitHub |
| `MIN_FONDOS` | — | Mínimo de fondos para guardar una planilla (default `1000`) |

- **Local:** copiar `.env.example` → `.env` y completar. El `.env` está en `.gitignore`.
- **Render:** panel → servicio → *Environment* → *Add Environment Variable*.

## Correr en local

```bash
npm install
npm start            # http://localhost:3000/health
```

Otros scripts:

```bash
npm run check        # valida la sintaxis de los .js
npm run descargar    # fuerza la descarga de la planilla de hoy
npm run historico    # carga todos los .xls de ./historico
```

> `descargar.js`, `cargar-historico.js`, `historico/` y `verAnterior/` están en
> `.gitignore`: son herramientas y archivos locales, no forman parte del repo.

## Deploy en Render

Web Service · runtime Node · branch `main`:

| Ajuste | Valor |
| --- | --- |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Env vars | `SUPABASE_URL`, `SUPABASE_KEY` |

Render usa `npm start` como Start Command por defecto para servicios Node, y ese script
ahora existe en `package.json` (→ `node server.js`): el repo es autosuficiente y ya no
depende de un comando configurado a mano en el panel.

`render.yaml` **no se aplica solo**: Render sólo lo lee al crear un Blueprint. Antes de
conectarlo, leer el encabezado de ese archivo (`name`, `plan` y `region` deben coincidir
exactamente con el servicio actual, o se crearía un servicio nuevo con otra URL).

## Health checks

Render envía probes cada pocos segundos a cada instancia:

- Por defecto: **TCP** al puerto público (`10000` en Render).
- Con `healthCheckPath: /health`: GET HTTP; sano = 2xx/3xx **en menos de 5 s**.
- Deploy nuevo: si no pasan en 15 min, **se cancela el deploy** y sigue la versión anterior.
- Instancia viva: 15 s fallando → deja de enrutar tráfico; 60 s → **Render reinicia la instancia**.

Por eso `/health` no consulta Supabase: si la base tarda más de 5 s, Render reiniciaría el
contenedor sin motivo. La verificación real de la base está en `/health/db` (503 si falla).

## Limitaciones conocidas (plan free de Render)

- El servicio **se suspende a los 15 minutos sin tráfico** y tarda ~1 minuto en despertar:
  el primer request del día puede demorar (el dashboard reintenta).
- El **cron interno** corre dentro del proceso (lun-vie 22:30 ART): si el servicio está
  suspendido o Render lo reinicia justo antes, ese día se pierde. Por eso ahora hay un
  **cron externo** (`.github/workflows/descarga-diaria.yml`) que a las 22:40 ART hace
  `POST /api/descargar` y **falla el job si la planilla del día no quedó cargada** → GitHub
  avisa por mail. El ping de UptimeRobot a `/health` sigue siendo útil: evita el cold start
  de ~1 min en el primer uso del día.
- El filesystem es efímero: los archivos locales se pierden en cada deploy.
- No hay historial de logs propio: se consultan en el panel de Render.

## Seguridad

- `SUPABASE_KEY` es una clave **secreta** de Supabase (sb_secret_…), que saltea RLS.
- **Una clave secreta por entorno** — recomendación de Supabase (*"use a separate secret
  key for each backend component"*): `api-render` en Render → Environment y `local-dev` en
  el `.env` local. Si una se filtra, se revoca **solo esa** sin tocar la otra, y el `.env`
  de desarrollo nunca contiene la credencial de producción.
  Se administran en Supabase → **Project Settings → API Keys** (crear / revocar / rotar).
- Las claves `sb_secret_…` no son JWT: viajan en el header `apikey`, no en
  `Authorization: Bearer` (el SDK de JS ya lo maneja; sólo tenerlo en cuenta con otras librerías).
- Para rotar: crear la clave nueva, actualizar el destino (Render o `.env`), verificar y
  revocar la vieja **al final** — conviven, así que no hay caída.
- El dashboard usa la clave *publishable* contra Supabase, por lo que las tablas
  `favoritos`, `suscripciones`, `rescates` y `rescate_detalle` deben tener **RLS habilitado**
  con políticas `user_id = auth.uid()`.
- `cors()` está abierto a cualquier origen (a evaluar: restringirlo a GitHub Pages).
- No hay rate limiting en los endpoints públicos.

## Convención de nombres

Los objetos de la base van en **minúsculas `snake_case`**, con las tablas en plural:
`planillas_cafci`, `favoritos`, `suscripciones`, `rescates`, `rescate_detalle`.
En Postgres un identificador creado con mayúsculas queda *case-sensitive* y obliga a
entrecomillarlo en cada consulta (`select * from "planillas_cafci"`), y es la causa típica del
error `relation "planillascafci" does not exist` cuando alguien se olvida de las comillas.
*(La tabla principal se renombró de `PlanillasCAFCI` a `planillas_cafci` por este motivo.)*

## Convención de commits

Se sigue [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`<tipo>(<ámbito>): <descripción>`.

- Descripción en minúscula y en **imperativo** ("agrega", no "agregué"), sin punto final y ≤ 72 caracteres.
- Línea en blanco entre el título y el cuerpo. El cuerpo usa las secciones
  `Por qué:` / `Qué cambia:` / `Impacto:` envueltas a ~76 columnas.
- Ejemplo: `feat(api): deploy reproducible con health checks y documentación`.

| Tipo | Cuándo |
| --- | --- |
| `feat` | nueva funcionalidad (endpoints, componentes, tabs) |
| `fix` | corrección de un bug |
| `docs` | sólo documentación (README, `.env.example`) |
| `refactor` | reestructurar sin cambiar comportamiento |
| `perf` | mejora de rendimiento |
| `build` | `package.json`, dependencias, script `start`, `engines` |
| `ci` | GitHub Actions, deploy, cron |
| `chore` | tareas varias (config, `render.yaml`, `.gitignore`) |

Ámbitos usados: `api`, `dashboard`, `parser`, `deploy`, `db`, `docs`.

## Tests

```bash
npm test        # node --test (runner de Node, sin dependencias nuevas)
```

`test/leerExcel.test.js` cubre el parser compartido. El Excel de prueba se genera **en memoria** con la propia librería `xlsx`, replicando la estructura del archivo de CAFCI (fila 8: grupos; fila 9: sub-encabezados con las fechas de referencia; E12: fecha del archivo; de la fila 11 en adelante: categorías y fondos), así que no hay fixture binario que mantener en el repo.

Qué se verifica:

- `leerExcel`: fecha del archivo, las 5 referencias, categorías y fondos, descarte de leyendas y categorías vacías, filas con datos pero sin nombre de fondo, y las claves que combinan grupo + sub-encabezado (las que consume el dashboard).
- `convertirFecha`: `DD/MM/AA` y `DD/MM/AAAA`, y formato inválido.
- `fechaHoy`: formato, y que use la fecha de Argentina y no la de UTC (el día cambia a las 21:00 ART).
- `validarPlanilla`: falta de fecha, sin categorías, sin fondos, planilla incompleta, mínimo por argumento, y `MIN_FONDOS` del entorno con su valor por defecto (1000).

> La fila 8 del fixture queda **densa** a propósito: `sheet_to_json` devuelve arrays con huecos en las celdas vacías y el parser arma los nombres con `encabezado1.map(...)`, que saltea los huecos. En el archivo real cada grupo se repite a lo ancho de sus columnas, por eso las claves aparecen completas.

## Estructura

```
cafci-api/
├── server.js             # API Express + cron de descarga (lo único que corre en Render)
├── lib/leerExcel.js      # parser del Excel de CAFCI + fechaHoy / convertirFecha / validarPlanilla
├── .github/workflows/descarga-diaria.yml   # cron externo (22:40 ART) → POST /api/descargar
├── descargar.js          # (local) fuerza una descarga puntual
├── cargar-historico.js   # (local) carga masiva desde ./historico
├── render.yaml           # documentación inerte del servicio en Render
├── test/leerExcel.test.js # tests del parser (npm test, sin dependencias nuevas)
├── .env.example          # plantilla de variables de entorno
└── package.json
```


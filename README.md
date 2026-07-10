# 🌾 Celiac Market Radar — OSINT Chile

> Motor **OSINT** multi-región que cruza datos públicos (INE / Censo, Google Maps, Google Trends, supermercados y delivery) para *estimar* señales de demanda potencial de productos sin gluten en Chile — con una capa de validación basada en literatura sobre prevalencia celíaca. Herramienta exploratoria de análisis de mercado.

**Por qué este proyecto:** para validar una hipótesis concreta — ¿se puede estimar oportunidades comerciales usando **solo datos públicos**, sin comprar estudios de mercado ni recolectar datos privados de personas?

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white">
  <img alt="Puppeteer" src="https://img.shields.io/badge/Puppeteer-scraping-40B5A4?logo=puppeteer&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green">
</p>

---

## 🎯 Idea

La prevalencia celíaca en Chile ronda el ~1% (Araya et al.), pero la oferta sin gluten se concentra en pocas comunas. Este proyecto **automatiza la recolección de señales públicas** por región y las combina en un *score* de oportunidad de mercado por comuna: población, ingresos, empleo, movilidad, oferta existente (tiendas/supermercados/delivery) e interés de búsqueda.

Cambiar la región en `.env` (o vía API) **dispara automáticamente** toda la pipeline: scraping → análisis INE → scoring celíaco → export.

## ✨ Características

- **Scrapers modulares** (Puppeteer + rate-limiting con Bottleneck):
  - INE: ingresos, empleo, vivienda, demografía, consumo (+ BCN/SINIM)
  - Comercio: Google Maps, Jumbo, Líder, MercadoLibre, Rappi, reviews
  - Tendencias: Google Trends
- **Motor de análisis**: normalización y perfilado INE, clasificador territorial, *heatmap*, matriz de movilidad (EOD) y modelo de población.
- **Validación científica**: cálculo de prevalencia desde literatura (no valores inventados) con un *scientific-validator*.
- **Arquitectura multi-región reactiva**: `region-watcher` + `auto-orchestrator` que re-ejecutan la pipeline ante cualquier cambio de región.
- **Dashboard web** (Express + `public/`) y **API REST** (`/api`).

## 🏗️ Estructura

```
src/
├── scrapers/        # INE, Google Maps/Trends, supermercados, delivery, reviews
├── analysis/
│   ├── ine/         # normalizador, perfiles, score, heatmap, clasificador
│   └── celiac/      # census-engine, scorer, scientific-validator, literature.json
├── core/            # auto-orchestrator, region-watcher, auto-trigger
├── context/         # region-engine
├── config/regions/  # config por región (metropolitana, valparaiso, biobio, ...)
└── utils/           # data-store, logger, rate-limiter
data/                # datos públicos: INE/Censo, business listings, trends
public/              # dashboard web
server.js            # entrypoint Express
```

## 🚀 Uso

```bash
npm install
cp .env.example .env        # ajusta REGION y delays

npm start                   # levanta dashboard + API en http://localhost:3000

# Scrapers individuales
npm run scrape:maps
npm run scrape:ine
npm run scrape:all          # pipeline completa

# Análisis
npm run ine:score
npm run report
```

## 📊 Sobre los datos

`data/` contiene **únicamente datos públicos**: estadística agregada del INE/Censo, listados públicos de negocios (Google Maps), tendencias de búsqueda y reseñas **anonimizadas** (solo texto y rating, sin nombres ni identificadores de usuarios). No contiene datos personales.

## 🔒 Configuración

Toda la config vive en `.env` (no versionado). Ver [`.env.example`](.env.example). Las claves opcionales (SerpAPI, proxy) van vacías por defecto.

## 📊 Benchmarks

> ⚠️ **Pendiente de medición.** Métricas de cobertura y ejecución de la pipeline (no de "precisión", porque el output es una *estimación* de oportunidad, no una verdad verificable):

| Métrica | Cómo se mide | Valor |
|---------|--------------|-------|
| Tiempo de pipeline por región | duración de `scrape:all` + análisis | *por medir* |
| Comunas cubiertas | comunas con datos / total de la región | *por medir* |
| Fuentes integradas | nº de fuentes con datos por región | *por medir* |
| Tasa de éxito de scraping | requests OK / total (con rate-limiting) | *por medir* |

## ⚠️ Limitaciones

- Estima **señales de demanda potencial**, no ventas ni demanda real: es una hipótesis de mercado, no un pronóstico.
- El *scraping* es **frágil**: cambios en Google Maps / supermercados pueden romper los extractores.
- Los datos públicos tienen **sesgos** (cobertura desigual, subregistro); el resultado hereda esos sesgos.
- **No reemplaza** un estudio de mercado formal ni validación en terreno.
- La prevalencia celíaca se calcula desde literatura (Araya et al.), no desde diagnóstico local.

## 🛠️ Stack

`Node.js` · `Express` · `Puppeteer` · `Bottleneck` · `Winston` · `google-trends-api` · `node-fetch`

---

## ✍️ Autor

**Nacho** — [@Nachossrd](https://github.com/Nachossrd)

## 📄 Licencia

MIT — ver [`LICENSE`](LICENSE).

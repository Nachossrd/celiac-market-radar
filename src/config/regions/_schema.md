# Esquema de configuración regional

Cada archivo `<slug>.json` describe una región chilena para el motor OSINT.
Slug = nombre minúscula sin tildes ni espacios (ej: `metropolitana`, `valparaiso`,
`biobio`, `antofagasta`, `coquimbo`).

```jsonc
{
  "slug": "valparaiso",
  "nombre": "Valparaíso",
  "codigoRegion": "05",           // Código DEIS regional (2 dígitos)
  "capital": "Valparaíso",

  // Eje analítico — qué actividades dominan la región.
  // Drivers conocidos: "mineria", "agro", "industria", "puerto",
  // "turismo_costero", "turismo_andino", "servicios", "agricultura_intensiva",
  // "forestal", "pesca", "academico"
  "perfilEconomico": ["turismo_costero", "puerto", "servicios"],

  // Listado canónico de comunas. El `id` es el slug usado en todo el sistema.
  // `deis` es el código DEIS (5 dígitos) que usa BCN Reportes Comunales.
  "comunas": [
    {
      "id": "valparaiso",
      "nombre": "Valparaíso",
      "deis": "05101",
      "provincia": "Valparaíso",
      "poblacion": 305000,
      "lat": -33.0472,
      "lng": -71.6127,
      "sector": "Costa",
      "perfil": ["puerto", "turismo", "academico"]
    }
  ],

  // Términos usados en queries de Trends, Maps y scrapers retail.
  "keywordsComerciales": ["valparaiso", "valpo", "viña del mar"],

  // Clasificación cualitativa de comunas por nivel económico. Estos arrays
  // son SOLO sugerencias semilla; el scoring real las calibra con datos.
  "sectoresAltosIngresos": ["concon", "vina-del-mar", "papudo", "zapallar"],
  "sectoresMedios": ["quilpue", "villa-alemana", "los-andes"],
  "sectoresBajosIngresos": ["petorca", "la-ligua-rural"],

  // Cadenas de retail que tienen cobertura real en la región (no inventar:
  // si Jumbo no tiene tiendas allí, no ponerlo).
  "retailDominante": ["Jumbo", "Lider", "Santa Isabel", "Tottus", "Unimarc"],

  // Polos comerciales: malls, centros, paseos.
  "polosComerciales": [
    { "nombre": "Mall Marina", "comuna": "vina-del-mar", "tipo": "mall" },
    { "nombre": "Espacio Urbano", "comuna": "quilpue", "tipo": "mall" }
  ],

  // Zonas funcionales: agrupan comunas para queries especializadas.
  "zonas": {
    "turisticas":    ["vina-del-mar", "valparaiso", "concon", "papudo"],
    "industriales":  ["quintero", "puchuncavi"],
    "portuarias":    ["valparaiso", "san-antonio"],
    "mineras":       [],
    "agricolas":     ["limache", "olmue"]
  },

  // Centroide regional para mapas/heatmaps.
  "centroide": { "lat": -33.0472, "lng": -71.4127, "zoom": 9 },

  // Ajustes opcionales del scoring para reflejar realidad regional.
  // Si se omite, scoring usa pesos por defecto.
  "scoringOverrides": {
    // Pesos custom (suman 1). Omitir => 0.35/0.20/0.20/0.15/0.10.
    "weights": { "ingreso": 0.30, "educacion": 0.20, "vivienda": 0.20, "empleo": 0.15, "consumo": 0.15 },
    // Comunas con peso de turismo: el "consumo" se interpreta con boost por turismo.
    "modificadores": {
      "turismoBoost": 1.0,    // 1.0 = sin cambio
      "mineriaBoost": 1.0,
      "puertoBoost": 1.0
    }
  },

  // Literatura/fuente específica regional (cuando aplique).
  // Estas claves son consumidas por inference.js para mostrar citas honestas.
  "fuentes": {
    "poblacion": "INE - Proyecciones de poblacion 2024 (base Censo 2017)",
    "indicadores": "BCN Reportes Comunales 2024",
    "matrizEod": null            // null si no hay matriz EOD para esta region
  }
}
```

## Reglas

- **Nunca inventar**: si una comuna no existe o un dato no está, omitir el campo
  (no rellenar con 0 ni con string vacío). El motor maneja `null` y reporta
  confianza honestamente.
- **DEIS oficial**: usar el código del Nomenclador Territorial INE. Sin ese
  código, BCN no devuelve la ficha y el scraper guarda `null`.
- **Slug consistente**: el `id` de comuna debe estar slugificado sin tildes ni ñ
  (`vina-del-mar`, no `viña-del-mar`). Las tildes van en `nombre`.
- **Población**: usar proyección INE más reciente conocida; si no se sabe, dejar
  `null`. El scoring funciona con `null`.

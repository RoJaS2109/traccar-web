# Diseño — App móvil RudaTrak offline (mapa + POIs)

**Fecha:** 2026-09-01
**Estado:** Borrador para revisión

## 1. Contexto y objetivo

RudaTrak es una plataforma de rastreo GPS y mapa de POIs para viajeros en Argentina y países limítrofes, basada en Traccar. Hoy el mapa y los POIs (`general.kml`) solo funcionan con conexión a internet.

**Objetivo:** crear una app Android separada que permita, antes de viajar (con WiFi o datos), descargar zonas del mapa y los POIs, y usarlos después sin señal — el mismo modelo de "mapas offline" de Google Maps.

## 2. Alcance y decisiones

| Decisión | Valor |
|----------|-------|
| Plataforma | App Android separada con **Capacitor** (WebView + frontend React actual) |
| Mapa base offline | Tiles raster de **Argenmap (IGN)**: `capabaseargenmap` + `mapabase_topo` |
| POIs offline | `general.kml` (4 MB, ~5.379 POIs) + íconos, desde el servidor RudaTrak |
| Satelital | **Fuera de la v1** (punto de extensión previsto) |
| Zoom máximo | Elegible por zona al descargar |
| Infraestructura propia | **Ninguna** (ni generador de tiles ni servicios nuevos en la Pi) |
| Servidor RudaTrak | Sin cambios |
| Login offline | Modo visitante (mapa + POIs sin sesión; posiciones en vivo requieren login) |
| Índice de zonas | SQLite (`capacitor-community/sqlite`) |
| UI | Frontend completo (consola de administración accesible) |

**Fuera de alcance en la v1:** satelital/Sentinel-2, ortomosaicos, mapa vectorial propio (PMTiles desde capas IGN), soporte de países limítrofes offline (Argenmap cubre Argentina en detalle; los limítrofes requerirían otra fuente).

## 3. Fuente de datos

### 3.1 Mapa base (IGN / Argenmap)

Formato TMS/XYZ (raster PNG), abierto:

```
https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/{capa}@EPSG%3A3857@png/{z}/{x}/{-y}.png
```

Capas usadas: `capabaseargenmap` (estándar), `mapabase_topo` (topográfico, con relieve y curvas de nivel).

**Nota técnica:** el IGN usa TMS (`{-y}` invertido); MapLibre usa XYZ. Se configura `scheme: 'tms'` en la fuente raster.

### 3.2 Satelital (reservado, fuera de v1)

- Sentinel-2 (resolución ~10 m): mosaicos provinciales descargables y WMTS en `https://imagenes.ign.gob.ar/geoserver/gwc/service/wmts`.
- Ortomosaicos aéreos (alta resolución, cobertura parcial): WMTS en `imagenes.ign.gob.ar`.

El sistema de "descargar una zona raster de una URL TMS" es genérico; el satelital se agrega después como una capa más.

### 3.3 POIs (servidor RudaTrak, sin cambios)

- `GET /poi/general.kml` → KML con los POIs.
- `GET /poi/icons/*` → 31 íconos referenciados por el KML.

### 3.4 Licencia y atribución

Los datos del IGN exigen citar "FUENTE: Instituto Geográfico Nacional de la República Argentina", no alterar los datos y compartirlos libremente. La atribución debe mostrarse en el mapa offline.

## 4. Arquitectura

```
┌────────────────────────────────────────────────────────────────────┐
│  App Android "RudaTrak Móvil"  (Capacitor = WebView + build de Vite) │
│                                                                    │
│  ONLINE  ──►  API RudaTrak (posiciones/dispositivos, login)         │
│              POIs: /poi/general.kml + /poi/icons/*                  │
│                                                                    │
│  OFFLINE ──►  tiles raster Argenmap  ← wms.ign.gob.ar (IGN)         │
│              POIs precargados (KML + íconos)                        │
└────────────────────────────────────────────────────────────────────┘
```

Principios:

1. **Un solo build de Vite, dos destinos.** La web se despliega igual que hoy; la app móvil envuelve el mismo `build/` en un shell Capacitor. El modo offline se activa solo en la app nativa (`Capacitor.isNativePlatform()`).
2. **El servidor no cambia.**
3. **Descarga por zonas = tiles raster sueltos** (`z/x/y.png`) guardados en el filesystem.
4. **Extensible a otras capas** (satelital) sin rediseño.

## 5. Componentes

### Nuevos (`src/offline/`)

| Componente | Responsabilidad |
|-----------|----------------|
| `OfflineManager.js` | Índice de zonas (bbox, zoom, capa, tamaño, fecha) en SQLite. API: `downloadZone()`, `deleteZone()`, `listZones()`, `getProgress()`, `cancel()`. |
| `tileMath.js` | Calcula `{z,x,y}` que cubren un bbox y rango de zoom (con TMS `{-y}`). |
| `tileStore.js` | Escribe/lee PNGs en `tiles/{capa}/{z}/{x}/{y}.png`; reporta espacio usado. |
| `DownloadZoneDialog.jsx` | Dibujar rectángulo, elegir capa y zoom máx, estimar tamaño, descargar con progreso y cancelar. |
| `ZonesPage.jsx` | Listar zonas, ver espacio, borrar, re-descargar. |
| `offlineProtocol.js` | `maplibregl.addProtocol('offline', …)` que resuelve `offline://capa/{z}/{x}/{y}` a un PNG local vía Filesystem. |
| `useOfflinePoi.js` | Precarga `general.kml` + íconos al iniciar, y los expone sin red. |

### Modificados

| Archivo | Cambio |
|---------|--------|
| `src/map/core/MapView.jsx` | Registrar protocolo `offline`; elegir estilo local vs remoto según conectividad (o toggle manual). |
| `src/map/core/useMapStyles.js` | Estilos offline (`offline://capabaseargenmap/…`, `offline://mapabase_topo/…`) disponibles solo en la app nativa. |
| `src/map/main/PoiMap.js` | Si hay KML local, parsearlo desde ahí y resolver íconos locales en vez de `fetch(poiLayer)`. |
| `capacitor.config.ts` (nuevo, en raíz) | `webDir: 'build'` + plugins Filesystem, Network, SQLite. |

## 6. Flujos

### 6.1 Descargar una zona
1. "Descargar zona" → dibujar rectángulo (o coordenadas).
2. Elegir capa (Argenmap/topográfico) y zoom máximo.
3. Estimar tamaño (`nº tiles × ~15–25 KB`) y mostrar espacio disponible.
4. `OfflineManager` calcula tiles, descarga en lotes (4–6 en paralelo) con reintentos con backoff, escribe PNGs, reporta progreso.
5. Registrar zona en el índice.

### 6.2 Uso offline
1. `navigator.onLine === false` (o falla de conexión) → modo offline.
2. MapView usa estilo offline; PoiMap lee KML + íconos locales.
3. Fuera de la zona descargada → gris + aviso.

### 6.3 Uso online
Comportamiento actual + refresco de la copia local de POIs.

### 6.4 Transición online↔offline
Perder red → aviso + fuente local. Recuperar → online + refresco de POIs.

## 7. Errores y casos borde

| Caso | Manejo |
|------|--------|
| Descarga cortada a mitad | Directorio temporal + commit al final; si se interrumpe, zona "incompleta" y reanudable (solo faltantes). |
| Espacio insuficiente | Estimación previa; si se llena a mitad, abortar con mensaje y limpiar parcial. |
| Tiles 403/404/rate-limit IGN | Reintentos con backoff + concurrencia baja; tile faltante con hueco + aviso. |
| Arranque sin red y sin sesión | Modo visitante offline (mapa + POIs) — ver §9.1. |
| Zona no descargada en la vista | Gris + aviso, sin romper el mapa. |
| KML desactualizado | Refresco automático al haber red + mostrar fecha de copia. |
| Ícono de POI faltante | Fallback a círculo de color. |
| TMS `{-y}` vs XYZ | `tileMath` + tests dedicados. |
| Protocolo `offline://` en WebView | Spike temprano; plan B: esquema nativo o servidor local. |
| Tamaño del APK | Los tiles no van en el APK; solo app + KML/íconos (~5 MB). |

## 8. Testing y validación

- **`tileMath`** — tests unitarios con Vitest (única pieza con suite): cobertura bbox→tiles, TMS, off-by-one.
- **Spike de riesgo** — validar lectura de PNG local en Android WebView antes de construir todo.
- **Servicio IGN** — confirmar URLs, latencia/rate, concurrencia segura, atribución.
- **Manual end-to-end** (principal), en dispositivo real: descarga → apagar red → mapa+POIs; transiciones; reanudar; borrar; modo visitante.
- **Build** — Capacitor/Android local al principio; CI opcional después.

## 9. Fuera de alcance (v1)

Satelital/Sentinel-2, ortomosaicos aéreos, mapa vectorial propio, países limítrofes offline, notificaciones push, rastreo en segundo plano.

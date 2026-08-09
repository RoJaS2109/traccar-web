# CLAUDE.md — Frontend (React SPA)

Este archivo documenta el código del frontend React. Para visión general del proyecto, arquitectura de producción y flujo de deploy, consultar [`../../CLAUDE.md`](../../CLAUDE.md) (raíz del monorepo). Documentación complementaria en [`docs/`](docs/).

## Project structure

```
/mnt/Datos/app/RudaTrak/
└── traccar/                  # Traccar Server (Java 21, Gradle) — ver ../CLAUDE.md
    └── traccar-web/          # React SPA (este repo) — origin: RoJaS2109/traccar-web
```

## General

- **No TypeScript source files** — the codebase uses plain `.js`/`.jsx`. TypeScript exists only in devDependencies for tooling.
- The project has **no test suite**. There is no `npm test` script.
- CI (GitHub Actions) runs `npm ci && npm run build` and `npm run lint` on every push/PR to `master`.
- Translations are managed via [Transifex](https://www.transifex.com) (`.tx/config`). A workflow runs `tx pull` on manual dispatch. English is the source language (`src/resources/l10n/en.json`).

## Commands

```bash
npm start          # Dev server on port 3001, proxies /api to gps.rudatrak.com
npm run build      # Production build into build/
npm run lint       # ESLint (max-warnings 0)
npm run lint:fix   # ESLint with auto-fix
```

## Architecture

**Stack**: React 19, Vite 8, Material UI 9, MapLibre GL 5, Redux Toolkit, React Router 7, dayjs, tss-react, Recharts.

### Startup flow

1. `index.html` → `src/index.jsx` mounts the provider tree:
   ```
   ErrorBoundary → Redux Provider → LocalizationProvider → MUI StyledEngine → AppThemeProvider → CssBaseline → ServerProvider → BrowserRouter → Navigation
   ```
2. `ServerProvider` fetches `/api/server` to get server config (colors, features, etc.). The app shows a loader until this succeeds.
3. `Navigation` handles query params (`?token=`, `?locale=`, `?uniqueId=`, `?openid=`) for deep linking, then renders routes.
4. `App` (the layout route) fetches `/api/session` to restore the user session. If unauthenticated, redirects to `/login`. If `termsUrl` is set and user hasn't accepted terms, shows TermsDialog.

### Routing (`src/Navigation.jsx`)

Every page is `React.lazy` loaded. The route structure:

- `/login`, `/register`, `/reset-password`, `/change-server` — public
- `/` (App layout) — authenticated:
  - `/` — MainPage (map + device list)
  - `/position/:id`, `/event/:id`, `/replay`, `/geofences`, `/emulator`, `/stream`, `/network/:positionId` — standalone pages
  - `/settings/...` — CRUD pages for all entity types (devices, users, groups, geofences, drivers, calendars, commands, notifications, maintenances, computed attributes, server, preferences, accumulators, announcement, share)
  - `/reports/...` — report pages (combined, chart, events, geofences, route, stops, summary, trips, scheduled, statistics, audit, logs)

### State management (`src/store/`)

Redux Toolkit with slices: `session`, `devices`, `events`, `geofences`, `groups`, `drivers`, `maintenances`, `calendars`, `motion`, `errors`. A `throttleMiddleware` limits rapid dispatches.

**`session` slice** — the central slice. Holds `server` (config from `/api/server`), `user` (from `/api/session`), `socket` (connection status), `positions` (real-time device positions keyed by `deviceId`), `history` (live route trails), and `logs`.

**`devices` slice** — stores `items` as an object keyed by device ID. `refresh()` replaces all items, `update()` merges. `selectedId` tracks the currently selected device.

### Real-time data (`src/SocketController.jsx`)

A persistent WebSocket to `/api/socket` receives JSON messages with `{devices, positions, events, logs}` keys and dispatches them to Redux. Reconnects after 60s on close, and when the tab becomes visible or the browser goes online. Logout sends close code 4000.

### Data fetching patterns (`src/reactHelper.js`)

- **`useAsyncTask(effect, deps)`** — runs an async effect with automatic `AbortController`. Errors (except AbortError) are dispatched to the `errors` slice. The effect can return a cleanup function.
- **`useCatch(method)`** — wraps an async function to catch and dispatch errors.
- **`useCatchCallback(method, deps)`** — same as `useCatch` but returns a stable callback via `useCallback`.
- **`fetchOrThrow(input, init)`** — a thin wrapper around `fetch` that throws with the response body text on non-ok responses.

### Preferences system (`src/common/util/preferences.js`)

`usePreference(key, defaultValue)` and `useAttributePreference(key, defaultValue)` read from Redux with a hierarchy: user setting overrides server setting, unless `server.forceSettings` is true (then server wins). This is how feature flags, map styles, and UI toggles work.

### Map (`src/map/`)

A **singleton** `maplibregl.Map` instance is created in `map/core/MapView.jsx` and shared across the app. The `<MapView>` component attaches it to a DOM container, manages style switching, and provides the map instance to children via prop drilling (not context).

Map layers are modular components rendered as children of `<MapView>`:

- `map/core/` — MapView, mapUtil, preloadImages, useMapStyles
- `map/main/` — app-specific layers: MapSelectedDevice, MapAccuracy, MapLiveRoutes, MapDefaultCamera, PoiMap
- `map/overlay/` — custom overlay system (MapOverlay, useMapOverlays)
- `map/control/` — UI controls: MapSwitcher, MapGeocoder, MapNotification, MapRuler, MapSpeedLegend
- `map/draw/` — geofence drawing tools (MapGeofenceEdit)
- `map/` (top-level) — MapPositions, MapMarkers, MapGeofence, MapRoutePath, MapRoutePoints, MapCamera, MapCurrentLocation, MapPadding, MapScale, MapRouteCoordinates

Map styles are defined in `useMapStyles.js`. Google Maps and PMTiles protocols are registered at module load.

### Styling

- **Theme**: `src/common/theme/` — dynamic MUI theme built from server attributes (`colorPrimary`, `colorSecondary`, `darkMode`). `palette.js` generates light/dark palette.
- **RTL**: `stylis-plugin-rtl` handles RTL for Arabic, Hebrew, and Farsi via Emotion's `CacheProvider`. Direction is set in `LocalizationProvider`.
- **Component styles**: Uses `makeStyles` from `tss-react` (not MUI's built-in `makeStyles`, which is deprecated). Theme has a custom `dimensions` object.

### i18n (`src/common/components/LocalizationProvider.jsx`)

61 languages supported. Translation JSON files live in `src/resources/l10n/`. Language resolution order: user attribute → server attribute → persisted local choice → browser detection → English. Uses React's `use()` hook with Suspense for locale loading. `useTranslation()` returns a function `(key) => translatedValue`.

### Settings pages pattern

Settings pages follow a consistent pattern:

- **List pages** (e.g., `DevicesPage`, `UsersPage`): table with `SearchHeader`, `CollectionActions`, `CollectionFab`, infinite scroll via `useScrollToLoad`
- **Edit pages** (e.g., `DevicePage`, `UserPage`): `EditItemView` layout with `EditAttributesAccordion` for the attributes section
- **Attribute hooks** (`common/attributes/`): define field metadata for each entity type (type, name, options, etc.)
- **Command pages** (`CommandDevicePage`, `CommandGroupPage`): use `BaseCommandView`

### Miscellaneous controllers rendered by `App.jsx`

- **`CachingController`** — fetches geofences, groups, drivers, maintenances, and calendars on auth and caches them in Redux.
- **`UpdateController`** — handles service worker updates (PWA).
- **`MotionController`** — reports device motion (battery-optimized position updates on mobile).

## PWA (Progressive Web App)

La app es instalable como PWA gracias a `vite-plugin-pwa`. El navegador muestra el prompt nativo "Instalar" / "Agregar a pantalla de inicio" cuando detecta HTTPS + manifest + service worker.

### Archivos clave

| Archivo | Función |
|---------|---------|
| `vite.config.js` | Configuración del plugin `VitePWA` (manifest, workbox, íconos) |
| `index.html` | `<link rel="manifest">`, `<meta name="theme-color">`, `<title>` |
| `src/UpdateController.jsx` | Detecta nuevas versiones del SW y muestra snackbar de actualización |
| `public/logo.svg` | Logo fuente para generar íconos PWA |
| `public/pwa-*.png` | Íconos generados (64, 192, 512 px) |

### Personalización del nombre (Branding)

Las variables `${title}`, `${description}`, `${colorPrimary}` en `vite.config.js` e `index.html` son placeholders que el backend de Traccar reemplaza al servir los archivos. El reemplazo ocurre en `OverrideTextFilter.java` (líneas 80-87):

```java
String title = server.getString("title", "RudaTrak");
String description = server.getString("description", "RudaTrak GPS Tracking");
String colorPrimary = server.getString("colorPrimary", "#1976d2");
```

Los valores por defecto se cambiaron de "Traccar" a "RudaTrak". Si se configuran atributos `title`, `description`, `colorPrimary` en la UI de administración (Servidor), esos tienen prioridad sobre los defaults.

**NO hardcodear en `vite.config.js` o `index.html`** — los placeholders deben mantenerse para que el backend los reemplace correctamente. El parche del backend se aplica durante el build Docker (ver Dockerfile multi-stage).

### Service Worker

- Cachea assets estáticos (JS, CSS, HTML, woff, mp3)
- `navigateFallbackDenylist: [/^\/api/, /^\/poi/]` — las rutas `/api/` y `/poi/` no deben ser interceptadas
- Actualización: cada `serviceWorkerUpdateInterval` ms (default 1 hora) verifica si hay nueva versión

## Herramienta carga-poi (`tools/carga-poi/`)

Servidor Express + formulario HTML vanilla para gestionar POIs directamente en un archivo KML. Corre en Docker (puerto 3007) con el volumen del KML montado.

### Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`  | `/api/categorias` | Lista las 15 categorías con id, label e icono |
| `POST` | `/api/poi` | Crea un nuevo POI con nombre auto-generado `"Nombre, Localidad lat, lon"` |
| `GET`  | `/api/poi/search?name=...` | Busca un POI por nombre exacto en el KML |
| `GET`  | `/api/poi/nearby?lat=X&lon=Y&radius=30` | Busca POIs por proximidad (Haversine). Retorna `masCercano` con todos los datos incluido `ultimoComentario` |
| `PUT`  | `/api/poi` | Actualiza un POI existente. Recibe `nombreActual` para localizarlo y `comentario` como la descripción completa |
| `DELETE` | `/api/poi` | Elimina un POI por nombre exacto |

### Funciones internas (`server.js`)

- **`haversine(lat1, lon1, lat2, lon2)`** — Distancia en metros entre dos coordenadas.
- **`parsearPOIs()`** — Lee el KML completo y extrae todos los Placemarks con sus datos (nombre, coordenadas, categoría, descripción limpia).
- **`backupKML()`** — Copia `general.kml` a `general.kml.bak-YYYYMMDD-HHMMSS` antes de cada escritura. Retiene los últimos 30 backups.

### Frontend (`public/index.html`)

Formulario con 3 modos:

| Modo | Disparador | Comportamiento |
|------|-----------|----------------|
| **Agregar** | Default | Formulario completo. Al salir del campo coordenadas (`blur`) verifica automáticamente si hay un POI a ≤30m |
| **Actualizar** | Detección de POI cercano | Banner naranja con historial completo. Precarga todos los campos. El textarea de Comentario muestra **todo el historial** para edición libre. Campo Autor oculto. Guarda con `PUT` |
| **Eliminar** | Toggle switch | Búsqueda por nombre exacto o por coordenadas (radio buttons). Muestra preview y pide escribir "ELIMINAR" para confirmar |

**Flujo de proximidad:** el usuario ingresa coordenadas → al salir del campo se llama `GET /api/poi/nearby` → si encuentra un POI a ≤30m, cambia automáticamente a modo Actualizar con los datos precargados. Link "Crear nuevo de todas formas" para ignorar la detección y crear duplicado.

### Deploy

```bash
cd tools/carga-poi
docker compose down
docker compose up -d --build
```

**En la Pi** (parte del Portainer Stack `rudatrak`):

```bash
docker build --no-cache -t carga-poi:latest /app/RudaTrak/traccar-web/tools/carga-poi/
docker rm -f rudatrak-carga-poi
docker run -d --name rudatrak-carga-poi --network npm_proxy-network -p 3007:3007 \
  -v /data/compose/rudatrak/trak-poi/general.kml:/data/kml/general.kml \
  --restart unless-stopped carga-poi:latest
```

El KML se monta desde `/data/compose/rudatrak/trak-poi/general.kml`. La URL pública es `https://nuevo-poi.rudatrak.com` (proxied via Nginx Proxy Manager → `carga-poi:3007`).

### Gotchas

- **Campo `Autor` sin `required`:** el campo autor se oculta (`display:none`) en modo actualizar. Si tuviera el atributo `required`, el navegador bloquea el submit con "An invalid form control is not focusable".
- **`placemarkActual` en PUT:** al modificar `server.js`, asegurarse de que la variable `placemarkActual` esté definida con `kml.slice(placemarkStart, placemarkEnd)` antes de usarla en los `.replace()`.

### POI Map

Renderiza puntos de interés desde un archivo KML. La URL del KML se configura en la preferencia `poiLayer` (por servidor o usuario).

### Capas (en orden de renderizado)

| Capa | Tipo | Filtro | Tiene click |
|------|------|--------|-------------|
| `poi-fill` | fill | Polygon | ✅ |
| `poi-point` | symbol | Point + tiene icono | ✅ |
| `poi-circle` | circle | Point + sin icono | ✅ |
| `poi-line` | line | LineString | ✅ |
| `poi-title` | symbol | todos (texto) | ✅ |

**IMPORTANTE:** `poi-point` se agrega **asincrónicamente** (dentro de `Promise.all` para cargar iconos). Las otras capas son sincrónicas. Todos los click handlers se registran juntos al final del `useEffect`.

### Problema conocido: popup vacío en Android

**Síntoma:** En Chrome Android, al tocar un POI el popup aparece vacío (sin texto). En PC funciona correctamente.

**Causa:** `poi-title` es la capa superior y originalmente **no tenía click handler**. En Android, los glyphs de texto (del servidor `cdn.traccar.com/map/fonts/`) a veces no cargan, haciendo que el texto no se renderice. Al tocar el POI, el click caía en `poi-title` (capa superior sin handler) y el popup nunca se abría.

**Solución aplicada:**
1. Click handlers registrados en **las 5 capas** (no solo `poi-point` y `poi-circle`)
2. `localIdeographFontFamily: 'sans-serif'` en `MapView.jsx` — usa fuentes locales del dispositivo como fallback
3. `background:white;color:black` explícito en el HTML del popup para evitar herencia de CSS

## Despliegue

Ver [`../CLAUDE.md`](../CLAUDE.md) y [`docs/deploy.md`](docs/deploy.md) para el flujo completo (Dockerfile multi-stage, Portainer API, deploy.sh).

### Dockerfile (en este repo)

**Multi-stage build** — compila y parchea el backend sin requerir JDK en el host:

```dockerfile
# Stage 1: Compilar OverrideTextFilter.java con defaults RudaTrak
FROM eclipse-temurin:21-jdk AS builder
WORKDIR /build
COPY --from=traccar/traccar:latest /opt/traccar/tracker-server.jar /build/original.jar
COPY --from=traccar/traccar:latest /opt/traccar/lib /build/lib
COPY docker/ /build/src/
RUN javac -cp "original.jar:lib/*" -d /build/classes \
        /build/src/org/traccar/web/OverrideTextFilter.java && \
    cp original.jar patched.jar && \
    jar uf patched.jar -C /build/classes org/traccar/web/OverrideTextFilter.class

# Stage 2: Imagen final
FROM traccar/traccar:latest
COPY --from=builder /build/patched.jar /opt/traccar/tracker-server.jar
COPY build/ /opt/traccar/web/
RUN rm -f /opt/traccar/web/poi/general.kml 2>/dev/null || true
```

**Fuente Java:** `docker/org/traccar/web/OverrideTextFilter.java` — copia del fuente modificado que usa el builder.

**Decoder Rinho:** `docker/org/traccar/protocol/RinhoProtocolDecoder.java` — copia del decoder que debe mantenerse sincronizada con `traccar/src/main/java/org/traccar/protocol/RinhoProtocolDecoder.java`. Si se modifica el decoder en el repo `traccar` y no se sincroniza esta copia, el deploy usará el decoder antiguo. Ver [`docs/GPS_RINHO/protocolo-rinho.md`](docs/GPS_RINHO/protocolo-rinho.md) para documentación completa del protocolo.

**AlarmEventHandler:** `docker/org/traccar/handler/events/AlarmEventHandler.java` — copia del handler que propaga `eventDescription` de la posición al evento. Debe sincronizarse con `traccar/src/main/java/org/traccar/handler/events/AlarmEventHandler.java`. Sin este parche, la UI muestra el tipo genérico de alarma ("General", "Alarma de fallo") en vez de la descripción en español del decoder Rinho.

### docker-compose.yml

- `traccar`: imagen `rudatrak:latest`, redes `npm_proxy-network`, volúmenes para data/poi/logs
- `carga-poi`: imagen `carga-poi:latest`, puerto `3007`, volumen para el KML general
- `pull_policy: never` — nunca descargar de registry, siempre usar imagen local

### Gotchas de deploy

- **Contenedor no se actualiza:** `docker compose up -d` sin `--force-recreate` no recrea contenedores si el compose file no cambió, aunque la imagen sí haya cambiado. Solución: usar Portainer API (redeploy del stack) o `docker compose up -d --force-recreate`.
- **Service worker cache:** después de un deploy, el SW puede seguir sirviendo archivos viejos. Para forzar actualización en el navegador: hacer clic en el banner "Hay una nueva versión" → "Actualizar", o Configuración → Datos de sitios → eliminar datos del sitio, o usar modo incógnito. **Si no se actualiza, la UI ejecuta código viejo y cambios como `eventDescription` no se ven.**
- **Caché de capas Docker:** `deploy.sh` puede usar capas cacheadas del builder (dice `CACHED [builder 6/6]`) y no recompilar aunque cambien los fuentes. Si los cambios en `docker/` no se reflejan, usar `docker build --no-cache` manualmente.
- **Branding no se actualiza:** verificar con `curl -s https://gps.rudatrak.com/manifest.webmanifest | grep RudaTrak`. Si dice "Traccar", el build Docker no parcheó el JAR correctamente o el contenedor no se recreó.
- **Primer build lento:** `docker build` descarga `eclipse-temurin:21-jdk` (~400 MB) la primera vez. Builds posteriores usan la capa cacheada.
- **Decoder Rinho no se actualiza:** si después de un deploy los nuevos códigos de alarma no funcionan, verificar que `docker/org/traccar/protocol/RinhoProtocolDecoder.java` esté sincronizado con el fuente canónico en `traccar/src/.../`. El Dockerfile usa esta copia para parchear el JAR. Sin sync, el contenedor corre con el decoder antiguo.
- **AlarmEventHandler no se actualiza:** ídem anterior. El fuente canónico es `traccar/src/main/java/org/traccar/handler/events/AlarmEventHandler.java` y la copia para Docker está en `docker/org/traccar/handler/events/AlarmEventHandler.java`. Sin sync, `eventDescription` no se propaga de la posición al evento.
- **Fuentes/glyphs en Android:** `cdn.traccar.com/map/fonts/` a veces no es accesible desde Android. El texto de capas symbol no se renderiza sin glyphs. `localIdeographFontFamily: 'sans-serif'` ayuda con caracteres CJK. Para texto latino, el popup HTML es el mecanismo confiable para mostrar información.

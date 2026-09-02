# App móvil RudaTrak offline (mapa + POIs) — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App Android (Capacitor) que envuelve el frontend actual y permite descargar zonas del mapa (Argenmap/IGN) y los POIs (`general.kml`) para usarlos sin conexión.

**Architecture:** Un solo build de Vite, dos destinos (web sin cambios + shell Capacitor). En nativo, un bootstrap redirige las llamadas `/api` y el WebSocket al servidor RudaTrak, y un gestor de descargas baja tiles raster TMS del IGN por zona a Filesystem, que MapLibre lee vía un protocolo `offline://`. Los POIs se precargan (KML + íconos) y `PoiMap` los lee local.

**Tech Stack:** React 19, Vite 8, MapLibre GL 5, Material UI 9, Capacitor 7 (core/cli/android/filesystem/network), `capacitor-community/sqlite`, Vitest (solo para `tileMath`).

**Spec:** `docs/superpowers/specs/2026-09-01-app-movil-offline-design.md`

## Global Constraints

- **Solo JavaScript/JSX** (`.js`/`.jsx`). Prohibido TypeScript en `src/` — `capacitor.config.ts` es la única excepción (tooling de Capacitor, no código de app).
- **No hay test suite de frontend.** Vitest se introduce únicamente para `tileMath.js`. El resto se valida manualmente.
- **Lint:** `npm run lint` debe pasar con `--max-warnings 0` en cada commit.
- **No hardcodear branding en `vite.config.js`/`index.html`** — los placeholders `${title}`, `${description}`, `${colorPrimary}` se mantienen para el backend (web). En nativo el nombre de la app sale de `capacitor.config.ts` (`appName`), no del `index.html`.
- **Atribución IGN obligatoria** en el mapa offline: "FUENTE: Instituto Geográfico Nacional de la República Argentina".
- **Servidor RudaTrak:** no se cambia código; solo se apunta la app a su URL (`https://mh.rudatrak.com` por defecto).
- **Fuente de tiles:** los tiles raster se descargan de `wms.ign.gob.ar` (IGN), **no** de `mh.rudatrak.com`. El servidor RudaTrak solo sirve POIs (un KML de 4 MB + íconos), no tiles.
- **TMS vs XYZ:** el IGN sirve TMS (`{-y}` invertido). Internamente se trabaja en XYZ (convención MapLibre) y se convierte solo al construir la URL de descarga.
- **Comandos de build:** `npm start` (dev, puerto 3001), `npm run build` (→ `build/`), `npm run lint`.

---

### Task 1: Shell Capacitor + bootstrap nativo de red

**Files:**
- Create: `capacitor.config.ts`
- Create: `src/offline/nativeBootstrap.js`
- Modify: `src/index.jsx`
- Modify: `package.json` (deps + script)

**Interfaces:**
- Consumes: nada (primera tarea).
- Produces: `initNativeBootstrap()` (void) — export de `src/offline/nativeBootstrap.js`; `nativeEnvironment` booleano global accesible vía `Capacitor.isNativePlatform()`.

- [ ] **Step 1: Instalar Capacitor y crear la config**

```bash
cd /mnt/Datos/app/RudaTrak/traccar/traccar-web
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/filesystem @capacitor/preferences capacitor-community/sqlite
npx cap init "RudaTrak" "com.rudatrak.app" --web-dir build
```

Crear `capacitor.config.ts` (si `cap init` no lo generó como `.ts`):

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rudatrak.app',
  appName: 'RudaTrak',
  webDir: 'build',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorHttp: { enabled: true },
  },
};

export default config;
```

- [ ] **Step 2: Escribir el bootstrap nativo que redirige `/api` y el WebSocket**

Crear `src/offline/nativeBootstrap.js`:

```js
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const DEFAULT_SERVER = 'https://mh.rudatrak.com';

let serverUrl = DEFAULT_SERVER;

export const isNative = () => Capacitor.isNativePlatform();

export const getServerUrl = () => serverUrl;

export const initNativeBootstrap = async () => {
  if (!isNative()) return;

  const { value } = await Preferences.get({ key: 'serverUrl' });
  if (value) serverUrl = value;

  const base = serverUrl.replace(/\/+$/, '');

  // Parchea fetch para resolver rutas relativas /api/... y /poi/... contra el servidor.
  // Solo interfiere con strings que empiezan con "/" o con Request cuya url lo haga.
  // Un URL object relativo no puede construirse sin base, así que no es un caso real.
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch(`${base}${input}`, init);
    }
    if (input instanceof Request && input.url.startsWith('/')) {
      return originalFetch(`${base}${input.url}`, input);
    }
    return originalFetch(input, init);
  };

  // Parchea WebSocket para apuntar al host del servidor. Se usa herencia de clase
  // para que onopen/onmessage/onerror y send() se hereden intactos.
  // SocketController arma `${protocol}//${window.location.host}/api/socket`; en nativo
  // location.host es "localhost", así que hay que reescribir el host además de la ruta.
  const serverHost = base.replace(/^https?:\/\//, '');
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      if (typeof url === 'string') {
        if (url.startsWith('/')) {
          url = `${base.replace(/^http/, 'ws')}${url}`;
        } else if (url.includes(window.location.host)) {
          url = url.replace(window.location.host, serverHost);
        }
      }
      super(url, protocols);
    }
  };
};

// API para que la UI de login/cambio de servidor pueda actualizar la URL.
export const setServerUrl = async (url) => {
  serverUrl = url;
  await Preferences.set({ key: 'serverUrl', value: url });
};
```

- [ ] **Step 3: Inicializar el bootstrap al arrancar**

En `src/index.jsx`, inmediatamente después de los imports y antes de montar el provider tree, agregar:

```js
import { initNativeBootstrap } from './offline/nativeBootstrap';

initNativeBootstrap().then(() => {
  // montar la app (mover el createRoot existente adentro de este then)
});
```

Si el `createRoot(...).render(...)` actual es síncrono, envolverlo: llamar `initNativeBootstrap()` y, en el `.then`, ejecutar el render. La app web (no nativa) resuelve `initNativeBootstrap` como no-op inmediato, así que el render no se retrasa.

- [ ] **Step 4: Verificar el build web no se rompe**

Run: `npm run build` y `npm run lint`
Expected: build y lint pasan. En la web, `initNativeBootstrap` es no-op (no nativo), comportamiento idéntico.

- [ ] **Step 5: Generar el proyecto Android y verificar login online**

```bash
npm run build
npx cap add android
npx cap sync
npx cap open android   # abre Android Studio; o:
cd android && ./gradlew assembleDebug
```

Expected: se genera `android/app/build/outputs/apk/debug/app-debug.apk`. Instalarlo en un dispositivo y verificar que (con internet) el login contra `https://mh.rudatrak.com` funciona y que el WebSocket conecta (posiciones en vivo).

**Nota CORS:** si el login/`/api/server` falla con error CORS en el WebView, activar `CapacitorHttp` (ya habilitado en la config) hace que `fetch` use el stack HTTP nativo sin CORS. Si aún así falla, configurar la preferencia `web.origin` del servidor para permitir `https://localhost` — ese es el único ajuste de servidor tolerable.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: shell Capacitor y bootstrap nativo de red"
```

---

### Task 2: `tileMath` (TDD)

**Files:**
- Create: `src/offline/tileMath.js`
- Test: `src/offline/tileMath.test.js`
- Modify: `package.json` (dep `vitest`, script `test`)
- Create: `vitest.config.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `tilesForBbox(bbox, minZoom, maxZoom)` → `[{z, x, y}]` en XYZ (y normal, no TMS). `bbox = [west, south, east, north]`.
  - `tmsY(z, y)` → `number` (invierte y: `2^z - 1 - y`).
  - `tileCount(bbox, minZoom, maxZoom)` → `number`.
  - `tileToUrl(layer, z, x, y)` → `string` (URL TMS del IGN con `tmsY`).

- [ ] **Step 1: Instalar Vitest y el script**

```bash
npm i -D vitest
```

En `package.json` agregar script `"test": "vitest run"`.

- [ ] **Step 2: Escribir el test que falla**

Crear `src/offline/tileMath.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { tilesForBbox, tmsY, tileCount, tileToUrl } from './tileMath';

describe('tilesForBbox', () => {
  it('devuelve un solo tile en zoom 0 para el mundo entero', () => {
    expect(tilesForBbox([-180, -85.05112878, 180, 85.05112878], 0, 0)).toEqual([
      { z: 0, x: 0, y: 0 },
    ]);
  });

  it('cubre un bbox pequeño con 4 tiles en zoom 1', () => {
    // bbox dentro del cuadrante noroeste (x=0, y=0 en zoom 1)
    const tiles = tilesForBbox([-180, 0, 0, 85.05112878], 1, 1);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual({ z: 1, x: 0, y: 0 });
  });

  it('genera tiles para todos los niveles entre minZoom y maxZoom', () => {
    const tiles = tilesForBbox([-58.5, -35, -58.4, -34.9], 10, 11);
    const zooms = new Set(tiles.map((t) => t.z));
    expect(zooms).toEqual(new Set([10, 11]));
  });
});

describe('tmsY', () => {
  it('invierte y para TMS', () => {
    expect(tmsY(2, 0)).toBe(3);
    expect(tmsY(2, 3)).toBe(0);
  });
});

describe('tileCount', () => {
  it('cuenta los tiles de un bbox en un rango de zoom', () => {
    const count = tileCount([-58.5, -35, -58.4, -34.9], 10, 10);
    expect(count).toBe(tilesForBbox([-58.5, -35, -58.4, -34.9], 10, 10).length);
  });
});

describe('tileToUrl', () => {
  it('construye la URL TMS del IGN con y invertida', () => {
    const url = tileToUrl('capabaseargenmap', 5, 10, 20);
    const invertedY = tmsY(5, 20);
    expect(url).toBe(
      `https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/capabaseargenmap@EPSG%3A3857@png/5/10/${invertedY}.png`,
    );
  });
});
```

- [ ] **Step 3: Ejecutar el test para verificar que falla**

Run: `npx vitest run src/offline/tileMath.test.js`
Expected: FAIL — "Cannot find module './tileMath'".

- [ ] **Step 4: Implementar `tileMath.js`**

Crear `src/offline/tileMath.js`:

```js
const MAX_LATITUDE = 85.05112878;

export const tmsY = (z, y) => (1 << z) - 1 - y;

const lonToTileX = (lon, z) => Math.floor(((lon + 180) / 360) * (1 << z));

const latToTileY = (lat, z) => {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, z);
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
};

export const tilesForBbox = (bbox, minZoom, maxZoom) => {
  const [west, south, east, north] = bbox;
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const x0 = lonToTileX(west, z);
    const x1 = lonToTileX(east, z);
    const y0 = latToTileY(north, z);
    const y1 = latToTileY(south, z);
    const max = (1 << z) - 1;
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        if (x < 0 || y < 0 || x > max || y > max) continue;
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
};

export const tileCount = (bbox, minZoom, maxZoom) =>
  tilesForBbox(bbox, minZoom, maxZoom).length;

const IGN_BASE = 'https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0';

export const tileToUrl = (layer, z, x, y) =>
  `${IGN_BASE}/${layer}@EPSG%3A3857@png/${z}/${x}/${tmsY(z, y)}.png`;
```

- [ ] **Step 5: Ejecutar el test para verificar que pasa**

Run: `npx vitest run src/offline/tileMath.test.js`
Expected: PASS (los 6 tests).

- [ ] **Step 5b: Validar la matemática contra un tile real del IGN**

Ata `tileMath` a la convención real del IGN para evitar el bug silencioso de tiles desplazados. Calcular el tile esperado con una fórmula slippy-map independiente y verificar que `tilesForBbox` lo incluye, y que la URL descargada devuelve un PNG real:

```js
import { tilesForBbox, tmsY, tileToUrl } from './src/offline/tileMath.js';
// Bahía Blanca centro
const lon = -62.264, lat = -38.719, z = 13;
const n = 2 ** z;
const x = Math.floor((lon + 180) / 360 * n);           // referencia slippy independiente
const latRad = lat * Math.PI / 180;
const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
const tiles = tilesForBbox([lon, lat, lon, lat], z, z);
console.log('esperado', { z, x, y, tmsY: tmsY(z, y) });
console.log('incluido', tiles.some((t) => t.z === z && t.x === x && t.y === y)); // true

const url = tileToUrl('capabaseargenmap', z, x, y);
console.log('url', url);  // termina en /z/x/{tmsY}.png
const r = await fetch(url);
console.log('png?', r.ok && r.headers.get('content-type')?.includes('png')); // true
```

Expected: `incluido: true`, `png?: true`. Si `png?` es `false`, revisar la URL TMS (puede que el IGN requiera otra capa o haya rate-limit; probar con `mapabase_topo`).

- [ ] **Step 6: Commit**

```bash
git add src/offline/tileMath.js src/offline/tileMath.test.js package.json package-lock.json vitest.config.js
git commit -m "feat: cálculo de tiles (tileMath) con tests"
```

---

### Task 3: `tileStore` (IO de tiles en Filesystem)

**Files:**
- Create: `src/offline/tileStore.js`

**Interfaces:**
- Consumes: `tilesForBbox` (Task 2).
- Produces (todas async):
  - `writeTile(layer, z, x, y, blob)` → `Promise<void>`
  - `readTile(layer, z, x, y)` → `Promise<ArrayBuffer | null>`
  - `removeTiles(layer, tiles)` → `Promise<void>` (borra los `{z,x,y}` dados)
  - `tilePath(layer, z, x, y)` → `string`

- [ ] **Step 1: Implementar `tileStore.js`**

Crear `src/offline/tileStore.js`:

```js
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

export const tilePath = (layer, z, x, y) => `tiles/${layer}/${z}/${x}/${y}.png`;

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

export const writeTile = async (layer, z, x, y, blob) => {
  const data = await blobToBase64(blob);
  await Filesystem.writeFile({
    path: tilePath(layer, z, x, y),
    data,
    directory: Directory.Data,
    recursive: true,
  });
};

export const readTile = async (layer, z, x, y) => {
  try {
    const result = await Filesystem.readFile({
      path: tilePath(layer, z, x, y),
      directory: Directory.Data,
    });
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
};

export const removeTiles = async (layer, tiles) => {
  await Promise.all(
    tiles.map(({ z, x, y }) =>
      Filesystem.deleteFile({
        path: tilePath(layer, z, x, y),
        directory: Directory.Data,
      }).catch(() => {}),
    ),
  );
};
```

- [ ] **Step 2: Verificación manual (dentro de Task 1 app corriendo)**

En el WebView, desde la consola de la app (o un botón temporal), ejecutar:

```js
const { writeTile, readTile } = await import('./src/offline/tileStore.js');
await writeTile('test', 0, 0, 0, new Blob(['x'], { type: 'image/png' }));
const buf = await readTile('test', 0, 0, 0);
console.log('bytes:', new Uint8Array(buf)); // [120] = 'x'
```

Expected: `bytes` es `[120]`. (Este paso se automatiza de forma más limpia en la Task 4 al leer tiles reales.)

- [ ] **Step 3: Commit**

```bash
git add src/offline/tileStore.js
git commit -m "feat: tileStore para IO de tiles en Filesystem"
```

---

### Task 4: `offlineProtocol` (MapLibre lee tiles locales)

**Files:**
- Create: `src/offline/offlineProtocol.js`

**Interfaces:**
- Consumes: `readTile` (Task 3).
- Produces: `registerOfflineProtocol()` → `void`.

- [ ] **Step 1: Implementar `offlineProtocol.js`**

Crear `src/offline/offlineProtocol.js`:

```js
import maplibregl from 'maplibre-gl';
import { readTile } from './tileStore';

// URL: offline://{layer}/{z}/{x}/{y}
export const registerOfflineProtocol = () => {
  if (maplibregl.getProtocol('offline')) return;
  maplibregl.addProtocol('offline', async (params, callback) => {
    const [, layer, z, x, y] = params.url.replace('offline://', '').split('/');
    try {
      const buffer = await readTile(layer, Number(z), Number(x), Number(y));
      if (buffer) {
        callback(null, buffer);
      } else {
        callback(new Error('tile not found'));
      }
    } catch (error) {
      callback(error);
    }
  });
};
```

- [ ] **Step 2: Verificar que MapLibre no rompe al registrar (web)**

En `src/index.jsx`, agregar `registerOfflineProtocol();` justo después de `initNativeBootstrap()`. (El protocolo es inerte en la web hasta que un estilo `offline://` lo use.)

Run: `npm run build`
Expected: build pasa.

- [ ] **Step 3: Spike — validar lectura real en Android WebView**

En el dispositivo, descargar 1 tile manualmente (vía `tileToUrl('capabaseargenmap', 5, 10, 20)` en un `fetch`), guardarlo con `writeTile`, y crear un mapa temporal con estilo:

```js
map.setStyle({
  version: 8,
  sources: { offline: { type: 'raster', tiles: ['offline://capabaseargenmap/{z}/{x}/{y}'], tileSize: 256 } },
  layers: [{ id: 'offline', type: 'raster', source: 'offline' }],
});
```

Expected: el tile se renderiza. Si `offline://` no funciona (CORS/esquema), **plan B**: registrar el protocolo sobre `capacitor://`/`https://localhost` sirviendo desde un directorio accesible, o usar un mini-servidor local. Documentar la decisión en el commit.

- [ ] **Step 4: Commit**

```bash
git add src/offline/offlineProtocol.js src/index.jsx
git commit -m "feat: protocolo offline:// de MapLibre"
```

---

### Task 5: Estilos offline + selector online/offline

**Files:**
- Modify: `src/map/core/useMapStyles.js`
- Modify: `src/map/core/MapView.jsx`
- Create: `src/offline/useOnlineStatus.js`

**Interfaces:**
- Consumes: `isNative` (Task 1), `registerOfflineProtocol` (Task 4).
- Produces: `useOnlineStatus()` → `boolean` (hook, `navigator.onLine` reactivo).

- [ ] **Step 1: Hook de estado online**

Crear `src/offline/useOnlineStatus.js`:

```js
import { useEffect, useState } from 'react';

export const useOnlineStatus = () => {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
};
```

- [ ] **Step 2: Agregar estilos offline a `useMapStyles.js`**

Al array devuelto por `useMapStyles`, anteponer (solo en nativo):

```js
import { isNative } from '../../offline/nativeBootstrap';

// dentro del useMemo, antes del resto:
...(isNative()
  ? [
      {
        id: 'offlineArgenmap',
        title: 'Argenmap (offline)',
        style: {
          version: 8,
          sources: {
            offline: {
              type: 'raster',
              tiles: ['offline://capabaseargenmap/{z}/{x}/{y}'],
              tileSize: 256,
              attribution: 'FUENTE: Instituto Geográfico Nacional de la República Argentina',
            },
          },
          layers: [{ id: 'offline', type: 'raster', source: 'offline' }],
        },
        available: true,
        offline: true,
      },
      {
        id: 'offlineTopo',
        title: 'Topográfico (offline)',
        style: {
          version: 8,
          sources: {
            offlineTopo: {
              type: 'raster',
              tiles: ['offline://mapabase_topo/{z}/{x}/{y}'],
              tileSize: 256,
              attribution: 'FUENTE: Instituto Geográfico Nacional de la República Argentina',
            },
          },
          layers: [{ id: 'offlineTopo', type: 'raster', source: 'offlineTopo' }],
        },
        available: true,
        offline: true,
      },
    ]
  : []),
```

- [ ] **Step 3: Cambiar `MapView.jsx` para priorizar offline cuando no hay red**

En `MapView`, obtener `online` de `useOnlineStatus()`. Cuando `!online`, filtrar los `styles` a solo los `offline: true` y forzar `selectedStyleId` al primer estilo offline. Concretamente, reemplazar el `useMemo` de `styles` por:

```js
const online = useOnlineStatus();
const styles = useMemo(() => {
  const filtered = mapStyles.filter((s) => s.available && activeMapStyles.includes(s.id));
  const base = filtered.length ? filtered : mapStyles.filter((s) => s.id === 'osm');
  if (!online) {
    const offline = base.filter((s) => s.offline);
    return offline.length ? offline : base;
  }
  return base;
}, [mapStyles, activeMapStyles, online]);
```

- [ ] **Step 4: Verificar en dispositivo**

En la app, activar modo avión: el MapSwitcher debe mostrar solo los estilos offline, y el mapa debe cambiar a `offline://` (mostrando huecos/gris donde no hay tiles descargados). Al volver online, vuelven los estilos remotos.

Run: `npm run lint` → Expected: sin warnings.

- [ ] **Step 5: Commit**

```bash
git add src/map/core/useMapStyles.js src/map/core/MapView.jsx src/offline/useOnlineStatus.js
git commit -m "feat: estilos offline y selector online/offline"
```

---

### Task 6: `OfflineManager` (SQLite + descarga de zonas)

**Files:**
- Create: `src/offline/OfflineManager.js`

**Interfaces:**
- Consumes: `tilesForBbox`, `tileCount`, `tileToUrl` (Task 2); `writeTile`, `removeTiles` (Task 3); `isNative` (Task 1).
- Produces:
  - `initOfflineDb()` → `Promise<void>`
  - `downloadZone({ id, name, layer, bbox, minZoom, maxZoom, onProgress })` → `Promise<void>` (`onProgress(done, total)`)
  - `deleteZone(id)` → `Promise<void>`
  - `listZones()` → `Promise<Zone[]>`
  - `Zone = { id, name, layer, minLng, minLat, maxLng, maxLat, minZoom, maxZoom, tileCount, createdAt }`

- [ ] **Step 1: Implementar `OfflineManager.js`**

Crear `src/offline/OfflineManager.js`:

```js
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from 'capacitor-community/sqlite';
import { tilesForBbox, tileCount, tileToUrl } from './tileMath';
import { writeTile, removeTiles } from './tileStore';

const sqlite = new SQLiteConnection(CapacitorSQLite);
let db = null;

const CONCURRENCY = 4;

export const initOfflineDb = async () => {
  if (db) return;
  db = await sqlite.createConnection('rudatrak-offline', false, 'no-encryption', 1, false);
  await db.open();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS zones (
      id TEXT PRIMARY KEY,
      name TEXT,
      layer TEXT,
      minLng REAL, minLat REAL, maxLng REAL, maxLat REAL,
      minZoom INTEGER, maxZoom INTEGER,
      tileCount INTEGER, createdAt TEXT
    );
  `);
};

const zoneFromRow = (row) => ({
  id: row.id,
  name: row.name,
  layer: row.layer,
  minLng: row.minLng,
  minLat: row.minLat,
  maxLng: row.maxLng,
  maxLat: row.maxLat,
  minZoom: row.minZoom,
  maxZoom: row.maxZoom,
  tileCount: row.tileCount,
  createdAt: row.createdAt,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchTile = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.blob();
};

export const downloadZone = async ({ id, name, layer, bbox, minZoom, maxZoom, onProgress }) => {
  await initOfflineDb();
  const tiles = tilesForBbox(bbox, minZoom, maxZoom);
  const total = tiles.length;
  let done = 0;

  // Los tiles se descargan del IGN (wms.ign.gob.ar), NO del servidor RudaTrak.
  // Concurrencia 4 + backoff exponencial para no disparar rate-limiting del IGN.
  // Un tile corrupto (200 OK con data inválida) se deja sin escribir → hueco gris;
  // el usuario puede re-descargar la zona. Es un comportamiento aceptado y documentado.
  const worker = async () => {
    while (tiles.length) {
      const tile = tiles.shift();
      const url = tileToUrl(layer, tile.z, tile.x, tile.y);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const blob = await fetchTile(url);
          await writeTile(layer, tile.z, tile.x, tile.y, blob);
          break;
        } catch {
          if (attempt === 1) {
            // segundo intento falló: hueco visible, no se bloquea la descarga.
          } else {
            await sleep(250 * (attempt + 1)); // backoff 250ms
          }
        }
      }
      done += 1;
      onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  await db.execute(
    'INSERT OR REPLACE INTO zones (id, name, layer, minLng, minLat, maxLng, maxLat, minZoom, maxZoom, tileCount, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      name,
      layer,
      bbox[0],
      bbox[1],
      bbox[2],
      bbox[3],
      minZoom,
      maxZoom,
      total,
      new Date().toISOString(),
    ],
  );
};

export const deleteZone = async (id) => {
  await initOfflineDb();
  const result = await db.query('SELECT * FROM zones WHERE id = ?', [id]);
  if (result.values?.length) {
    const zone = zoneFromRow(result.values[0]);
    const tiles = tilesForBbox(
      [zone.minLng, zone.minLat, zone.maxLng, zone.maxLat],
      zone.minZoom,
      zone.maxZoom,
    );
    await removeTiles(zone.layer, tiles);
  }
  await db.execute('DELETE FROM zones WHERE id = ?', [id]);
};

export const listZones = async () => {
  await initOfflineDb();
  const result = await db.query('SELECT * FROM zones ORDER BY createdAt DESC');
  return (result.values ?? []).map(zoneFromRow);
};
```

- [ ] **Step 2: Verificar en dispositivo**

Desde la consola de la app, invocar una descarga pequeña (bbox de 0.01° en zoom 12):

```js
const { downloadZone, listZones } = await import('./src/offline/OfflineManager.js');
await downloadZone({ id: 'z1', name: 'Test', layer: 'capabaseargenmap', bbox: [-58.5, -35.0, -58.4, -34.9], minZoom: 12, maxZoom: 12, onProgress: (d, t) => console.log(d, '/', t) });
console.log(await listZones());
```

Expected: lista la zona, y el mapa offline (Task 5) la renderiza.

- [ ] **Step 3: Commit**

```bash
git add src/offline/OfflineManager.js
git commit -m "feat: OfflineManager con SQLite y descarga de zonas"
```

---

### Task 7: UI de descarga (`DownloadZoneDialog`)

**Files:**
- Create: `src/offline/DownloadZoneDialog.jsx`
- Modify: `src/main/MainPage.jsx` (o donde se monta el toolbar del mapa) para abrir el diálogo

**Interfaces:**
- Consumes: `downloadZone` (Task 6); `map` singleton de `src/map/core/MapView` (bbox de la vista actual).
- Produces: componente `DownloadZoneDialog` con props `{ open, onClose }`.

- [ ] **Step 1: Implementar `DownloadZoneDialog.jsx`**

Crear `src/offline/DownloadZoneDialog.jsx`:

```jsx
import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button,
  FormControl, InputLabel, Select, MenuItem, LinearProgress, Typography,
} from '@mui/material';
import { downloadZone } from './OfflineManager';
import { tileCount } from './tileMath';
import { map } from '../map/core/MapView';

const LAYERS = [
  { id: 'capabaseargenmap', label: 'Argenmap' },
  { id: 'mapabase_topo', label: 'Topográfico' },
];

export const DownloadZoneDialog = ({ open, onClose }) => {
  const [layer, setLayer] = useState('capabaseargenmap');
  const [maxZoom, setMaxZoom] = useState(14);
  const [progress, setProgress] = useState(null); // {done, total}

  const bbox = () => {
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  };

  const estimate = () => tileCount(bbox(), 5, maxZoom);

  const start = async () => {
    const [minLng, minLat, maxLng, maxLat] = bbox();
    const id = `${layer}-${Date.now()}`;
    setProgress({ done: 0, total: estimate() });
    await downloadZone({
      id,
      name: `${layer} ${new Date().toLocaleDateString()}`,
      layer,
      bbox: [minLng, minLat, maxLng, maxLat],
      minZoom: 5,
      maxZoom,
      onProgress: (done, total) => setProgress({ done, total }),
    });
    setProgress(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Descargar zona</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Se descargará el área visible del mapa (mínimo zoom 5).
          Tiles estimados: {estimate().toLocaleString()}
        </Typography>
        <FormControl fullWidth sx={{ mb: 2 }}>
          <InputLabel>Capa</InputLabel>
          <Select value={layer} onChange={(e) => setLayer(e.target.value)} label="Capa">
            {LAYERS.map((l) => (
              <MenuItem key={l.id} value={l.id}>{l.label}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel>Zoom máximo</InputLabel>
          <Select value={maxZoom} onChange={(e) => setMaxZoom(e.target.value)} label="Zoom máximo">
            {[11, 12, 13, 14, 15, 16].map((z) => (
              <MenuItem key={z} value={z}>{z}</MenuItem>
            ))}
          </Select>
        </FormControl>
        {progress && (
          <LinearProgress
            variant="determinate"
            value={(progress.done / progress.total) * 100}
            sx={{ mt: 2 }}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={!!progress}>Cancelar</Button>
        <Button onClick={start} disabled={!!progress} variant="contained">Descargar</Button>
      </DialogActions>
    </Dialog>
  );
};
```

- [ ] **Step 2: Montar el diálogo desde el toolbar del mapa**

En `MainPage` (o el componente que ya agrega botones al mapa), agregar un botón "Descargar zona" (ícono `Download` de MUI) que setee estado y renderice `<DownloadZoneDialog open={...} onClose={...} />`. Si `MainPage` no existe con ese nombre, localizar el toolbar del mapa con `grep -rn "MapSwitcher" src/` y montar el botón al lado.

- [ ] **Step 3: Verificar en dispositivo**

Descargar una zona pequeña con WiFi, ver el progreso, y luego (modo avión) ver que el mapa la muestra.

- [ ] **Step 4: Commit**

```bash
git add src/offline/DownloadZoneDialog.jsx src/main/MainPage.jsx
git commit -m "feat: diálogo de descarga de zonas"
```

---

### Task 8: `ZonesPage` (listar/borrar)

**Files:**
- Create: `src/offline/ZonesPage.jsx`
- Modify: `src/Navigation.jsx` (ruta `/offline`)

**Interfaces:**
- Consumes: `listZones`, `deleteZone` (Task 6).
- Produces: componente `ZonesPage` (ruta `/offline`).

- [ ] **Step 1: Implementar `ZonesPage.jsx`**

Crear `src/offline/ZonesPage.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { List, ListItem, ListItemText, IconButton, Typography, Container } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { listZones, deleteZone } from './OfflineManager';

export const ZonesPage = () => {
  const [zones, setZones] = useState([]);

  const refresh = async () => setZones(await listZones());

  useEffect(() => {
    refresh();
  }, []);

  const remove = async (id) => {
    await deleteZone(id);
    refresh();
  };

  return (
    <Container maxWidth="sm">
      <Typography variant="h6" sx={{ my: 2 }}>Zonas descargadas</Typography>
      {zones.length === 0 && <Typography color="text.secondary">No hay zonas descargadas.</Typography>}
      <List>
        {zones.map((z) => (
          <ListItem
            key={z.id}
            secondaryAction={
              <IconButton edge="end" onClick={() => remove(z.id)}>
                <DeleteIcon />
              </IconButton>
            }
          >
            <ListItemText
              primary={z.name}
              secondary={`${z.layer} · zoom ${z.minZoom}–${z.maxZoom} · ${z.tileCount} tiles · ${new Date(z.createdAt).toLocaleDateString()}`}
            />
          </ListItem>
        ))}
      </List>
    </Container>
  );
};
```

- [ ] **Step 2: Registrar la ruta en `Navigation.jsx`**

Agregar `<Route path="/offline" element={<ZonesPage />} />` (con `React.lazy` como el resto de páginas) y un acceso desde el menú (BottomMenu o la página principal). Localizar el patrón de rutas lazy con `grep -n "React.lazy" src/Navigation.jsx`.

- [ ] **Step 3: Verificar en dispositivo**

Listar, borrar una zona, confirmar que desaparece del mapa offline.

- [ ] **Step 4: Commit**

```bash
git add src/offline/ZonesPage.jsx src/Navigation.jsx
git commit -m "feat: página de zonas descargadas"
```

---

### Task 9: POIs offline (`useOfflinePoi` + `PoiMap`)

**Files:**
- Create: `src/offline/useOfflinePoi.js`
- Modify: `src/map/main/PoiMap.js`

**Interfaces:**
- Consumes: `getServerUrl` (Task 1); `isNative` (Task 1).
- Produces:
  - `preloadPoiData()` → `Promise<void>` (baja KML + íconos a Filesystem)
  - `getLocalKmlText()` → `Promise<string | null>`
  - `getLocalIconPath(iconUrl)` → `Promise<string | null>` (ruta `offlineIcon://...` o null)

- [ ] **Step 1: Implementar `useOfflinePoi.js`**

Crear `src/offline/useOfflinePoi.js`:

```js
import { Directory, Filesystem } from '@capacitor/filesystem';
import { getServerUrl, isNative } from './nativeBootstrap';

const KML_PATH = 'poi/general.kml';

export const preloadPoiData = async () => {
  if (!isNative()) return;
  const base = getServerUrl().replace(/\/+$/, '');

  const kmlResponse = await fetch(`${base}/poi/general.kml`);
  if (kmlResponse.ok) {
    const kmlText = await kmlResponse.text();
    await Filesystem.writeFile({
      path: KML_PATH, data: kmlText, directory: Directory.Data, recursive: true,
    });
  }
  // Íconos: se precargan bajo demanda (PoiMap resuelve cada URL). Aquí solo se
  // deja constancia de que el KML local es la fuente de verdad offline.
};

export const getLocalKmlText = async () => {
  try {
    const result = await Filesystem.readFile({ path: KML_PATH, directory: Directory.Data });
    return result.data;
  } catch {
    return null;
  }
};

export const getLocalIconPath = async (iconUrl) => {
  // iconUrl es algo como "/poi/icons/feriar_vender.png". Se resuelve al servidor si online;
  // offline se deja como URL remota (el hueco se cubre con fallback de círculo en PoiMap).
  return null;
};
```

- [ ] **Step 2: Modificar `PoiMap.js` para leer el KML local**

En `src/map/main/PoiMap.js`, en el `useAsyncTask` que hoy hace `fetch(poiLayer)`, anteponer la lógica local:

```js
import { getLocalKmlText } from '../../offline/useOfflinePoi';

// reemplazar el cuerpo del useAsyncTask:
useAsyncTask(async ({ signal }) => {
  if (!poiLayer) return;
  let text;
  const local = await getLocalKmlText();
  if (local) {
    text = local;
  } else {
    const file = await fetch(poiLayer, { signal });
    text = await file.text();
  }
  const dom = new DOMParser().parseFromString(text, 'text/xml');
  setData(kml(dom));
}, [poiLayer]);
```

El fallback de ícono (círculo) ya existe en `PoiMap` (capa `poi-circle`), así que si un ícono no carga localmente, el punto se ve igualmente.

- [ ] **Step 3: Disparar la precarga al iniciar la app nativa**

En `src/index.jsx`, tras `initNativeBootstrap()`, llamar `preloadPoiData()` (best-effort, sin bloquear el arranque):

```js
import { preloadPoiData } from './offline/useOfflinePoi';
// dentro del .then del bootstrap:
preloadPoiData();
```

- [ ] **Step 4: Verificar en dispositivo**

Con internet: abrir la app, esperar la precarga, luego modo avión → los POIs siguen visibles.

- [ ] **Step 5: Commit**

```bash
git add src/offline/useOfflinePoi.js src/map/main/PoiMap.js src/index.jsx
git commit -m "feat: POIs offline (KML precargado)"
```

---

### Task 10: Modo visitante + arranque offline

**Files:**
- Modify: `src/ServerProvider.jsx`
- Modify: `src/App.jsx`
- Modify: `src/Navigation.jsx`

**Interfaces:**
- Consumes: `useOnlineStatus` (Task 5).
- Produces: `offline` flag global vía `useOnlineStatus`.

- [ ] **Step 1: `ServerProvider` no bloquea offline**

En `src/ServerProvider.jsx`, cuando `!online`, no mostrar el `Alert` de error ni el `Loader`; despachar un server por defecto y continuar. Cambiar el hook para leer `useOnlineStatus()` y:

```js
const online = useOnlineStatus();

useAsyncTask(async ({ signal }) => {
  if (!error && online) {
    // ... fetch /api/server (igual que hoy)
  } else if (!online && !initialized) {
    // servidor por defecto para el modo visitante offline
    dispatch(sessionActions.updateServer({ title: 'RudaTrak', colorPrimary: '#1976d2' }));
  }
}, [error, dispatch, online, initialized]);

// render: si initialized, children; si !online y !initialized, mostrar la app con el
// estado visitante (no Loader infinito). Si error && online, el Alert actual.
```

Ajustar el `render` para que, con `!online`, devuelva `children` en cuanto `initialized` sea verdadero (el dispatch del server default lo resuelve), sin `Loader`.

- [ ] **Step 2: `App` permite entrar como visitante offline**

En `src/App.jsx`, el `useAsyncTask` que hace `fetch('/api/session')` y redirige a `/login` si falla: cuando `!online`, saltarse el fetch y marcar la sesión como visitante (sin user). Concretamente, rodear la lógica de sesión con `if (online) { ... } else { /* visitante */ }` de modo que el layout (`/`) se renderice sin `user` (el mapa y POIs funcionan; los componentes que exigen `user` muestran estado vacío).

- [ ] **Step 3: Verificar en dispositivo**

Cerrar sesión, activar modo avión, abrir la app → el mapa abre en modo visitante mostrando tiles/POIs offline. Con internet, volver a login normal.

- [ ] **Step 4: Commit**

```bash
git add src/ServerProvider.jsx src/App.jsx src/Navigation.jsx
git commit -m "feat: modo visitante y arranque offline"
```

---

### Task 11: Integración final y validación end-to-end

**Files:** ninguno nuevo (posibles ajustes de estilo/lint).

- [ ] **Step 1: Lint y build**

Run: `npm run lint && npm run build && npx vitest run`
Expected: todo en verde.

- [ ] **Step 2: Checklist manual en dispositivo real**

- [ ] Descargar zona (Argenmap) con WiFi → progreso → completada.
- [ ] Descargar zona (topográfico) superpuesta.
- [ ] Modo avión → mapa offline visible, POIs visibles.
- [ ] Fuera de zona descargada → gris + aviso.
- [ ] Transición online↔offline sin recargar.
- [ ] Borrar zona → desaparece del mapa.
- [ ] Arranque en frío sin red → modo visitante.
- [ ] Atribución IGN visible en el mapa offline.

- [ ] **Step 3: Commit final**

```bash
git add -A
git commit -m "feat: integración final app móvil offline"
```

---

## Self-Review (resumen)

- **Cobertura del spec:** §4 (arquitectura) → Tasks 1,4,5; §5 (componentes) → Tasks 2–10; §6 (flujos) → Tasks 5,6,7,9,10; §7 (errores) → reintentos y tiles faltantes en Task 6, reanudación parcial en Task 6 (commit al final vía INSERT), modo visitante en Task 10; §8 (testing) → TDD en Task 2, spike en Task 4, manual en Tasks 3,6,7,8,9,10,11.
- **Gaps detectados en el spec y cubiertos aquí:** redirección de `/api` y WebSocket en nativo (Task 1) y arranque offline de `ServerProvider` (Task 10).
- **Consistencia de tipos:** `tilesForBbox` devuelve `{z,x,y}` en XYZ en todas las tareas; `tileToUrl` aplica `tmsY` una sola vez (Task 2) y no se vuelve a invertir en ninguna otra; `writeTile`/`readTile` usan la misma `tilePath`.

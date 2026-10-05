import { Directory, Filesystem } from '@capacitor/filesystem';
import { PMTiles } from 'pmtiles';
import { CapacitorPmtilesSource } from './pmtilesSource';
import { tileToBbox } from './tileMath';
import { findTileInZones, createZoneErrorLogger } from './findTile';

// Directorio dentro de Directory.Data donde se dejan los extractos .pmtiles.
// Un archivo presente en maps/ es, por convención, una "zona" offline.
const MAPS_DIR = 'maps';

let registryPromise = null;

// Loguea el primer error de lectura por zona; los siguientes de la misma zona se
// silencian para no repetir ruido en cada pedido de tile.
const logZoneError = createZoneErrorLogger();

const readdirOrEmpty = async (path, directory) => {
  try {
    const result = await Filesystem.readdir({ path, directory });
    return result.files ?? [];
  } catch {
    return [];
  }
};

// Lee el encabezado PMTiles de un archivo de maps/ y devuelve los datos de la zona
// (sin la fila de SQLite). Lo comparten el registro en memoria de este módulo y la
// reconciliación de mapDownloader. Devuelve null si el archivo es ilegible.
export const readZoneFile = async (name) => {
  const path = `${MAPS_DIR}/${name}`;
  const source = new CapacitorPmtilesSource(path, Directory.Data);
  const pmtiles = new PMTiles(source);
  try {
    // getHeader() lee el header una vez y lo deja cacheado en pmtiles.
    const header = await pmtiles.getHeader();
    const id = name.replace(/\.pmtiles$/i, '');
    return {
      id,
      name: id,
      path,
      pmtiles,
      minLon: header.minLon,
      minLat: header.minLat,
      maxLon: header.maxLon,
      maxLat: header.maxLat,
      minZoom: header.minZoom,
      maxZoom: header.maxZoom,
    };
  } catch {
    // Archivo corrupto o ilegible: se omite para no romper el render offline.
    return null;
  }
};

const doInitRegistry = async () => {
  const files = await readdirOrEmpty(MAPS_DIR, Directory.Data);
  // Orden estable por fecha de modificación descendente: la zona más reciente
  // queda primera (la usa OfflineCamera como fallback de encuadre).
  files.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  const zones = [];
  for (const file of files) {
    if (file.type !== 'file' || !file.name.toLowerCase().endsWith('.pmtiles')) continue;
    const zone = await readZoneFile(file.name);
    if (zone) zones.push(zone);
  }
  return zones;
};

// Devuelve siempre la misma promesa en vuelo para que los múltiples pedidos de
// tiles paralelos de MapLibre no disparen varias veces el descubrimiento.
export const initZoneRegistry = () => {
  if (!registryPromise) registryPromise = doInitRegistry();
  return registryPromise;
};

export const getZones = () => initZoneRegistry();

// Invalida el caché de la lista de archivos .pmtiles. El descargador lo llama tras
// registrar o borrar una zona para que el render offline vea el cambio sin reiniciar.
const zonesChangedListeners = new Set();

// Suscripción a cambios de zonas (se dispara al registrar o borrar una zona).
// Devuelve una función para desuscribirse. La usa el estilo offline para recalcular
// su maxzoom cuando el conjunto de zonas instaladas cambia.
export const onZonesChanged = (listener) => {
  zonesChangedListeners.add(listener);
  return () => zonesChangedListeners.delete(listener);
};

export const resetZoneRegistry = () => {
  registryPromise = null;
  zonesChangedListeners.forEach((listener) => listener());
};

// Tile MVT (ya descomprimido por pmtiles) para (z, x, y), o null si ninguna zona
// lo contiene. Se consultan las zonas cuyo bbox y rango de zoom lo cubren; una
// zona que falla al leer se loguea una sola vez y no interrumpe a las demás.
export const getTile = async (z, x, y) => {
  const zones = await initZoneRegistry();
  return findTileInZones(zones, z, x, y, tileToBbox(z, x, y), logZoneError);
};

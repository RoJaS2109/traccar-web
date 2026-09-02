import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { tilesForBbox, tileToUrl } from './tileMath';
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // Concurrencia 4 + backoff para no disparar rate-limiting del IGN.
  // Un tile corrupto (200 OK con data inválida) se deja sin escribir → hueco gris;
  // el usuario puede re-descargar la zona. Comportamiento aceptado y documentado.
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
            await sleep(250 * (attempt + 1));
          }
        }
      }
      done += 1;
      onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  await db.run(
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
  await db.run('DELETE FROM zones WHERE id = ?', [id]);
};

export const listZones = async () => {
  await initOfflineDb();
  const result = await db.query('SELECT * FROM zones ORDER BY createdAt DESC');
  return (result.values ?? []).map(zoneFromRow);
};

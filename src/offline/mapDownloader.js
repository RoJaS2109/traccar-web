import { Directory, Filesystem } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { getServerUrl, getSessionToken, isNative, setSessionToken } from './nativeBootstrap';
import { removeToken } from './tokenStore';
import { readZoneFile, resetZoneRegistry } from './zoneStore';
import {
  MapServiceError,
  mapHttpStatus,
  validatePmtilesSize,
  validatePmtilesHeader,
} from './mapService';

// Cliente del servicio trak-mapas (recorte de zonas .pmtiles) + registro SQLite de
// zonas descargadas. El render offline (zoneStore) sigue leyendo los archivos .pmtiles
// directamente del filesystem; este módulo solo se ocupa de descargar/validar/registrar
// y de la lista que muestra la UI.

const sqlite = new SQLiteConnection(CapacitorSQLite);
let db = null;

const MAPS_DIR = 'maps';
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 30 * 60 * 1000; // coincide con JOB_TIMEOUT_MS del servicio
const MAX_429_RETRIES = 5;
const MAX_DOWNLOAD_RUNNING_RETRIES = 10;

const getBase = () => `${getServerUrl().replace(/\/+$/, '')}/maps`;

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// El token vive en memoria (nativeBootstrap). Sin token no se consulta el servicio:
// la UI muestra "sesión requerida" en vez de disparar una llamada que va a fallar.
const requireToken = () => {
  const token = getSessionToken();
  if (!token) throw new MapServiceError('noToken', 'Se requiere una sesión iniciada');
  return token;
};

// Ante un 401 el token ya no es válido (expirado o revocado): se limpia memoria y
// SecureStorage. La UI, al recibir 'unauthorized', navega a /login (igual que App.jsx).
const clearSession = async () => {
  setSessionToken(null);
  await removeToken();
};

// fetch de un endpoint JSON del servicio, mapeando códigos de estado a errores tipados.
const requestJson = async (path, { token, method = 'GET', body } = {}) => {
  let res;
  try {
    res = await fetch(`${getBase()}${path}`, {
      method,
      headers: authHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new MapServiceError('network', 'Sin conexión con el servidor');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Cuerpo no-JSON: el error genérico de más abajo lo cubre.
  }
  const error = mapHttpStatus(res.status, data);
  if (error) {
    // 401 = token expirado/revocado: además de propagar el error, se limpia la sesión.
    if (error.code === 'unauthorized') await clearSession();
    throw error;
  }
  return data;
};

// Reintenta 429 (rate limit / extracción en curso) un número acotado de veces,
// esperando el Retry-After que indique el servicio.
const with429Retry = async (fn) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (error.code !== 'rateLimited' || attempt >= MAX_429_RETRIES) throw error;
      await sleep(Math.max(1000, (error.retryAfter ?? 15) * 1000));
    }
  }
};

// ---------------------------------------------------------------------------
// SQLite: tabla de zonas (metadatos para la lista). Migra desde la tabla raster
// vieja (sin columna filePath) descartándola: esas zonas apuntaban a tiles IGN ya
// obsoletos y no tienen archivo .pmtiles que renderizar.
// ---------------------------------------------------------------------------
const initDb = async () => {
  if (db) return db;
  db = await sqlite.createConnection('rudatrak-offline', false, 'no-encryption', 1, false);
  await db.open();
  await migrateZones(db);
  return db;
};

const migrateZones = async (conn) => {
  const info = await conn.query('PRAGMA table_info(zones)');
  const cols = (info.values ?? []).map((c) => c.name);
  if (cols.length > 0 && !cols.includes('filePath')) {
    await conn.execute('DROP TABLE zones');
  }
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      filePath TEXT NOT NULL,
      bbox TEXT NOT NULL,
      minZoom INTEGER NOT NULL,
      maxZoom INTEGER NOT NULL,
      sizeBytes INTEGER NOT NULL,
      tileCount INTEGER,
      buildVersion TEXT,
      createdAt TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `);
};

const zoneFromRow = (row) => ({
  id: row.id,
  name: row.name,
  filePath: row.filePath,
  bbox: JSON.parse(row.bbox),
  minZoom: row.minZoom,
  maxZoom: row.maxZoom,
  sizeBytes: row.sizeBytes,
  tileCount: row.tileCount,
  buildVersion: row.buildVersion,
  createdAt: row.createdAt,
  status: row.status,
});

// `buildVersion` identifica el base del que se recortó la zona (lo publica trak-mapas
// en /maps/version y lo devuelve el job). Queda null si el servidor no informa
// versión: en ese caso la UI no puede comparar y no marca nada por origen.
const registerZone = async ({
  id,
  name,
  filePath,
  bbox,
  minZoom,
  maxZoom,
  sizeBytes,
  tileCount,
  buildVersion = null,
}) => {
  const conn = await initDb();
  await conn.run(
    'INSERT OR REPLACE INTO zones (id, name, filePath, bbox, minZoom, maxZoom, sizeBytes, tileCount, buildVersion, createdAt, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      name,
      filePath,
      JSON.stringify(bbox),
      minZoom,
      maxZoom,
      sizeBytes,
      tileCount ?? null,
      buildVersion ?? null,
      new Date().toISOString(),
      'ready',
    ],
  );
};

// ---------------------------------------------------------------------------
// Validación del archivo .pmtiles descargado
// ---------------------------------------------------------------------------
const base64ToBytes = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const validatePmtiles = async (path, size, contentLength, lengthComputable) => {
  validatePmtilesSize({ size, contentLength, lengthComputable });
  const result = await Filesystem.readFile({
    path,
    directory: Directory.Data,
    offset: 0,
    length: 8,
  }).catch(() => null);
  if (!result?.data) {
    throw new MapServiceError('validation', 'No se pudo leer el archivo descargado');
  }
  validatePmtilesHeader(base64ToBytes(result.data));
};

// ---------------------------------------------------------------------------
// Descarga con @capacitor/file-transfer
// ---------------------------------------------------------------------------
const downloadToPart = async (jobId, partPath, token, onProgress, isCancelled) => {
  const url = `${getBase()}/zone/download/${jobId}`;
  const { uri } = await Filesystem.getUri({ path: partPath, directory: Directory.Data });
  await Filesystem.mkdir({ path: MAPS_DIR, directory: Directory.Data, recursive: true }).catch(
    () => {},
  );

  let contentLength = 0;
  let lengthComputable = false;

  const handle = await FileTransfer.addListener('progress', (status) => {
    if (status.url !== url) return;
    lengthComputable = status.lengthComputable;
    contentLength = status.contentLength;
    onProgress?.({
      bytes: status.bytes,
      contentLength: status.contentLength,
      lengthComputable: status.lengthComputable,
    });
  });

  try {
    await FileTransfer.downloadFile({
      url,
      path: uri,
      progress: true,
      headers: { Authorization: `Bearer ${token}` },
      readTimeout: 60_000,
    });
  } catch (error) {
    const httpStatus = error?.data?.httpStatus;
    if (httpStatus === 401) {
      await clearSession();
      throw new MapServiceError('unauthorized', 'Sesión expirada o revocada', { status: 401 });
    }
    if (httpStatus === 404)
      throw new MapServiceError('notFound', 'El archivo ya no está disponible', { status: 404 });
    if (httpStatus === 409)
      throw new MapServiceError('downloadRunning', 'La extracción aún no terminó', { status: 409 });
    if (httpStatus === 410)
      throw new MapServiceError('gone', 'La extracción falló', { status: 410 });
    // Sin httpStatus: pudo ser un fallo de escritura en disco (sin espacio), un corte
    // de red a mitad de descarga o un timeout. El `exception` nativo de Android trae el
    // mensaje real ("No space left on device", ENOSPC, etc.), que permite distinguirlo.
    if (isCancelled?.()) throw new MapServiceError('cancelled', 'Descarga cancelada');
    const exception = `${error?.data?.exception ?? ''} ${error?.data?.message ?? ''}`;
    if (
      /ENOSPC|no space|insufficient (space|storage|memory)|space left|disk full|out of (disk )?space/i.test(
        exception,
      )
    ) {
      throw new MapServiceError('noSpace', 'No hay espacio suficiente en el dispositivo');
    }
    throw new MapServiceError('network', 'Se perdió la conexión durante la descarga', {
      status: httpStatus ?? 0,
    });
  } finally {
    await handle.remove().catch(() => {});
  }

  if (isCancelled?.()) throw new MapServiceError('cancelled', 'Descarga cancelada');
  return { contentLength, lengthComputable };
};

const pollJob = async (jobId, token, isCancelled) => {
  const start = Date.now();
  for (;;) {
    if (isCancelled?.()) throw new MapServiceError('cancelled', 'Descarga cancelada');
    if (Date.now() - start > MAX_POLL_MS) {
      throw new MapServiceError('timeout', 'La extracción tardó demasiado');
    }
    let data;
    try {
      data = await requestJson(`/zone/job/${jobId}`, { token });
    } catch (error) {
      if (error.code === 'unauthorized' || error.code === 'busy') throw error;
      if (error.code === 'notFound') return { status: 'lost' };
      if (error.code === 'network') throw error;
      // Error transitorio del servicio: reintentar el sondeo.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const job = data.job;
    if (job.status === 'done' || job.status === 'failed') return job;
    await sleep(POLL_INTERVAL_MS);
  }
};

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

// Estima el tamaño de una zona (síncrono en el servicio). Devuelve { tiles, bytes }.
export const estimateZone = async ({ minLng, minLat, maxLng, maxLat, minZoom, maxZoom }) => {
  const token = requireToken();
  const data = await with429Retry(() =>
    requestJson('/zone/estimate', {
      token,
      method: 'POST',
      body: { minLng, minLat, maxLng, maxLat, minZoom, maxZoom },
    }),
  );
  return { tiles: data.tiles, bytes: data.bytes, maxBytes: data.maxBytes };
};

// Versión del base que sirve el servidor ahora (GET /maps/version). Es un GET chico
// sin body: no depende de leer headers de /maps/base ni de descargar nada.
export const fetchBaseVersion = async () => {
  const token = requireToken();
  const data = await requestJson('/version', { token });
  return data?.baseVersion ?? null;
};

// Descarga completa: extract → sondeo → descarga a .part → validación → rename →
// registro SQLite. Ante fallo o cancelación borra el .part para no dejar basura.
// file-transfer no permite abortar: la cancelación se resuelve marcando la bandera
// y, cuando la promesa de descarga termina, se ignora el resultado y se borra el .part.
export const downloadZone = async ({
  name,
  bbox,
  minZoom,
  maxZoom,
  onProgress,
  onStage,
  isCancelled,
}) => {
  const token = requireToken();
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const id = `zone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partPath = `${MAPS_DIR}/${id}.pmtiles.part`;
  const finalPath = `${MAPS_DIR}/${id}.pmtiles`;

  const cleanupPart = () =>
    Filesystem.deleteFile({ path: partPath, directory: Directory.Data }).catch(() => {});

  let restarts = 0;

  try {
    for (;;) {
      onStage?.('extracting');
      const extract = await with429Retry(() =>
        requestJson('/zone/extract', {
          token,
          method: 'POST',
          body: { minLng, minLat, maxLng, maxLat, minZoom, maxZoom },
        }),
      );
      const jobId = extract.jobId;
      const tiles = extract.tiles;
      // Versión del base con la que se está recortando; el job es la fuente fiable
      // (la del extract puede quedar vieja si el base cambia a mitad de camino).
      let baseVersion = extract.baseVersion ?? null;

      const job = await pollJob(jobId, token, isCancelled);
      if (job.baseVersion) baseVersion = job.baseVersion;
      if (job.status === 'failed') {
        throw new MapServiceError('jobFailed', job.error || 'La extracción falló', { jobId });
      }
      if (job.status === 'lost') {
        // El servicio se reinició y perdió el job: reiniciar la descarga una vez.
        restarts += 1;
        if (restarts > 1)
          throw new MapServiceError('jobLost', 'El servidor se reinició durante la descarga');
        continue;
      }

      onStage?.('downloading');
      for (let dlAttempts = 0; ; dlAttempts += 1) {
        try {
          const { contentLength, lengthComputable } = await downloadToPart(
            jobId,
            partPath,
            token,
            onProgress,
            isCancelled,
          );
          if (isCancelled?.()) throw new MapServiceError('cancelled', 'Descarga cancelada');

          const stat = await Filesystem.stat({ path: partPath, directory: Directory.Data });
          await validatePmtiles(partPath, stat.size, contentLength, lengthComputable);
          await Filesystem.rename({ from: partPath, to: finalPath, directory: Directory.Data });
          try {
            await registerZone({
              id,
              name,
              filePath: finalPath,
              bbox,
              minZoom,
              maxZoom,
              sizeBytes: stat.size,
              tileCount: tiles,
              buildVersion: baseVersion,
            });
          } catch (error) {
            // El archivo ya está renombrado pero no hay fila: sin fila la zona es
            // invisible para la lista, así que se borra el archivo en vez de dejar
            // espacio ocupado sin registro. Se propaga el error original.
            await Filesystem.deleteFile({ path: finalPath, directory: Directory.Data }).catch(
              () => {},
            );
            throw error;
          }
          resetZoneRegistry();
          return { id, sizeBytes: stat.size };
        } catch (error) {
          if (error.code === 'downloadRunning' && dlAttempts < MAX_DOWNLOAD_RUNNING_RETRIES) {
            await sleep(POLL_INTERVAL_MS);
            continue;
          }
          if (error.code === 'notFound' && restarts < 1) {
            restarts += 1;
            break; // reiniciar el flujo (re-extract)
          }
          throw error;
        }
      }
    }
  } catch (error) {
    await cleanupPart();
    throw error;
  }
};

export const listZones = async () => {
  const conn = await initDb();
  const result = await conn.query('SELECT * FROM zones ORDER BY createdAt DESC');
  return (result.values ?? []).map(zoneFromRow);
};

const fileExists = (path) =>
  Filesystem.stat({ path, directory: Directory.Data })
    .then(() => true)
    .catch(() => false);

// Borra una zona: archivo y fila. La fila se borra SOLO si el archivo ya no está. Si
// el borrado del archivo falla, la fila se mantiene para que el archivo siga siendo
// visible (y reintentable) en la lista, en vez de quedar ocupando disco sin registro.
// Devuelve { id, fileDeleted, rowDeleted } para que el llamador pueda avisar.
export const deleteZone = async (id) => {
  const conn = await initDb();
  const result = await conn.query('SELECT filePath FROM zones WHERE id = ?', [id]);
  const filePath = result.values?.[0]?.filePath;

  let fileDeleted = true;
  if (filePath) {
    fileDeleted = await Filesystem.deleteFile({ path: filePath, directory: Directory.Data })
      .then(() => true)
      .catch(() => false);
    // Si el borrado falló pero el archivo ya no está (lo borró otra vía), no es un fallo.
    if (!fileDeleted) fileDeleted = !(await fileExists(filePath));
  }
  if (!fileDeleted) return { id, fileDeleted: false, rowDeleted: false };

  await conn.run('DELETE FROM zones WHERE id = ?', [id]);
  resetZoneRegistry();
  return { id, fileDeleted: true, rowDeleted: true };
};

// Reemplazo atómico de una zona. El orden importa: downloadZone ya deja la nueva
// completa, validada y registrada antes de devolver, así que hasta este punto la zona
// vieja sigue intacta y usable. Solo entonces se borra la vieja.
//
// Si falla el borrado NO se revierte nada: la nueva es válida y ya sirve tiles, y
// deshacer una descarga buena para volver a la vieja sería el peor resultado posible.
// Se informa con oldDeleted=false para que la UI avise (quedan las dos zonas).
export const replaceZone = async (oldId, args) => {
  const nueva = await downloadZone(args);
  try {
    const borrada = await deleteZone(oldId);
    return { ...nueva, oldDeleted: borrada.rowDeleted };
  } catch {
    return { ...nueva, oldDeleted: false };
  }
};

// Reconcilia la tabla `zones` (SQLite, la que muestra la pantalla) con los archivos
// .pmtiles que hay realmente en maps/. Las dos vistas se arman por caminos distintos:
// el render offline descubre las zonas leyendo el directorio, la lista lee SQLite. Si
// divergen, hay zonas que se ven en el mapa pero no se pueden gestionar (ni marcar
// como desactualizadas), o filas que apuntan a archivos que ya no están.
//
//   - archivo sin fila  → se crea la fila (buildVersion null: el origen se desconoce)
//   - fila sin archivo  → se borra la fila
//
// Corre al arrancar, junto a cleanupOrphanParts. Devuelve los contadores.
export const reconcileZones = async () => {
  if (!isNative()) return { added: 0, removed: 0 };
  const conn = await initDb();

  const listado = await Filesystem.readdir({ path: MAPS_DIR, directory: Directory.Data }).catch(
    () => null,
  );
  const archivos = new Map();
  for (const file of listado?.files ?? []) {
    if (file.type !== 'file' || !file.name.toLowerCase().endsWith('.pmtiles')) continue;
    archivos.set(`${MAPS_DIR}/${file.name}`, file);
  }

  const rows = (await conn.query('SELECT id, filePath FROM zones')).values ?? [];
  const conFila = new Set(rows.map((row) => row.filePath));

  let added = 0;
  let removed = 0;

  for (const [filePath, file] of archivos) {
    if (conFila.has(filePath)) continue;
    const zona = await readZoneFile(file.name);
    if (!zona) continue; // Ilegible: se omite (zoneStore tampoco la va a renderizar).
    const stat = await Filesystem.stat({ path: filePath, directory: Directory.Data }).catch(
      () => null,
    );
    await registerZone({
      id: zona.id,
      name: zona.name,
      filePath,
      bbox: [zona.minLon, zona.minLat, zona.maxLon, zona.maxLat],
      minZoom: zona.minZoom,
      maxZoom: zona.maxZoom,
      sizeBytes: stat?.size ?? 0,
      tileCount: null,
      buildVersion: null,
    });
    added += 1;
  }

  for (const row of rows) {
    if (!row.filePath || archivos.has(row.filePath)) continue;
    await conn.run('DELETE FROM zones WHERE id = ?', [row.id]);
    removed += 1;
  }

  if (added || removed) {
    resetZoneRegistry();
    console.info(
      `Zonas offline: reconciliación con el disco (${added} agregadas, ${removed} quitadas).`,
    );
  }
  return { added, removed };
};

// Borra .part huérfanos (descargas cortadas por cierre de la app, etc.).
export const cleanupOrphanParts = async () => {
  if (!isNative()) return;
  const result = await Filesystem.readdir({ path: MAPS_DIR, directory: Directory.Data }).catch(
    () => null,
  );
  for (const file of result?.files ?? []) {
    if (file.type === 'file' && file.name.endsWith('.pmtiles.part')) {
      await Filesystem.deleteFile({
        path: `${MAPS_DIR}/${file.name}`,
        directory: Directory.Data,
      }).catch(() => {});
    }
  }
};

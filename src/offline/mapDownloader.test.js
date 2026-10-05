// Pruebas del reemplazo atómico y del borrado de zonas. Se mockean los plugins
// nativos (Filesystem, FileTransfer, SQLite) con un modelo mínimo en memoria, de modo
// que se pueda afirmar lo que importa: qué archivos quedan en disco y qué filas en la
// tabla `zones` después de que falle cada etapa.
//
// Invariante central: la zona vieja NUNCA se toca hasta que la nueva está completa,
// validada y registrada.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { estado, rutaDeUri } = vi.hoisted(() => ({
  // El plugin nativo recibe `path` como URI (`file://…`); el resto del código usa la
  // ruta relativa. Esta es la traducción mínima para el modelo en memoria.
  rutaDeUri: (uri) => String(uri).replace(/^file:\/\//, ''),
  estado: {
    archivos: new Map(), // path -> tamaño en bytes
    filas: new Map(), // id -> fila de zones
    fallarDelete: new Set(), // paths cuyo deleteFile rechaza
    fallarRename: false,
    fallarInsert: false,
    transfer: { listener: null, descargas: 0 },
  },
}));

// "PMTiles" + versión 3 de la especificación, en base64 como lo devuelve Filesystem.
const HEADER_PMTILES = btoa('PMTiles\x03');

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: {
    getUri: vi.fn(async ({ path }) => ({ uri: `file://${path}` })),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => ({
      files: [...estado.archivos.keys()].map((path) => ({
        name: path.split('/').pop(),
        type: 'file',
        mtime: 0,
      })),
    })),
    stat: vi.fn(async ({ path }) => {
      if (!estado.archivos.has(path)) throw new Error(`no existe ${path}`);
      return { size: estado.archivos.get(path) };
    }),
    readFile: vi.fn(async () => ({ data: HEADER_PMTILES })),
    deleteFile: vi.fn(async ({ path }) => {
      if (estado.fallarDelete.has(path)) throw new Error(`no se pudo borrar ${path}`);
      estado.archivos.delete(path);
    }),
    rename: vi.fn(async ({ from, to }) => {
      if (estado.fallarRename) throw new Error('rename falló');
      const tamano = estado.archivos.get(from);
      if (tamano == null) throw new Error(`no existe ${from}`);
      estado.archivos.delete(from);
      estado.archivos.set(to, tamano);
    }),
  },
}));

vi.mock('@capacitor/file-transfer', () => ({
  FileTransfer: {
    addListener: vi.fn(async (_evento, listener) => {
      estado.transfer.listener = listener;
      return { remove: vi.fn(async () => {}) };
    }),
    // Descarga buena: escribe el .part con el tamaño anunciado y avisa progreso.
    downloadFile: vi.fn(async ({ url, path: uri }) => {
      estado.transfer.descargas += 1;
      estado.archivos.set(rutaDeUri(uri), 100);
      estado.transfer.listener?.({
        url,
        lengthComputable: true,
        contentLength: 100,
        bytes: 100,
      });
    }),
  },
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    async createConnection() {
      return {
        open: vi.fn(async () => {}),
        execute: vi.fn(async () => {}),
        query: vi.fn(async (sql, params = []) => {
          if (/PRAGMA table_info/.test(sql)) return { values: [{ name: 'filePath' }] };
          if (/SELECT filePath FROM zones WHERE id/.test(sql)) {
            const fila = estado.filas.get(params[0]);
            return { values: fila ? [{ filePath: fila.filePath }] : [] };
          }
          if (/SELECT id, filePath FROM zones/.test(sql)) {
            return { values: [...estado.filas.values()].map((f) => ({ ...f })) };
          }
          if (/SELECT \* FROM zones/.test(sql)) return { values: [...estado.filas.values()] };
          return { values: [] };
        }),
        run: vi.fn(async (sql, params = []) => {
          if (/INSERT OR REPLACE INTO zones/.test(sql)) {
            if (estado.fallarInsert) throw new Error('sqlite no disponible');
            const [id, name, filePath, bbox, minZoom, maxZoom, sizeBytes, tileCount, buildVersion] =
              params;
            estado.filas.set(id, {
              id,
              name,
              filePath,
              bbox,
              minZoom,
              maxZoom,
              sizeBytes,
              tileCount,
              buildVersion,
              status: 'ready',
            });
            return;
          }
          if (/DELETE FROM zones WHERE id/.test(sql)) estado.filas.delete(params[0]);
        }),
      };
    }
  },
}));

vi.mock('./nativeBootstrap', () => ({
  getServerUrl: () => 'https://mh.rudatrak.com',
  getSessionToken: () => 'token-de-prueba',
  isNative: () => true,
  setSessionToken: vi.fn(),
}));

vi.mock('./tokenStore', () => ({ removeToken: vi.fn(async () => {}) }));

vi.mock('./zoneStore', () => ({
  resetZoneRegistry: vi.fn(),
  readZoneFile: vi.fn(),
}));

const { replaceZone, deleteZone, downloadZone, reconcileZones } = await import('./mapDownloader');
const { resetZoneRegistry, readZoneFile } = await import('./zoneStore');
const { Filesystem } = await import('@capacitor/filesystem');
const { FileTransfer } = await import('@capacitor/file-transfer');

// Los tests pisan estas dos con mockImplementation/mockImplementationOnce; se guardan
// las versiones buenas para reponerlas en cada beforeEach (clearAllMocks no las limpia).
const statOriginal = Filesystem.stat.getMockImplementation();
const downloadFileOriginal = FileTransfer.downloadFile.getMockImplementation();

const SERVIDOR = 'https://mh.rudatrak.com';
const BASE = `${SERVIDOR}/maps`;
const VERSION = 'sudamerica-20261003-z15-v2.pmtiles:8647255196';
const VIEJA_ID = 'vieja';
const VIEJA_PATH = 'maps/vieja.pmtiles';

const jobId = '11111111-2222-3333-4444-555555555555';

// Respuestas del servicio trak-mapas, configurables por test.
let servicio;
const montarServicio = (extra = {}) => {
  servicio = {
    extractStatus: 202,
    jobStatus: 'done',
    ...extra,
  };
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u === `${BASE}/zone/extract`) {
      if (servicio.extractStatus !== 202) {
        return new Response(JSON.stringify({ ok: false, error: 'La extracción falló' }), {
          status: servicio.extractStatus,
        });
      }
      return new Response(JSON.stringify({ ok: true, jobId, tiles: 42, baseVersion: VERSION }), {
        status: 202,
      });
    }
    if (u.startsWith(`${BASE}/zone/job/`)) {
      return new Response(
        JSON.stringify({
          ok: true,
          job: { id: jobId, status: servicio.jobStatus, baseVersion: VERSION },
        }),
        { status: 200 },
      );
    }
    throw new Error(`fetch inesperado: ${u}`);
  });
};

const args = (extra = {}) => ({
  name: 'Zona de prueba',
  bbox: [-58.6, -34.8, -58.2, -34.4],
  minZoom: 0,
  maxZoom: 12,
  isCancelled: () => false,
  ...extra,
});

const pathsPart = () => [...estado.archivos.keys()].filter((p) => p.endsWith('.part'));
const pathsFinales = () => [...estado.archivos.keys()].filter((p) => p.endsWith('.pmtiles'));

// La zona vieja sigue instalada y visible: archivo en disco, fila en la tabla.
const exigirViejaIntacta = () => {
  expect(estado.archivos.has(VIEJA_PATH)).toBe(true);
  expect(estado.filas.has(VIEJA_ID)).toBe(true);
};

beforeEach(() => {
  estado.archivos = new Map([[VIEJA_PATH, 500]]);
  estado.filas = new Map([
    [
      VIEJA_ID,
      { id: VIEJA_ID, name: 'Zona vieja', filePath: VIEJA_PATH, buildVersion: 'base-viejo:1' },
    ],
  ]);
  estado.fallarDelete = new Set();
  estado.fallarRename = false;
  estado.fallarInsert = false;
  estado.transfer = { listener: null, descargas: 0 };
  vi.clearAllMocks();
  readZoneFile.mockReset();
  Filesystem.stat.mockImplementation(statOriginal);
  FileTransfer.downloadFile.mockImplementation(downloadFileOriginal);
  montarServicio();
});

describe('replaceZone — camino feliz', () => {
  it('registra la nueva con su versión de base y recién entonces borra la vieja', async () => {
    const resultado = await replaceZone(VIEJA_ID, args());

    expect(resultado.oldDeleted).toBe(true);
    // Solo queda la zona nueva, con la versión que informó el job.
    const finales = pathsFinales();
    expect(finales).toHaveLength(1);
    expect(finales[0]).not.toBe(VIEJA_PATH);
    expect(estado.filas.has(VIEJA_ID)).toBe(false);
    const nueva = [...estado.filas.values()][0];
    expect(nueva.filePath).toBe(finales[0]);
    expect(nueva.buildVersion).toBe(VERSION);
    expect(nueva.status).toBe('ready');
    // Sin .part huérfano y con el registro en memoria invalidado.
    expect(pathsPart()).toHaveLength(0);
    expect(resetZoneRegistry).toHaveBeenCalled();
  });
});

describe('replaceZone — falla la extracción', () => {
  it('410 del servicio: no se descarga nada y la vieja queda intacta', async () => {
    montarServicio({ extractStatus: 410 });

    await expect(replaceZone(VIEJA_ID, args())).rejects.toThrow();

    expect(estado.transfer.descargas).toBe(0);
    expect(pathsFinales()).toEqual([VIEJA_PATH]);
    exigirViejaIntacta();
  });

  it('job en failed: no se descarga nada y la vieja queda intacta', async () => {
    montarServicio({ jobStatus: 'failed' });

    await expect(replaceZone(VIEJA_ID, args())).rejects.toThrow();

    expect(estado.transfer.descargas).toBe(0);
    expect(pathsFinales()).toEqual([VIEJA_PATH]);
    exigirViejaIntacta();
  });
});

describe('replaceZone — falla la descarga', () => {
  it('error de red: borra el .part, no registra nada y la vieja queda intacta', async () => {
    FileTransfer.downloadFile.mockImplementationOnce(async ({ url, path: uri }) => {
      // El nativo alcanza a escribir parte del archivo antes de cortarse.
      estado.archivos.set(rutaDeUri(uri), 10);
      estado.transfer.listener?.({ url, lengthComputable: true, contentLength: 100, bytes: 10 });
      throw new Error('network error');
    });

    await expect(replaceZone(VIEJA_ID, args())).rejects.toMatchObject({ code: 'network' });

    expect(pathsPart()).toHaveLength(0);
    expect(pathsFinales()).toEqual([VIEJA_PATH]);
    expect(estado.filas.size).toBe(1);
    exigirViejaIntacta();
  });
});

describe('replaceZone — falla la validación', () => {
  it('descarga incompleta: borra el .part y la vieja queda intacta', async () => {
    // El servicio anuncia 100 bytes (mock de descarga) pero el archivo que quedó en
    // disco pesa 60: descarga truncada.
    Filesystem.stat.mockImplementation(async ({ path }) => {
      if (path.endsWith('.part')) return { size: 60 };
      if (!estado.archivos.has(path)) throw new Error(`no existe ${path}`);
      return { size: estado.archivos.get(path) };
    });

    await expect(replaceZone(VIEJA_ID, args())).rejects.toMatchObject({ code: 'validation' });

    expect(pathsPart()).toHaveLength(0);
    expect(pathsFinales()).toEqual([VIEJA_PATH]);
    exigirViejaIntacta();
  });
});

describe('replaceZone — falla el rename', () => {
  it('el .part se limpia, no queda archivo nuevo y la vieja queda intacta', async () => {
    estado.fallarRename = true;

    await expect(replaceZone(VIEJA_ID, args())).rejects.toThrow(/rename/);

    expect(pathsPart()).toHaveLength(0);
    expect(pathsFinales()).toEqual([VIEJA_PATH]);
    expect(estado.filas.size).toBe(1);
    exigirViejaIntacta();
  });
});

describe('replaceZone — falla el registro en SQLite', () => {
  it('borra el archivo ya renombrado (nada de archivos sin fila) y la vieja queda intacta', async () => {
    estado.fallarInsert = true;

    await expect(replaceZone(VIEJA_ID, args())).rejects.toThrow(/sqlite/);

    expect(pathsPart()).toHaveLength(0);
    expect(pathsFinales()).toEqual([VIEJA_PATH]); // el archivo nuevo se borró
    expect(estado.filas.size).toBe(1);
    exigirViejaIntacta();
  });
});

describe('replaceZone — falla el borrado de la vieja', () => {
  it('no revierte: la nueva queda registrada y avisa con oldDeleted=false', async () => {
    estado.fallarDelete.add(VIEJA_PATH);

    const resultado = await replaceZone(VIEJA_ID, args());

    expect(resultado.oldDeleted).toBe(false);
    // La nueva sirve tiles y la vieja sigue en disco y en la lista (visible y borrable).
    expect(pathsFinales()).toHaveLength(2);
    expect(estado.filas.has(VIEJA_ID)).toBe(true);
    const nueva = [...estado.filas.values()].find((f) => f.id !== VIEJA_ID);
    expect(nueva.buildVersion).toBe(VERSION);
  });
});

describe('replaceZone — cancelación', () => {
  it('cancelar durante la descarga no registra la nueva ni borra la vieja', async () => {
    const bandera = { cancelado: false };
    FileTransfer.downloadFile.mockImplementationOnce(async ({ url, path: uri }) => {
      estado.transfer.descargas += 1;
      estado.archivos.set(rutaDeUri(uri), 10);
      estado.transfer.listener?.({ url, lengthComputable: true, contentLength: 100, bytes: 10 });
      bandera.cancelado = true; // el usuario cancela mientras se descarga
    });

    await expect(
      replaceZone(VIEJA_ID, args({ isCancelled: () => bandera.cancelado })),
    ).rejects.toMatchObject({ code: 'cancelled' });

    expect(estado.transfer.descargas).toBe(1);
    expect(pathsPart()).toHaveLength(0);
    expect(pathsFinales()).toEqual([VIEJA_PATH]);
    expect(estado.filas.size).toBe(1);
    exigirViejaIntacta();
  });

  it('cancelar antes de empezar no toca el servicio', async () => {
    await expect(replaceZone(VIEJA_ID, args({ isCancelled: () => true }))).rejects.toMatchObject({
      code: 'cancelled',
    });

    expect(estado.filas.size).toBe(1);
    exigirViejaIntacta();
  });
});

describe('deleteZone', () => {
  it('borra archivo y fila cuando el archivo existe', async () => {
    const resultado = await deleteZone(VIEJA_ID);

    expect(resultado).toEqual({ id: VIEJA_ID, fileDeleted: true, rowDeleted: true });
    expect(estado.archivos.has(VIEJA_PATH)).toBe(false);
    expect(estado.filas.has(VIEJA_ID)).toBe(false);
  });

  it('si el archivo no se puede borrar MANTIENE la fila (no deja archivos invisibles)', async () => {
    estado.fallarDelete.add(VIEJA_PATH);

    const resultado = await deleteZone(VIEJA_ID);

    expect(resultado).toEqual({ id: VIEJA_ID, fileDeleted: false, rowDeleted: false });
    expect(estado.archivos.has(VIEJA_PATH)).toBe(true);
    expect(estado.filas.has(VIEJA_ID)).toBe(true);
  });

  it('si el archivo ya no está, borra la fila igual', async () => {
    estado.archivos.delete(VIEJA_PATH);

    const resultado = await deleteZone(VIEJA_ID);

    expect(resultado.rowDeleted).toBe(true);
    expect(estado.filas.has(VIEJA_ID)).toBe(false);
  });
});

describe('downloadZone — versión del base', () => {
  it('sin baseVersion en el servicio deja la fila sin versión (no rompe)', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u === `${BASE}/zone/extract`)
        return new Response(JSON.stringify({ ok: true, jobId, tiles: 42 }), { status: 202 });
      if (u.startsWith(`${BASE}/zone/job/`))
        return new Response(JSON.stringify({ ok: true, job: { id: jobId, status: 'done' } }), {
          status: 200,
        });
      throw new Error(`fetch inesperado: ${u}`);
    });

    await downloadZone(args());

    const nueva = [...estado.filas.values()].find((f) => f.id !== VIEJA_ID);
    expect(nueva.buildVersion).toBeNull();
  });
});

describe('reconcileZones', () => {
  it('crea la fila de un archivo sin registro y borra la fila de un archivo ausente', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    // Archivo en disco sin fila + fila sin archivo.
    estado.archivos.set('maps/huerfana.pmtiles', 300);
    estado.filas.set('fantasma', { id: 'fantasma', filePath: 'maps/fantasma.pmtiles' });
    readZoneFile.mockResolvedValue({
      id: 'huerfana',
      name: 'huerfana',
      minLon: -73,
      minLat: -52,
      maxLon: -72,
      maxLat: -51,
      minZoom: 0,
      maxZoom: 15,
    });

    const resultado = await reconcileZones();

    expect(resultado).toEqual({ added: 1, removed: 1 });
    const creada = estado.filas.get('huerfana');
    expect(creada.buildVersion).toBeNull(); // origen desconocido
    expect(JSON.parse(creada.bbox)).toEqual([-73, -52, -72, -51]);
    expect(creada.maxZoom).toBe(15);
    expect(creada.sizeBytes).toBe(300);
    expect(estado.filas.has('fantasma')).toBe(false);
    expect(estado.filas.has(VIEJA_ID)).toBe(true); // la que estaba bien, intacta
    expect(info).toHaveBeenCalledWith(expect.stringContaining('1 agregadas, 1 quitadas'));
    info.mockRestore();
  });

  it('sin divergencias no toca nada ni loguea', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    expect(await reconcileZones()).toEqual({ added: 0, removed: 0 });
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('omite un archivo cuyo encabezado es ilegible', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    estado.archivos.set('maps/rota.pmtiles', 10);
    readZoneFile.mockResolvedValue(null);

    expect(await reconcileZones()).toEqual({ added: 0, removed: 0 });
    expect(estado.filas.has('rota')).toBe(false);
    vi.restoreAllMocks();
  });
});

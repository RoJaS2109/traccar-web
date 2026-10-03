import { describe, it, expect, vi } from 'vitest';
import { findTileInZones, createZoneErrorLogger } from './findTile';

// Bbox de una zona que cubre el tile de prueba (z=10, x=600, y=700 aprox).
const makeZone = (overrides = {}) => ({
  path: 'maps/zona.pmtiles',
  minLon: -80,
  minLat: -60,
  maxLon: -40,
  maxLat: -10,
  minZoom: 0,
  maxZoom: 14,
  pmtiles: { getZxy: async () => undefined },
  ...overrides,
});

const bbox = [-70, -50, -60, -40];
const tileData = () => new ArrayBuffer(8);

describe('findTileInZones', () => {
  it('devuelve el MVT de la primera zona que lo contiene', async () => {
    const data = tileData();
    const zone = makeZone({ pmtiles: { getZxy: async () => ({ data }) } });
    await expect(findTileInZones([zone], 10, 0, 0, bbox)).resolves.toBe(data);
  });

  it('continúa en la siguiente zona si una lanza error de lectura', async () => {
    const data = tileData();
    const onZoneError = vi.fn();
    const broken = makeZone({
      path: 'maps/rota.pmtiles',
      pmtiles: {
        getZxy: async () => {
          throw new Error('io');
        },
      },
    });
    const ok = makeZone({ path: 'maps/ok.pmtiles', pmtiles: { getZxy: async () => ({ data }) } });

    await expect(findTileInZones([broken, ok], 10, 0, 0, bbox, onZoneError)).resolves.toBe(data);
    expect(onZoneError).toHaveBeenCalledTimes(1);
    expect(onZoneError).toHaveBeenCalledWith(broken, expect.any(Error));
  });

  it('no lanza si la única zona que cubre el tile falla', async () => {
    const onZoneError = vi.fn();
    const broken = makeZone({
      pmtiles: {
        getZxy: async () => {
          throw new Error('io');
        },
      },
    });
    await expect(findTileInZones([broken], 10, 0, 0, bbox, onZoneError)).resolves.toBeNull();
    expect(onZoneError).toHaveBeenCalledTimes(1);
  });

  it('devuelve null si ninguna zona lo contiene', async () => {
    const zone = makeZone({ pmtiles: { getZxy: async () => ({ data: new ArrayBuffer(0) }) } });
    await expect(findTileInZones([zone], 10, 0, 0, bbox)).resolves.toBeNull();
  });

  it('descarta zonas fuera del rango de zoom o sin solape de bbox sin consultarlas', async () => {
    const getZxy = vi.fn(async () => ({ data: tileData() }));
    const outZoom = makeZone({ minZoom: 5, maxZoom: 8, pmtiles: { getZxy } });
    const outBbox = makeZone({ minLon: 0, maxLon: 10, pmtiles: { getZxy } });

    await expect(findTileInZones([outZoom, outBbox], 10, 0, 0, bbox)).resolves.toBeNull();
    expect(getZxy).not.toHaveBeenCalled();
  });
});

describe('createZoneErrorLogger', () => {
  it('loguea una sola vez por zona y silencia las repeticiones', () => {
    const logger = vi.fn();
    const log = createZoneErrorLogger(logger);
    const zone = { path: 'maps/rota.pmtiles' };
    const error = new Error('io');

    log(zone, error);
    log(zone, error);
    expect(logger).toHaveBeenCalledTimes(1);

    log({ path: 'maps/otra.pmtiles' }, error);
    expect(logger).toHaveBeenCalledTimes(2);
  });

  it('incluye la clave de la zona y el mensaje del error', () => {
    const logger = vi.fn();
    const log = createZoneErrorLogger(logger);
    log({ path: 'maps/rota.pmtiles' }, new Error('disco lleno'));
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('maps/rota.pmtiles'));
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('disco lleno'));
  });
});

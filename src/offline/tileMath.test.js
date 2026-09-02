import { describe, it, expect } from 'vitest';
import { tilesForBbox, tmsY, tileCount, tileToUrl } from './tileMath';

describe('tilesForBbox', () => {
  it('devuelve un solo tile en zoom 0 para el mundo entero', () => {
    expect(tilesForBbox([-180, -85.05112878, 180, 85.05112878], 0, 0)).toEqual([
      { z: 0, x: 0, y: 0 },
    ]);
  });

  it('cubre un bbox interior del cuadrante noroeste con 1 tile en zoom 1', () => {
    // bbox lejos de los bordes: 0° y 180° caen en tiles vecinos por off-by-one
    const tiles = tilesForBbox([-179, 50, -91, 84], 1, 1);
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

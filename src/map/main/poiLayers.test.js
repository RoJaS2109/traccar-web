import { describe, expect, it } from 'vitest';
import { parsePoiLayers } from './poiLayers';

describe('parsePoiLayers', () => {
  it('lee una línea por KML con nombre y ruta', () => {
    expect(
      parsePoiLayers('Pernocte y campings|poi/general.kml\nTalleres y auxilios|poi/talleres.kml'),
    ).toEqual([
      { name: 'Pernocte y campings', url: 'poi/general.kml' },
      { name: 'Talleres y auxilios', url: 'poi/talleres.kml' },
    ]);
  });

  it('acepta ; como separador (campo de una sola línea)', () => {
    expect(parsePoiLayers('A|poi/a.kml; B|poi/b.kml;')).toEqual([
      { name: 'A', url: 'poi/a.kml' },
      { name: 'B', url: 'poi/b.kml' },
    ]);
  });

  it('sin nombre usa el del archivo', () => {
    expect(parsePoiLayers('poi/general.kml')).toEqual([
      { name: 'general', url: 'poi/general.kml' },
    ]);
  });

  it('codifica espacios y no vuelve a codificar lo ya codificado', () => {
    const [layer] = parsePoiLayers('Mascotas|poi/CAMPING+MASCOTAS - @perro.kml');
    expect(layer.url).toBe('poi/CAMPING+MASCOTAS%20-%20@perro.kml');
    expect(parsePoiLayers(`Mascotas|${layer.url}`)[0].url).toBe(layer.url);
  });

  it('ignora líneas vacías, rutas vacías y repetidas', () => {
    expect(parsePoiLayers('\n  \nA|\nA|poi/a.kml\r\nB|poi/a.kml\n')).toEqual([
      { name: 'A', url: 'poi/a.kml' },
    ]);
  });

  it('sin poiLayers usa poiLayer', () => {
    expect(parsePoiLayers(undefined, 'poi/general.kml')).toEqual([
      { name: 'general', url: 'poi/general.kml' },
    ]);
    expect(parsePoiLayers('', null)).toEqual([]);
  });
});

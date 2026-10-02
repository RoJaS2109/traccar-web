export const tmsY = (z, y) => (1 << z) - 1 - y;

const lonToTileX = (lon, z) => Math.floor(((lon + 180) / 360) * (1 << z));

const latToTileY = (lat, z) => {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, z);
  return Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
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

export const tileCount = (bbox, minZoom, maxZoom) => {
  // Calcula la cantidad de tiles sin materializar el array completo.
  // tilesForBbox() asigna un objeto por tile; para el bbox del mundo en zoom 5-14
  // eso son decenas de millones de objetos (~680 MB) y desborda el heap de V8
  // del WebView (32 bits). La cuenta se obtiene por aritmética: O(maxZoom-minZoom).
  const [west, south, east, north] = bbox;
  let count = 0;
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const max = (1 << z) - 1;
    const x0 = Math.max(0, lonToTileX(west, z));
    const x1 = Math.min(max, lonToTileX(east, z));
    const y0 = Math.max(0, latToTileY(north, z));
    const y1 = Math.min(max, latToTileY(south, z));
    if (x1 >= x0 && y1 >= y0) {
      count += (x1 - x0 + 1) * (y1 - y0 + 1);
    }
  }
  return count;
};

const IGN_BASE = 'https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0';

export const tileToUrl = (layer, z, x, y) =>
  `${IGN_BASE}/${layer}@EPSG%3A3857@png/${z}/${x}/${tmsY(z, y)}.png`;

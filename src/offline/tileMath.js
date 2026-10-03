// Utilidades de tile XYZ (proyección Web Mercator).

const tileYToLat = (y, z) => {
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / (1 << z))));
  return (latRad * 180) / Math.PI;
};

// Bbox [oeste, sur, este, norte] de un tile XYZ. Se usa en zoneStore para descartar
// zonas cuyo bbox no contiene el tile antes de tocar el archivo .pmtiles.
export const tileToBbox = (z, x, y) => {
  const n = 1 << z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = tileYToLat(y, z);
  const south = tileYToLat(y + 1, z);
  return [west, south, east, north];
};

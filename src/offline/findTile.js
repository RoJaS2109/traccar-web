// Lógica de búsqueda de tile entre zonas offline, aislada de Capacitor/pmtiles
// para poder testearla en Node sin stubs del runtime nativo.

// Recorre las zonas que cubren el tile (z, x, y) y devuelve el ArrayBuffer del MVT
// de la primera que lo tenga, o null si ninguna lo contiene. Si una zona lanza
// error de lectura, se notifica vía onZoneError y se continúa con las siguientes
// (una zona corrupta no debe impedir consultar el resto).
export const findTileInZones = async (zones, z, x, y, bbox, onZoneError) => {
  const [west, south, east, north] = bbox;
  for (const zone of zones) {
    if (z < zone.minZoom || z > zone.maxZoom) continue;
    // Sin solape con el bbox de la zona: descartar sin tocar el archivo.
    if (east < zone.minLon || west > zone.maxLon || north < zone.minLat || south > zone.maxLat)
      continue;
    let range;
    try {
      range = await zone.pmtiles.getZxy(z, x, y);
    } catch (error) {
      onZoneError?.(zone, error);
      continue;
    }
    if (range?.data?.byteLength) return range.data;
  }
  return null;
};

// Devuelve una función (zone, error) => void que loguea el primer error de cada
// zona y silencia los siguientes de la misma: una zona ilegible se consulta una
// vez por tile y no debe inundar la consola en cada pedido de MapLibre.
export const createZoneErrorLogger = (logger = console.warn, zoneKey = (zone) => zone.path) => {
  const logged = new Set();
  return (zone, error) => {
    const key = zoneKey(zone);
    if (logged.has(key)) return;
    logged.add(key);
    logger(`Zona offline "${key}" ilegible (${error?.message ?? error}); se omite.`);
  };
};

// Selección desacoplada del estilo de mapa en modo offline. Esta función es el único
// punto donde se decide qué estilo/capa usa la pantalla offline, sin asumir un
// proveedor concreto (IGN, OSM, ...) ni hardcodear nombres de capa del proveedor.
//
// El protocolo offline:// está registrado en offlineProtocol.js y sirve tiles raster
// desde tileStore (Filesystem). Sin zonas descargadas MapLibre muestra solo el fondo.
// Cuando se cambie la fuente de tiles offline (IGN está caído), se ajusta aquí la
// capa/URL junto con la descarga (DownloadZoneDialog), sin tocar la pantalla offline.
export const getOfflineStyle = () => ({
  version: 8,
  sources: {
    offline: {
      type: 'raster',
      tiles: ['offline://base/{z}/{x}/{y}'],
      tileSize: 256,
    },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#dcdcdc' },
    },
    {
      id: 'offline',
      type: 'raster',
      source: 'offline',
    },
  ],
});

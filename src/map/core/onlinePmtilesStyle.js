import { PMTiles, FetchSource } from 'pmtiles';
import { getServerUrl, getSessionToken } from '../../offline/nativeBootstrap';
import { protomapsLightLayers } from '../../offline/protomapsLightLayers';
import { pmtilesProtocol } from './pmtilesProtocol';

// Estilo vectorial online servido desde el archivo base .pmtiles de trak-mapas
// (GET /maps/base, con Range/ETag/416). Reutiliza las mismas capas Protomaps light,
// glifos y sprites que el estilo offline; solo cambia la fuente: pmtiles:// remoto
// con header Authorization en vez de offline:// local.

const SOURCE_ID = 'protomaps';

// El endpoint vive en el mismo dominio que el servidor (mh.rudatrak.com/maps/base),
// reescrito por NPM hacia trak-mapas. getServerUrl() es una URL absoluta, así que el
// parche de fetch de nativeBootstrap no la reescribe.
const baseUrl = () => `${getServerUrl().replace(/\/+$/, '')}/maps/base`;

// Registra (o reemplaza) el PMTiles remoto con el token actual en el protocolo
// compartido, para que el estilo pmtiles://<url>/… resuelva las tiles con el header
// Authorization: Bearer. protocol.add pisa la instancia de la misma URL, así que es
// idempotente y admite rotación de token entre montajes del mapa.
export const registerOnlinePmtiles = () => {
  const token = getSessionToken();
  if (!token) return false;
  const source = new FetchSource(baseUrl(), new Headers({ Authorization: `Bearer ${token}` }));
  pmtilesProtocol.add(new PMTiles(source));
  return true;
};

export const getOnlinePmtilesStyle = () => ({
  version: 8,
  sources: {
    [SOURCE_ID]: {
      type: 'vector',
      tiles: [`pmtiles://${baseUrl()}/{z}/{x}/{y}`],
      minzoom: 0,
      // Requiere el base z15 desplegado en la Pi (BASE_PMTILES): con el base z14
      // este estilo haría overzoom del z14 y no mostraría el detalle z15.
      maxzoom: 15,
      attribution:
        '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://osm.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: protomapsLightLayers,
  // Rutas relativas y sprite local: mismos assets empaquetados en public/map/ que el
  // estilo offline, para no depender de cdn.traccar.com (no accesible en Android).
  glyphs: 'map/fonts/{fontstack}/{range}.pbf',
  sprite: `${window.location.origin}/map/sprites/light`,
});

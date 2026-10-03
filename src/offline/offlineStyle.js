// Capas Protomaps light generadas (ver protomapsLightLayers.js). Mantenidas en un
// módulo aparte porque son ~65 KB de JSON estático sin valor de lectura.
import { protomapsLightLayers } from './protomapsLightLayers';

// Selección desacoplada del estilo de mapa en modo offline. Es el único punto donde
// se decide qué estilo/capa usa la pantalla offline.
//
// Estilo vectorial Protomaps "light" (generado desde @protomaps/basemaps, lang=es)
// servido por el protocolo offline:// (offlineProtocol.js) desde extractos .pmtiles
// en files/maps/ (zoneStore.js). La fuente declara maxzoom 14: MapLibre hace overzoom
// escalando el tile z14, así que los niveles 15+ se dibujan sin pedir tiles fuera de
// rango. Glifos y sprites van empaquetados en public/map/ para funcionar sin red.
//
// Las rutas de glifos/sprites son relativas (sin "/" inicial) a propósito: el parche
// de fetch de nativeBootstrap reescribe hacia el servidor todo string que empiece con
// "/", y estos assets son locales al bundle.
export const getOfflineStyle = () => ({
  version: 8,
  sources: {
    protomaps: {
      type: 'vector',
      tiles: ['offline://mapas/{z}/{x}/{y}'],
      minzoom: 0,
      maxzoom: 14,
      attribution:
        '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://osm.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: protomapsLightLayers,
  glyphs: 'map/fonts/{fontstack}/{range}.pbf',
  // MapLibre exige sprite URL absoluta (a diferencia de glyphs, que acepta ruta
  // relativa). En nativo el bundle se sirve desde https://localhost, así que se
  // resuelve contra window.location.origin para apuntar a public/map/sprites/.
  sprite: `${window.location.origin}/map/sprites/light`,
});

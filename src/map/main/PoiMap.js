import { useId, useEffect, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { kml } from '@tmcw/togeojson';
import { useTheme } from '@mui/material/styles';
import { map } from '../core/MapView';
import { useAsyncTask } from '../../reactHelper';
import { usePreference } from '../../common/util/preferences';
import gcoord from 'gcoord';
import { findFonts } from '../core/mapUtil';
import { useTranslation } from '../../common/components/LocalizationProvider';
import { isNative } from '../../offline/nativeBootstrap';
import { useOnlineStatus } from '../../offline/useOnlineStatus';
import {
  cachePoiLayer,
  fetchAndCacheKml,
  getCachedKml,
  getCachedPoiLayer,
} from '../../offline/poiKmlStore';

const PoiMap = () => {
  const id = useId();

  const theme = useTheme();
  const t = useTranslation();

  const online = useOnlineStatus();
  const poiLayerPref = usePreference('poiLayer');

  const [poiLayer, setPoiLayer] = useState(poiLayerPref);
  const [data, setData] = useState(null);

  // Resolver poiLayer: la preferencia manda cuando está presente (online); si
  // no (offline), se usa el valor persistido en Preferences para poder cargar
  // el KML cacheado.
  useEffect(() => {
    if (poiLayerPref) {
      setPoiLayer(poiLayerPref);
      cachePoiLayer(poiLayerPref);
      return undefined;
    }
    let cancelled = false;
    getCachedPoiLayer().then((cached) => {
      if (!cancelled && cached) setPoiLayer(cached);
    });
    return () => {
      cancelled = true;
    };
  }, [poiLayerPref]);

  useAsyncTask(
    async ({ signal }) => {
      if (!poiLayer) return null;

      const parse = (text) => kml(new DOMParser().parseFromString(text, 'text/xml'));

      // 1) Render inmediato del KML cacheado (no bloquea con la red).
      const cached = await getCachedKml(poiLayer);
      if (cached) setData(parse(cached));

      // 2) Refresh condicional (solo con red): 304 reutiliza caché; 200 con
      // contenido válido lo cachea y actualiza el mapa.
      if (!online) return null;
      const result = await fetchAndCacheKml(poiLayer, { signal });
      if (result?.text && !result.fromCache) {
        setData(parse(result.text));
      }
      return null;
    },
    [poiLayer, online],
  );

  useEffect(() => {
    if (data) {
      const geoData =
        map.coordinateSystem === 'gcj02'
          ? gcoord.transform(structuredClone(data), gcoord.WGS84, gcoord.GCJ02)
          : data;

      // Los puntos cercanos se agrupan al alejar el mapa; las líneas y polígonos no.
      map.addSource(id, {
        type: 'geojson',
        data: geoData,
        cluster: true,
        clusterMaxZoom: 11,
        clusterRadius: 50,
      });

      map.addLayer({
        source: id,
        id: 'poi-fill',
        type: 'fill',
        filter: ['==', '$type', 'Polygon'],
        metadata: { 'traccar:title': t('mapPoiLayer') },
        paint: {
          'fill-color': ['coalesce', ['get', 'fill'], theme.palette.geometry.main],
          'fill-opacity': ['coalesce', ['get', 'fill-opacity'], 0.3],
        },
      });

      const features = geoData.features || [];
      const iconUrls = features
        .filter((f) => f.geometry?.type === 'Point' && f.properties?.icon)
        .map((f) => f.properties.icon);

      const uniqueIcons = [...new Set(iconUrls)];

      const loadIcon = (url) =>
        new Promise((resolve) => {
          const name = url.split('/').pop();

          const register = (img) => {
            if (!map.hasImage(url)) {
              map.addImage(url, img, { sdf: name.endsWith('.sdf.png') });
            }
            resolve();
          };

          const loadFromServer = () => {
            // El KML referencia los íconos como /poi/icons/*.png. En nativo el
            // WebView los resolvería contra https://localhost (404) y el servidor
            // no envía CORS, así que se cargan vía fetch (parcheado a CapacitorHttp)
            // como blob para sortear CORS y se usan como object URL.
            fetch(url)
              .then((response) =>
                response.ok
                  ? response.blob()
                  : Promise.reject(new Error(`HTTP ${response.status}`)),
              )
              .then((blob) => {
                const img = new Image();
                img.onload = () => register(img);
                img.onerror = () => {
                  console.error('POI icon failed to load', url);
                  resolve();
                };
                img.src = URL.createObjectURL(blob);
              })
              .catch(() => {
                console.error('POI icon failed to load', url);
                resolve();
              });
          };

          if (isNative()) {
            // Ícono empaquetado en el APK (public/icons → https://localhost/icons).
            // Es same-origin, así que un <img> directo sirve sin el workaround de CORS.
            const img = new Image();
            img.onload = () => register(img);
            img.onerror = () => loadFromServer();
            img.src = `${window.location.origin}/icons/${name}`;
          } else {
            loadFromServer();
          }
        });

      if (uniqueIcons.length > 0) {
        Promise.all(uniqueIcons.map(loadIcon)).then(() => {
          map.addLayer({
            source: id,
            id: 'poi-point',
            type: 'symbol',
            filter: ['all', ['==', '$type', 'Point'], ['has', 'icon'], ['!has', 'point_count']],
            metadata: { 'traccar:title': t('mapPoiLayer') },
            layout: {
              'icon-image': ['get', 'icon'],
              // Más chicos en los zooms intermedios, donde ya se separaron pero todavía son muchos.
              'icon-size': [
                'interpolate',
                ['linear'],
                ['zoom'],
                8,
                ['*', 0.6, ['coalesce', ['get', 'icon-scale'], 0.1]],
                13,
                ['coalesce', ['get', 'icon-scale'], 0.1],
              ],
              'icon-allow-overlap': true,
              'text-field': ['get', 'name'],
              'text-allow-overlap': false,
              'text-anchor': 'bottom',
              'text-offset': [0, -1],
              'text-font': findFonts(map),
              'text-size': 16,
              'text-optional': true,
            },
            paint: {
              'icon-color': ['coalesce', ['get', 'icon-color'], '#000000'],
              'text-halo-color': 'white',
              'text-halo-width': 1,
            },
          });
        });
      }

      map.addLayer({
        source: id,
        id: 'poi-circle',
        type: 'circle',
        filter: ['all', ['==', '$type', 'Point'], ['!has', 'icon'], ['!has', 'point_count']],
        metadata: { 'traccar:title': t('mapPoiLayer') },
        paint: {
          'circle-radius': 5,
          'circle-color': ['coalesce', ['get', 'icon-color'], theme.palette.geometry.main],
        },
      });

      map.addLayer({
        source: id,
        id: 'poi-line',
        type: 'line',
        metadata: { 'traccar:title': t('mapPoiLayer') },
        paint: {
          'line-color': ['coalesce', ['get', 'stroke'], theme.palette.geometry.main],
          'line-width': ['coalesce', ['get', 'stroke-width'], 2],
          'line-opacity': ['coalesce', ['get', 'stroke-opacity'], 1],
        },
      });

      map.addLayer({
        source: id,
        id: 'poi-title',
        type: 'symbol',
        filter: ['!has', 'point_count'],
        metadata: { 'traccar:title': t('mapPoiLayer') },
        layout: {
          'text-field': '{name}',
          'text-anchor': 'bottom',
          'text-offset': [0, -0.5],
          'text-font': findFonts(map),
          'text-size': 16,
        },
        paint: {
          'text-halo-color': 'white',
          'text-halo-width': 1,
        },
      });

      map.addLayer({
        source: id,
        id: 'poi-cluster',
        type: 'circle',
        filter: ['has', 'point_count'],
        metadata: { 'traccar:title': t('mapPoiLayer') },
        paint: {
          'circle-color': theme.palette.primary.main,
          'circle-radius': ['step', ['get', 'point_count'], 14, 50, 18, 500, 24],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.addLayer({
        source: id,
        id: 'poi-cluster-count',
        type: 'symbol',
        filter: ['has', 'point_count'],
        metadata: { 'traccar:title': t('mapPoiLayer') },
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-font': findFonts(map),
          'text-size': 13,
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': theme.palette.primary.contrastText,
        },
      });

      // Al tocar un grupo, el mapa se acerca hasta el zoom en que se separa.
      const onClusterClick = async (event) => {
        event.preventDefault();
        const feature = event.features?.[0];
        if (!feature) return;
        const zoom = await map.getSource(id).getClusterExpansionZoom(feature.properties.cluster_id);
        map.easeTo({ center: feature.geometry.coordinates, zoom });
      };
      const onClusterEnter = () => {
        map.getCanvas().style.cursor = 'pointer';
      };
      const onClusterLeave = () => {
        map.getCanvas().style.cursor = '';
      };

      const popup = new maplibregl.Popup({
        maxWidth: '400px',
        closeButton: true,
        closeOnClick: true,
      });

      const onPoiClick = (event) => {
        event.preventDefault();
        const feature = event.features?.[0];
        if (!feature) return;

        const props = feature.properties;
        const name = props.name || '';
        const description = props.description || '';

        if (!description) {
          popup.remove();
          return;
        }

        // Extraer coordenadas según el tipo de geometría
        let coordText = '';
        const geom = feature.geometry;
        if (geom?.type === 'Point') {
          const [lng, lat] = geom.coordinates;
          coordText = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        }

        const coordLine = coordText
          ? `<div style="font-size:11px;color:#888;margin-bottom:4px">📍 ${coordText}</div>`
          : '';

        const html = name
          ? `<div style="max-height:300px;overflow-y:auto;font-size:14px;background:white;color:black">${coordLine}<strong>${name}</strong><br>${description}</div>`
          : `<div style="max-height:300px;overflow-y:auto;font-size:14px;background:white;color:black">${coordLine}${description}</div>`;
        popup.setLngLat(event.lngLat).setHTML(html).addTo(map);
      };

      map.on('click', 'poi-point', onPoiClick);
      map.on('click', 'poi-circle', onPoiClick);
      map.on('click', 'poi-title', onPoiClick);
      map.on('click', 'poi-fill', onPoiClick);
      map.on('click', 'poi-line', onPoiClick);
      map.on('click', 'poi-cluster', onClusterClick);
      map.on('mouseenter', 'poi-cluster', onClusterEnter);
      map.on('mouseleave', 'poi-cluster', onClusterLeave);

      return () => {
        popup.remove();

        map.off('click', 'poi-point', onPoiClick);
        map.off('click', 'poi-circle', onPoiClick);
        map.off('click', 'poi-title', onPoiClick);
        map.off('click', 'poi-fill', onPoiClick);
        map.off('click', 'poi-line', onPoiClick);
        map.off('click', 'poi-cluster', onClusterClick);
        map.off('mouseenter', 'poi-cluster', onClusterEnter);
        map.off('mouseleave', 'poi-cluster', onClusterLeave);

        if (map.getLayer('poi-cluster-count')) {
          map.removeLayer('poi-cluster-count');
        }
        if (map.getLayer('poi-cluster')) {
          map.removeLayer('poi-cluster');
        }

        if (map.getLayer('poi-title')) {
          map.removeLayer('poi-title');
        }
        if (map.getLayer('poi-line')) {
          map.removeLayer('poi-line');
        }
        if (map.getLayer('poi-circle')) {
          map.removeLayer('poi-circle');
        }
        if (map.getLayer('poi-point')) {
          map.removeLayer('poi-point');
        }
        if (map.getLayer('poi-fill')) {
          map.removeLayer('poi-fill');
        }
        if (map.getSource(id)) {
          map.removeSource(id);
        }
      };
    }
    return () => {};
  }, [
    data,
    id,
    t,
    theme.palette.geometry.main,
    theme.palette.primary.main,
    theme.palette.primary.contrastText,
  ]);

  return null;
};

export default PoiMap;

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

const PoiMap = () => {
  const id = useId();

  const theme = useTheme();
  const t = useTranslation();

  const poiLayer = usePreference('poiLayer');

  const [data, setData] = useState(null);

  useAsyncTask(
    async ({ signal }) => {
      if (poiLayer) {
        const file = await fetch(poiLayer, { signal });
        const dom = new DOMParser().parseFromString(await file.text(), 'text/xml');
        setData(kml(dom));
      }
    },
    [poiLayer],
  );

  useEffect(() => {
    if (data) {
      const geoData =
        map.coordinateSystem === 'gcj02'
          ? gcoord.transform(structuredClone(data), gcoord.WGS84, gcoord.GCJ02)
          : data;

      map.addSource(id, {
        type: 'geojson',
        data: geoData,
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

      if (uniqueIcons.length > 0) {
        Promise.all(
          uniqueIcons.map(
            (url) =>
              new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                  if (!map.hasImage(url)) {
                    map.addImage(url, img, { sdf: url.endsWith('.sdf.png') });
                  }
                  resolve();
                };
                img.onerror = () => {
                  console.error('SDF: failed to load image', url);
                  resolve();
                };
                img.src = url;
              }),
          ),
        ).then(() => {
          map.addLayer({
            source: id,
            id: 'poi-point',
            type: 'symbol',
            filter: ['all', ['==', '$type', 'Point'], ['has', 'icon']],
            metadata: { 'traccar:title': t('mapPoiLayer') },
            layout: {
              'icon-image': ['get', 'icon'],
              'icon-size': ['coalesce', ['get', 'icon-scale'], 0.1],
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
        filter: ['all', ['==', '$type', 'Point'], ['!has', 'icon']],
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

      return () => {
        popup.remove();

        map.off('click', 'poi-point', onPoiClick);
        map.off('click', 'poi-circle', onPoiClick);
        map.off('click', 'poi-title', onPoiClick);
        map.off('click', 'poi-fill', onPoiClick);
        map.off('click', 'poi-line', onPoiClick);

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
  }, [data, id, t, theme.palette.geometry.main]);

  return null;
};

export default PoiMap;

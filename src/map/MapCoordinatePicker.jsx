import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { map } from './core/MapView';
import { fromMapCoordinates } from './core/mapUtil';
import { coordinatePopupHtml } from './coordinatePopup';

const MapCoordinatePicker = () => {
  const markerRef = useRef(null);
  const popupRef = useRef(null);

  useEffect(() => {
    const onClick = (event) => {
      // Si otra capa (POI, dispositivo) ya manejó el clic, abortar
      if (event.defaultPrevented) return;

      // Fallback: buscar features POI cerca del clic (tolera pixels transparentes en símbolos)
      const { x, y } = event.point;
      const nearbyFeatures = map.queryRenderedFeatures(
        [
          [x - 10, y - 10],
          [x + 10, y + 10],
        ],
        {
          layers: [
            'poi-point',
            'poi-circle',
            'poi-title',
            'poi-fill',
            'poi-line',
            'poi-cluster',
            'poi-cluster-count',
          ],
        },
      );
      if (nearbyFeatures.length > 0) return;

      // Si ya hay un pin, solo borrarlo (toggle off)
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
        popupRef.current.remove();
        popupRef.current = null;
        return;
      }

      const { lng, lat } = event.lngLat;

      // Convertir a WGS84 por si el mapa usa otro sistema de coordenadas
      const [wgsLng, wgsLat] = fromMapCoordinates(lng, lat);

      const coordsText = `${wgsLat.toFixed(6)}, ${wgsLng.toFixed(6)}`;

      // Crear popup con coordenadas encima del pin
      popupRef.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: [0, -36],
      })
        .setLngLat([lng, lat])
        .setHTML(coordinatePopupHtml(coordsText))
        .addTo(map);

      // Crear pin en el punto clickeado
      markerRef.current = new maplibregl.Marker({
        color: '#1976d2',
      })
        .setLngLat([lng, lat])
        .addTo(map);
    };

    map.on('click', onClick);

    return () => {
      map.off('click', onClick);
      if (markerRef.current) {
        markerRef.current.remove();
      }
      if (popupRef.current) {
        popupRef.current.remove();
      }
    };
  }, []);

  return null;
};

export default MapCoordinatePicker;

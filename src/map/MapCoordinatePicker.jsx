import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { map } from './core/MapView';
import { fromMapCoordinates } from './core/mapUtil';

const MapCoordinatePicker = () => {
  const markerRef = useRef(null);
  const popupRef = useRef(null);

  useEffect(() => {
    const onClick = (event) => {
      // PoiMap marca event.originalEvent; si el clic fue sobre un POI, abortar
      if (event.originalEvent?._poiHandled) return;

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
        .setHTML(
          '<div ' +
            'style="font-size:13px;color:#999;text-align:center;margin-bottom:2px">Click para Copiar</div>' +
            '<div ' +
            'style="font-size:13px;padding:2px 10px 6px;white-space:nowrap;font-family:monospace;cursor:pointer;user-select:all;text-align:center" ' +
            `title="Copiar coordenadas" ` +
            `onclick="var t=this.textContent;navigator.clipboard.writeText(t).catch(function(){});this.textContent='¡Copiado!';setTimeout(function(){this.textContent=t;}.bind(this),1200)">` +
            `${coordsText}</div>`,
        )
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

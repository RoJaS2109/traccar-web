import { useEffect } from 'react';
import { Geolocation } from '@capacitor/geolocation';
import { map } from '../map/core/MapView';
import { getLastPosition, saveLastPosition } from './lastPositionStore';
import { getZones } from './zoneStore';
import { getCachedServerConfig } from './serverConfigStore';

// Las capas de POI en PoiMap no tienen minzoom (renderizan en todos los zooms),
// pero los íconos (icon-scale 0.4) solo se distinguen individualmente a partir
// de ~z12. Coincide con el zoom por defecto del servidor, donde se ven bien.
const POI_MIN_ZOOM = 12;

const currentPositionIfGranted = async () => {
  // Solo se consulta la posición si el permiso de ubicación (fino o aproximado)
  // ya está concedido. @capacitor/geolocation expone el estado real del permiso,
  // a diferencia de navigator.permissions, que en la WebView siempre devuelve
  // "prompt". Nunca se llama a requestPermissions: el diálogo de permiso sigue
  // siendo cosa del botón de ubicación.
  let perms;
  try {
    perms = await Geolocation.checkPermissions();
  } catch {
    // Sin permiso o con servicios de ubicación deshabilitados → caer.
    return null;
  }
  if (perms.location !== 'granted' && perms.coarseLocation !== 'granted') return null;
  try {
    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 5000,
      maximumAge: 30_000,
    });
    return { lng: position.coords.longitude, lat: position.coords.latitude };
  } catch {
    // Sin fix (p. ej. bajo techo) o sin geolocation → caer al siguiente paso.
    return null;
  }
};

const mostRecentZoneBounds = async () => {
  try {
    // zoneStore devuelve las zonas ordenadas por fecha de modificación descendente,
    // así que la primera es la más reciente.
    const zones = await getZones();
    const zone = zones[0];
    if (!zone) return null;
    return {
      bounds: [
        [zone.minLon, zone.minLat],
        [zone.maxLon, zone.maxLat],
      ],
      maxZoom: zone.maxZoom,
    };
  } catch {
    return null;
  }
};

const OfflineCamera = () => {
  useEffect(() => {
    let cancelled = false;

    const jump = (center, zoom) => {
      if (cancelled || !center) return;
      try {
        map.jumpTo({ center, zoom });
      } catch (error) {
        console.warn('No se pudo centrar el mapa offline', error);
      }
    };

    (async () => {
      // 1) Posición GPS actual, solo con permiso ya concedido.
      const current = await currentPositionIfGranted();
      if (cancelled) return;
      if (current) {
        jump([current.lng, current.lat], POI_MIN_ZOOM);
        // Persistir la posición obtenida por el plugin con el mismo throttling
        // que MapCurrentLocation, para el próximo arranque sin red.
        saveLastPosition({ lat: current.lat, lng: current.lng });
        return;
      }

      // 2) Última posición conocida (persistida por MapCurrentLocation).
      const last = await getLastPosition();
      if (cancelled) return;
      if (last && typeof last.lat === 'number' && typeof last.lng === 'number') {
        jump([last.lng, last.lat], POI_MIN_ZOOM);
        return;
      }

      // 3) Centro de la zona descargada más reciente.
      const zone = await mostRecentZoneBounds();
      if (cancelled) return;
      if (zone) {
        try {
          map.fitBounds(zone.bounds, { padding: 40, maxZoom: zone.maxZoom || POI_MIN_ZOOM });
        } catch (error) {
          console.warn('No se pudo encuadrar la zona offline', error);
        }
        return;
      }

      // 4) Ubicación por defecto del serverConfig cacheado.
      const config = await getCachedServerConfig();
      if (cancelled) return;
      if (config && config.latitude != null && config.longitude != null) {
        jump([config.longitude, config.latitude], config.zoom || POI_MIN_ZOOM);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
};

export default OfflineCamera;

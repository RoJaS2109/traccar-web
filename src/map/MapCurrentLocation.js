import * as maplibregl from 'maplibre-gl';
import { useEffect } from 'react';
import { map } from './core/MapView';
import { useTheme } from '@mui/material';
import { saveLastPosition } from '../offline/lastPositionStore';

const MapCurrentLocation = () => {
  const theme = useTheme();

  useEffect(() => {
    const control = new maplibregl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
        timeout: 5000,
      },
      trackUserLocation: false,
    });
    // Cada vez que el botón de ubicación obtiene una posición, se persiste la
    // última posición conocida (con throttling) para poder centrar el mapa
    // offline en el arranque sin red.
    control.on('geolocate', (event) => {
      const { latitude, longitude } = event.coords || {};
      if (typeof latitude === 'number' && typeof longitude === 'number') {
        saveLastPosition({ lat: latitude, lng: longitude });
      }
    });
    map.addControl(control, theme.direction === 'rtl' ? 'top-left' : 'top-right');
    return () => map.removeControl(control);
  }, [theme.direction]);

  return null;
};

export default MapCurrentLocation;

import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { Geolocation } from '@capacitor/geolocation';
import { Alert, Snackbar, useTheme } from '@mui/material';
import { map } from './core/MapView';
import { useTranslation } from '../common/components/LocalizationProvider';
import { saveLastPosition } from '../offline/lastPositionStore';

// Opciones del watch: alta precisión y timeout largo (un fix en frío sin AGPS puede
// tardar 30-60 s). maximumAge acepta un fix reciente y enableLocationFallback usa el
// LocationManager nativo cuando Play Services no responde (p. ej. modo avión, solo GPS).
const WATCH_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 60_000,
  maximumAge: 30_000,
  interval: 2000,
  enableLocationFallback: true,
};

// Sin fix tras este tiempo se muestra el error explícito. Es un respaldo por si el
// plugin no dispara su propio callback de timeout; mayor que WATCH_OPTIONS.timeout
// para no pisar ese error con uno propio.
const MANUAL_TIMEOUT_MS = 90_000;

// Botón con el aspecto exacto del GeolocateControl de maplibre (mismas clases CSS),
// pero cuya lógica de geolocalización está delegada a @capacitor/geolocation.
class LocationButtonControl {
  constructor(onClick) {
    this.onClick = onClick;
  }

  onAdd() {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'maplibregl-ctrl-geolocate';
    this.button.innerHTML = '<span class="maplibregl-ctrl-icon" aria-hidden="true"></span>';
    this.button.addEventListener('click', () => this.onClick());
    this.container.appendChild(this.button);
    return this.container;
  }

  onRemove() {
    this.container.remove();
  }

  setStatus(status) {
    const classes = [
      'maplibregl-ctrl-geolocate-waiting',
      'maplibregl-ctrl-geolocate-active',
      'maplibregl-ctrl-geolocate-active-error',
    ];
    classes.forEach((cls) => this.button.classList.remove(cls));
    if (status === 'searching') {
      this.button.classList.add(
        'maplibregl-ctrl-geolocate-waiting',
        'maplibregl-ctrl-geolocate-active',
      );
    } else if (status === 'active') {
      this.button.classList.add('maplibregl-ctrl-geolocate-active');
    } else if (status === 'error') {
      this.button.classList.add('maplibregl-ctrl-geolocate-active-error');
    }
  }
}

// Punto del usuario con el estilo nativo de maplibre.
const createDot = () => {
  const el = document.createElement('div');
  el.className = 'maplibregl-user-location-dot';
  return new maplibregl.Marker({ element: el, anchor: 'center' });
};

// Círculo de precisión. El radio (en píxeles) se recalcula según la accuracy y el zoom.
const createAccuracyCircle = () => {
  const el = document.createElement('div');
  el.className = 'maplibregl-user-location-accuracy-circle';
  return { marker: new maplibregl.Marker({ element: el, anchor: 'center' }), el };
};

const MapCurrentLocation = () => {
  const theme = useTheme();
  const t = useTranslation();

  const [status, setStatus] = useState('idle'); // idle | searching | active | error
  const [message, setMessage] = useState(null);

  const controlRef = useRef(null);
  const watchIdRef = useRef(null);
  const watchingRef = useRef(false);
  const dotRef = useRef(null);
  const circleRef = useRef(null);
  const followingRef = useRef(false);
  const lastCenterRef = useRef(null);
  const lastAccuracyRef = useRef(null);
  const manualTimerRef = useRef(null);
  const mountedRef = useRef(false);

  const applyStatus = (next) => {
    if (!mountedRef.current) return;
    setStatus(next);
    controlRef.current?.setStatus(next);
  };

  const showMessage = (value) => {
    if (mountedRef.current) setMessage(value);
  };

  const clearWatch = () => {
    watchingRef.current = false;
    if (watchIdRef.current != null) {
      const id = watchIdRef.current;
      watchIdRef.current = null;
      Geolocation.clearWatch({ id }).catch(() => {});
    }
  };

  const clearManualTimer = () => {
    if (manualTimerRef.current) {
      clearTimeout(manualTimerRef.current);
      manualTimerRef.current = null;
    }
  };

  const removeMarkers = () => {
    dotRef.current?.remove();
    dotRef.current = null;
    if (circleRef.current) {
      circleRef.current.marker.remove();
      circleRef.current = null;
    }
    lastCenterRef.current = null;
    lastAccuracyRef.current = null;
  };

  const resizeAccuracyCircle = () => {
    const circle = circleRef.current;
    const accuracy = lastAccuracyRef.current;
    const center = lastCenterRef.current;
    if (!circle || accuracy == null || !center) return;
    const latRad = (center.lat * Math.PI) / 180;
    const metersPerPixel = (156543.03392 * Math.cos(latRad)) / 2 ** map.getZoom();
    const radiusPx = Math.max(4, accuracy / metersPerPixel);
    circle.el.style.width = `${radiusPx * 2}px`;
    circle.el.style.height = `${radiusPx * 2}px`;
  };

  const updatePosition = (position) => {
    const { latitude, longitude, accuracy } = position.coords;
    const center = new maplibregl.LngLat(longitude, latitude);
    const isFirst = !dotRef.current;

    if (isFirst) {
      applyStatus('active');
      showMessage(null);
    }

    if (!dotRef.current) {
      dotRef.current = createDot();
      dotRef.current.setLngLat(center).addTo(map);
    } else {
      dotRef.current.setLngLat(center);
    }

    if (accuracy != null) {
      lastAccuracyRef.current = accuracy;
      lastCenterRef.current = center;
      if (!circleRef.current) {
        circleRef.current = createAccuracyCircle();
        circleRef.current.marker.setLngLat(center).addTo(map);
      } else {
        circleRef.current.marker.setLngLat(center);
      }
      resizeAccuracyCircle();
    }

    saveLastPosition({ lat: latitude, lng: longitude });

    if (followingRef.current) {
      if (isFirst) {
        // Primer fix: encuadrar el círculo de precisión (máx. z15).
        const radius = accuracy != null ? accuracy : 100;
        map.fitBounds(maplibregl.LngLatBounds.fromLngLat(center, radius), {
          maxZoom: 15,
          duration: 800,
        });
      } else {
        map.easeTo({ center, duration: 400 });
      }
    }
  };

  const stop = () => {
    followingRef.current = false;
    clearManualTimer();
    clearWatch();
    removeMarkers();
    applyStatus('idle');
    showMessage(null);
  };

  const failWith = (key) => {
    clearManualTimer();
    clearWatch();
    removeMarkers();
    applyStatus('error');
    showMessage(t(key));
  };

  const handleClick = async () => {
    // Segundo toque (o toque mientras busca): detener.
    if (watchingRef.current) {
      stop();
      return;
    }

    // Permisos: si no está concedido, pedirlo; si solo queda la aproximada, avisar.
    try {
      let perm = await Geolocation.checkPermissions();
      if (perm.location !== 'granted') {
        perm = await Geolocation.requestPermissions();
      }
      if (perm.location !== 'granted') {
        failWith(
          perm.coarseLocation === 'granted' ? 'locationApproximate' : 'locationPermissionDenied',
        );
        return;
      }
    } catch {
      failWith('locationPermissionDenied');
      return;
    }

    applyStatus('searching');
    showMessage(t('locationSearching'));
    followingRef.current = true;
    watchingRef.current = true;
    watchIdRef.current = null;
    clearManualTimer();
    manualTimerRef.current = setTimeout(() => failWith('locationTimeout'), MANUAL_TIMEOUT_MS);

    try {
      const id = await Geolocation.watchPosition(WATCH_OPTIONS, (position, err) => {
        // Callback rezagado: el watch ya se detuvo (segundo toque, segundo plano o
        // desmontaje) pero el plugin alcanzó a emitir. Sin esta guarda el punto y el
        // estado "activo" revivirían sobre un watch que ya no existe.
        if (!watchingRef.current) return;
        if (err) {
          failWith('locationTimeout');
          return;
        }
        if (position) {
          clearManualTimer();
          updatePosition(position);
        }
      });
      // El watch pudo detenerse durante el await (segundo toque inmediato): no
      // conservar un id huérfano.
      if (watchingRef.current) {
        watchIdRef.current = id;
      } else {
        Geolocation.clearWatch({ id }).catch(() => {});
      }
    } catch {
      failWith('locationTimeout');
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    const control = new LocationButtonControl(handleClick);
    controlRef.current = control;
    map.addControl(control, theme.direction === 'rtl' ? 'top-left' : 'top-right');

    const onDragStart = () => {
      // El usuario arrastró el mapa: dejar de mover la cámara, pero seguir el punto.
      if (followingRef.current) followingRef.current = false;
    };
    const onZoom = () => resizeAccuracyCircle();
    map.on('dragstart', onDragStart);
    map.on('zoom', onZoom);

    const onVisibility = () => {
      // La app pasa a segundo plano: detener el watch para no gastar GPS/batería.
      if (document.hidden && watchingRef.current) stop();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      mountedRef.current = false;
      map.removeControl(control);
      map.off('dragstart', onDragStart);
      map.off('zoom', onZoom);
      document.removeEventListener('visibilitychange', onVisibility);
      clearManualTimer();
      clearWatch();
      removeMarkers();
      controlRef.current = null;
    };
    // handleClick/stop usan refs y setters estables, no hace falta listarlos aquí.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [theme.direction]);

  return (
    <Snackbar
      open={Boolean(message)}
      autoHideDuration={status === 'error' ? 6000 : null}
      // Sin onClose el mensaje nunca se limpia: MUI oculta la transición pero `open`
      // sigue en true, así que el cartel reaparece en cada re-render.
      onClose={() => setMessage(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert severity={status === 'error' ? 'error' : 'info'} variant="filled">
        {message}
      </Alert>
    </Snackbar>
  );
};

export default MapCurrentLocation;

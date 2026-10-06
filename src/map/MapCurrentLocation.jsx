import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { Geolocation } from '@capacitor/geolocation';
import { Alert, Snackbar, Typography, useTheme } from '@mui/material';
import { map } from './core/MapView';
import { useTranslation } from '../common/components/LocalizationProvider';
import usePersistedState from '../common/util/usePersistedState';
import { saveLastPosition } from '../offline/lastPositionStore';
import { isNative } from '../offline/nativeBootstrap';
import { createScreenWakeLock } from './screenWakeLock';
import { createFollowState } from './followState';
import { nextHeading } from './heading';
import MapHeadingMode from './control/MapHeadingMode';

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

// Duración de la animación que recentra el punto. El watch entrega un fix cada ~2 s
// (WATCH_OPTIONS.interval); con la mitad de ese intervalo la cámara llega al centro y
// se asienta entre fix y fix, en vez de quedar siempre persiguiendo al siguiente.
const FOLLOW_EASE_MS = 1000;

// Detalle de diagnóstico que acompaña al mensaje de error: código y texto crudos del
// plugin, tal como los devuelve. Se muestra en letra chica para poder diagnosticar con
// una captura de pantalla, sin depender de logcat. Si el error no trae ni código ni
// mensaje se devuelve null y el detalle no se muestra (nunca "[object Object]").
const describeError = (err) => {
  if (!err) return null;
  if (typeof err === 'string') return err;
  const parts = [];
  if (err.code != null) parts.push(String(err.code));
  if (err.message) parts.push(String(err.message));
  return parts.length ? parts.join(' · ') : null;
};

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
  const [messageDetail, setMessageDetail] = useState(null);
  // Modo del mapa. Se recuerda entre sesiones; sin una elección previa arranca en rumbo
  // arriba, que es lo útil al navegar.
  const [headingUp, setHeadingUp] = usePersistedState('mapHeadingUp', true);

  const controlRef = useRef(null);
  const watchIdRef = useRef(null);
  const watchingRef = useRef(false);
  const dotRef = useRef(null);
  const circleRef = useRef(null);
  const lastCenterRef = useRef(null);
  const lastAccuracyRef = useRef(null);
  const manualTimerRef = useRef(null);
  const mountedRef = useRef(false);
  // Modo de seguimiento guardado cuando la app pasa a segundo plano, o null si el watch
  // no lo detuvimos nosotros. Es lo que decide si hay que reanudar al volver.
  const suspendedRef = useRef(null);
  const resumingRef = useRef(false);
  // Mantiene la pantalla encendida mientras se navega o el teléfono carga.
  const screenLockRef = useRef(null);
  // Último rumbo suavizado, o null si todavía no hubo una muestra creíble. Es el rumbo al
  // que se rota el mapa en modo "rumbo arriba".
  const headingRef = useRef(null);
  // Espejo del modo elegido, para leerlo desde callbacks estables (recentrado, botón) sin
  // tener que recrearlos en cada cambio de estado.
  const headingUpRef = useRef(headingUp);
  headingUpRef.current = headingUp;

  // Rumbo que le corresponde al mapa según el modo: norte arriba es 0 y "rumbo arriba"
  // sigue el rumbo del GPS. Devuelve null mientras no haya un rumbo creíble: en ese caso
  // no se toca el rumbo en vez de saltar a un valor inventado.
  const targetBearing = () => (headingUpRef.current ? headingRef.current : 0);

  // Centra la cámara en el último fix. Sin padding, para que el punto quede en el
  // centro exacto del viewport: en el teléfono el mapa no tiene padding (MapPadding
  // solo aplica al drawer de escritorio).
  const recenter = () => {
    const center = lastCenterRef.current;
    if (!center) return;
    const bearing = targetBearing();
    map.easeTo({
      center,
      duration: FOLLOW_EASE_MS,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      // El rumbo viaja en el mismo easeTo que el centro: con dos animaciones separadas la
      // rotación y el desplazamiento quedarían desfasados entre sí.
      ...(bearing == null ? {} : { bearing }),
    });
  };

  // Rota el mapa al rumbo que corresponde al modo, sin mover el centro. Se usa en las
  // acciones explícitas (alternar el botón, terminar la navegación): durante la
  // navegación la rotación va junto con el recentrado, en el mismo easeTo.
  const applyBearing = () => {
    const bearing = targetBearing();
    if (bearing == null || bearing === map.getBearing()) return;
    map.easeTo({ bearing, duration: FOLLOW_EASE_MS });
  };

  const toggleHeadingUp = () => {
    const next = !headingUpRef.current;
    // El ref se adelanta al estado: la animación de abajo tiene que usar ya el modo nuevo
    // y no el que el estado sigue devolviendo hasta el próximo render.
    headingUpRef.current = next;
    setHeadingUp(next);
    applyBearing();
  };

  // Vuelve el mapa al norte con una animación. No toca el modo elegido: la preferencia se
  // recuerda para la próxima navegación, pero la rotación solo tiene sentido mientras se
  // navega.
  const resetBearing = () => {
    headingRef.current = null;
    if (Math.abs(map.getBearing()) > 0.1) {
      map.easeTo({ bearing: 0, duration: FOLLOW_EASE_MS });
    }
  };

  // Máquina de seguimiento (siguiendo / pausado por interacción del usuario). Se crea
  // una sola vez: si el efecto de montaje se reejecuta, no debe perderse el estado.
  const followRef = useRef(null);
  if (!followRef.current) {
    followRef.current = createFollowState({ onResume: recenter });
  }

  const applyStatus = (next) => {
    if (!mountedRef.current) return;
    setStatus(next);
    controlRef.current?.setStatus(next);
  };

  const showMessage = (value, detail = null) => {
    if (!mountedRef.current) return;
    setMessage(value);
    // Sin mensaje no hay detalle: evita que quede un detalle huérfano en pantalla.
    setMessageDetail(value ? detail : null);
  };

  const clearWatch = () => {
    watchingRef.current = false;
    // Sin watch no se está navegando: la pantalla deja de mantenerse encendida,
    // salvo que el teléfono esté cargando (lo decide el propio wake lock).
    screenLockRef.current?.setNavigating(false);
    // Fuera de la navegación el zoom por gestos vuelve a ir alrededor del punto medio
    // de los dedos, que es lo que se espera al explorar el mapa.
    map.touchZoomRotate.enable();
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
    const { latitude, longitude, accuracy, heading, speed } = position.coords;
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

    // El centro se guarda siempre: es el objetivo del recentrado, incluso en un fix
    // sin accuracy, donde no hay círculo que redibujar.
    lastCenterRef.current = center;
    if (accuracy != null) {
      lastAccuracyRef.current = accuracy;
      if (!circleRef.current) {
        circleRef.current = createAccuracyCircle();
        circleRef.current.marker.setLngLat(center).addTo(map);
      } else {
        circleRef.current.marker.setLngLat(center);
      }
      resizeAccuracyCircle();
    }

    saveLastPosition({ lat: latitude, lng: longitude });

    // Rumbo suavizado para la rotación del mapa. Se calcula en los dos modos: así al pasar
    // a "rumbo arriba" el rumbo ya está listo y suavizado, en vez de empezar de cero.
    headingRef.current = nextHeading({ previous: headingRef.current, heading, speed });

    // Pausado por una interacción del usuario el punto se sigue actualizando, pero la
    // cámara no se mueve hasta que vence el temporizador de reanudación.
    if (followRef.current.isFollowing()) {
      if (isFirst) {
        // Primer fix: encuadrar el círculo de precisión (máx. z15). El punto queda
        // centrado igual, porque el encuadre se calcula a partir de él.
        const radius = accuracy != null ? accuracy : 100;
        map.fitBounds(maplibregl.LngLatBounds.fromLngLat(center, radius), {
          maxZoom: 15,
          duration: 800,
        });
      } else {
        recenter();
      }
    }
  };

  const stop = () => {
    // Fin de la navegación: deja de seguir y descarta cualquier reanudación pendiente.
    followRef.current.stop();
    // Sin rumbo que mantener, el mapa vuelve a norte arriba.
    resetBearing();
    clearManualTimer();
    clearWatch();
    removeMarkers();
    applyStatus('idle');
    showMessage(null);
  };

  const failWith = (key, detail = null) => {
    // La navegación terminó igual que con el botón: no dejar el mapa girado sin rumbo al
    // que seguir.
    resetBearing();
    clearManualTimer();
    clearWatch();
    removeMarkers();
    applyStatus('error');
    showMessage(t(key), detail);
  };

  // Arranca el watch con los permisos ya resueltos. `following` define si la cámara sigue
  // el punto; se conserva al reanudar para no recentrar si el usuario había arrastrado.
  const startWatch = ({ following = true } = {}) => {
    applyStatus('searching');
    showMessage(t('locationSearching'));
    // Al arrancar se sigue desde el primer fix; si se reanuda con el seguimiento
    // pausado, se rearranca la cuenta atrás en vez de recentrar de golpe.
    if (following) {
      followRef.current.start();
    } else {
      followRef.current.interact();
    }
    // Durante la navegación el zoom por gestos va alrededor del centro: si fuera
    // alrededor del punto medio de los dedos, el punto azul se correría del centro.
    map.touchZoomRotate.enable({ around: 'center' });
    watchingRef.current = true;
    // Arrancó la navegación: la pantalla no debe apagarse aunque se desconecte
    // el cargador.
    screenLockRef.current?.setNavigating(true);
    watchIdRef.current = null;
    clearManualTimer();
    manualTimerRef.current = setTimeout(
      () => failWith('locationTimeout', t('locationNoCallback')),
      MANUAL_TIMEOUT_MS,
    );

    return Geolocation.watchPosition(WATCH_OPTIONS, (position, err) => {
      // Callback rezagado: el watch ya se detuvo (segundo toque, segundo plano o
      // desmontaje) pero el plugin alcanzó a emitir. Sin esta guarda el punto y el
      // estado "activo" revivirían sobre un watch que ya no existe.
      if (!watchingRef.current) return;
      if (err) {
        failWith('locationTimeout', describeError(err));
        return;
      }
      if (position) {
        clearManualTimer();
        updatePosition(position);
      }
    })
      .then((id) => {
        // El watch pudo detenerse durante el await (segundo toque inmediato): no
        // conservar un id huérfano.
        if (watchingRef.current) {
          watchIdRef.current = id;
        } else {
          Geolocation.clearWatch({ id }).catch(() => {});
        }
      })
      .catch((err) => {
        failWith('locationTimeout', describeError(err));
      });
  };

  // Reanuda al volver a primer plano. Usa checkPermissions (no requestPermissions) para
  // no disparar un diálogo al usuario que solo volvió a la app: si el permiso ya no está
  // concedido —p. ej. revocado desde Ajustes mientras la app estaba en segundo plano—
  // no se reanuda y el botón queda disponible.
  const resume = async (following) => {
    if (resumingRef.current || watchingRef.current) return;
    resumingRef.current = true;
    try {
      const perm = await Geolocation.checkPermissions();
      // El chequeo y el arranque están en el mismo tick: si el usuario tocó el botón
      // mientras esperábamos los permisos, no se arranca un segundo watch. mountedRef
      // cubre el desmontaje ocurrido durante la espera, que dejaría un watch sin dueño.
      if (
        perm.location === 'granted' &&
        !document.hidden &&
        !watchingRef.current &&
        mountedRef.current
      ) {
        startWatch({ following });
      }
    } catch {
      // Sin poder verificar el permiso no se reanuda: mejor detenido que disparando un
      // diálogo de permisos al volver del segundo plano.
    } finally {
      resumingRef.current = false;
    }
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
          // El estado real que devolvió el plugin: distingue "nunca se concedió" de
          // "el sistema lo revocó en segundo plano" sin necesidad de logcat.
          `location: ${perm.location} · coarseLocation: ${perm.coarseLocation}`,
        );
        return;
      }
    } catch (err) {
      failWith('locationPermissionDenied', describeError(err));
      return;
    }

    startWatch();
  };

  useEffect(() => {
    mountedRef.current = true;
    // Pantalla encendida al navegar o al cargar. Solo en la app nativa: en el
    // navegador de escritorio mantener la pantalla despierta por estar enchufado
    // no tiene sentido.
    if (isNative()) {
      screenLockRef.current = createScreenWakeLock({
        onError: (err) => console.warn('No se pudo mantener la pantalla encendida', err),
      });
      screenLockRef.current.start();
    }
    const control = new LocationButtonControl(handleClick);
    controlRef.current = control;
    map.addControl(control, theme.direction === 'rtl' ? 'top-left' : 'top-right');

    // Interacción del usuario con el mapa: pausa el seguimiento, que se retoma solo a
    // los 8 s. No se usan zoomstart/rotatestart porque easeTo también los dispara
    // (serían programáticos); dragstart solo lo emite el arrastre real, y
    // touchstart/wheel sobre el canvas cubren pellizco, rotación y rueda.
    const onUserGesture = () => followRef.current.interact();
    const canvas = map.getCanvas();
    map.on('dragstart', onUserGesture);
    canvas.addEventListener('touchstart', onUserGesture, { passive: true });
    canvas.addEventListener('wheel', onUserGesture, { passive: true });

    const onZoom = () => resizeAccuracyCircle();
    map.on('zoom', onZoom);

    const onVisibility = () => {
      if (document.hidden) {
        // La app pasa a segundo plano: detener el watch para no gastar GPS/batería.
        // Se guarda el modo de seguimiento para reanudarlo tal cual al volver.
        if (watchingRef.current) {
          // Se guarda si estaba siguiendo o pausado, para volver en el mismo estado.
          suspendedRef.current = { following: followRef.current.isFollowing() };
          stop();
        }
      } else if (suspendedRef.current) {
        const { following } = suspendedRef.current;
        suspendedRef.current = null;
        resume(following);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      mountedRef.current = false;
      map.removeControl(control);
      map.off('dragstart', onUserGesture);
      canvas.removeEventListener('touchstart', onUserGesture);
      canvas.removeEventListener('wheel', onUserGesture);
      map.off('zoom', onZoom);
      document.removeEventListener('visibilitychange', onVisibility);
      clearManualTimer();
      clearWatch();
      removeMarkers();
      screenLockRef.current?.stop();
      screenLockRef.current = null;
      controlRef.current = null;
    };
    // handleClick/stop usan refs y setters estables, no hace falta listarlos aquí.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [theme.direction]);

  return (
    <>
      <MapHeadingMode
        visible={status === 'searching' || status === 'active'}
        headingUp={headingUp}
        onToggle={toggleHeadingUp}
      />
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
          {messageDetail && (
            <Typography
              variant="caption"
              sx={{ display: 'block', mt: 0.5, opacity: 0.85, wordBreak: 'break-word' }}
            >
              {t('locationErrorDetail')} {messageDetail}
            </Typography>
          )}
        </Alert>
      </Snackbar>
    </>
  );
};

export default MapCurrentLocation;

import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import { googleProtocol } from 'maplibre-google-maps';
import { useRef, useLayoutEffect, useEffect, useState, useMemo } from 'react';
import { useTheme } from '@mui/material';
import MapSwitcher from '../control/MapSwitcher';
import { useAttributePreference, usePreference } from '../../common/util/preferences';
import usePersistedState from '../../common/util/usePersistedState';
import { mapImages } from './preloadImages';
import useMapStyles from './useMapStyles';
import { isNative } from '../../offline/nativeBootstrap';
import { getOfflineStyle } from '../../offline/offlineStyle';
import { getZones, onZonesChanged } from '../../offline/zoneStore';
import { computeOfflineMaxZoom, OFFLINE_DEFAULT_MAX_ZOOM } from '../../offline/offlineMaxZoom';
import { useAsyncTask } from '../../reactHelper';
import { migrateSelectedMapStyle } from './mapStyleMigration';
import { pmtilesProtocol } from './pmtilesProtocol';
import { registerOnlinePmtiles } from './onlinePmtilesStyle';

// Migración única del estilo guardado. Corre a nivel de módulo (antes del primer
// render de MapView, que lee selectedMapStyle vía usePersistedState).
migrateSelectedMapStyle(window.localStorage, isNative());

const element = document.createElement('div');
element.style.width = '100%';
element.style.height = '100%';
element.style.boxSizing = 'initial';

maplibregl.addProtocol('google', googleProtocol);
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

export const map = new maplibregl.Map({
  container: element,
  attributionControl: false,
  localIdeographFontFamily: 'sans-serif',
});

let ready = false;
const readyListeners = new Set();

const addReadyListener = (listener) => {
  readyListeners.add(listener);
  listener(ready);
};

const removeReadyListener = (listener) => {
  readyListeners.delete(listener);
};

const updateReadyValue = (value) => {
  ready = value;
  readyListeners.forEach((listener) => listener(value));
};

const initMap = async () => {
  if (ready) return;
  if (!map.hasImage('background')) {
    Object.entries(mapImages).forEach(([key, value]) => {
      map.addImage(key, value, {
        pixelRatio: window.devicePixelRatio,
      });
    });
  }
};

const MapView = ({ children, offline = false }) => {
  const theme = useTheme();

  const containerRef = useRef(null);

  const [mapReady, setMapReady] = useState(false);
  const [offlineMaxZoom, setOfflineMaxZoom] = useState(OFFLINE_DEFAULT_MAX_ZOOM);

  const mapStyles = useMapStyles();
  const activeMapStyles = useAttributePreference(
    'activeMapStyles',
    'locationIqStreets,locationIqDark,openFreeMap',
  );
  const preferenceDefault = usePreference('map', 'locationIqStreets');
  const [selectedStyleId, setSelectedStyleId] = usePersistedState(
    'selectedMapStyle',
    // En nativo se usa OpenFreeMap por defecto: el IGN (Argenmap) está caído.
    // Se conservan las entradas IGN en el MapSwitcher, pero no como default.
    isNative() ? 'openFreeMap' : preferenceDefault,
  );
  const maxZoom = useAttributePreference('web.maxZoom');

  const styles = useMemo(() => {
    // En pantalla offline se usa el estilo offline vigente (getOfflineStyle) y
    // nada más: sin estilos online ni MapSwitcher.
    if (offline) {
      return [{ id: 'offline', title: 'Offline', style: getOfflineStyle(offlineMaxZoom) }];
    }
    // En nativo se muestran siempre los estilos propios (native) junto con los
    // online activos. La selección es manual vía MapSwitcher: no se depende de
    // navigator.onLine, que es inestable en el WebView de Android.
    const filtered = mapStyles.filter(
      (s) => s.available && (s.native || activeMapStyles.includes(s.id)),
    );
    return filtered.length ? filtered : mapStyles.filter((s) => s.id === 'osm');
  }, [mapStyles, activeMapStyles, offline, offlineMaxZoom]);

  const effectiveStyleId = offline ? 'offline' : selectedStyleId;

  // En pantalla offline, el maxzoom de la fuente del estilo depende de las zonas
  // instaladas: si hay zonas viejas z14 mezcladas con z15, se usa el mínimo para que
  // MapLibre haga overzoom del z14 en esas áreas en vez de pedir tiles z15 que no
  // existen. Se recalcula al montar y cada vez que cambia el conjunto de zonas.
  useEffect(() => {
    if (!offline) return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const zones = await getZones();
        if (!cancelled) setOfflineMaxZoom(computeOfflineMaxZoom(zones));
      } catch {
        if (!cancelled) setOfflineMaxZoom(OFFLINE_DEFAULT_MAX_ZOOM);
      }
    };
    refresh();
    const unsubscribe = onZonesChanged(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [offline]);

  useAsyncTask(async () => {
    if (theme.direction === 'rtl') {
      maplibregl.setRTLTextPlugin('/mapbox-gl-rtl-text.js');
    }
  }, [theme.direction]);

  useEffect(() => {
    const attribution = new maplibregl.AttributionControl({ compact: true });
    const navigation = new maplibregl.NavigationControl();
    map.addControl(attribution, theme.direction === 'rtl' ? 'bottom-left' : 'bottom-right');
    map.addControl(navigation, theme.direction === 'rtl' ? 'top-left' : 'top-right');
    return () => {
      map.removeControl(navigation);
      map.removeControl(attribution);
    };
  }, [theme.direction]);

  useEffect(() => {
    if (maxZoom) {
      map.setMaxZoom(maxZoom);
    }
  }, [maxZoom]);

  useEffect(() => {
    const style = styles.find((s) => s.id === effectiveStyleId);
    if (!style) {
      setSelectedStyleId(styles[0].id);
      return;
    }
    if (style.pmtiles) {
      registerOnlinePmtiles();
    }
    updateReadyValue(false);
    map.coordinateSystem = style.coordinateSystem;
    map.setStyle(style.style, { diff: false });
    map.setTransformRequest(style.transformRequest);
    let timeoutId;
    const waiting = () => {
      if (!map.loaded()) {
        timeoutId = setTimeout(waiting, 33);
      } else {
        initMap();
        updateReadyValue(true);
      }
    };
    map.once('styledata', waiting);
    return () => clearTimeout(timeoutId);
  }, [styles, effectiveStyleId, setSelectedStyleId]);

  useEffect(() => {
    const listener = (ready) => setMapReady(ready);
    addReadyListener(listener);
    return () => {
      removeReadyListener(listener);
    };
  }, []);

  useLayoutEffect(() => {
    const currentEl = containerRef.current;
    currentEl.appendChild(element);
    map.resize();
    return () => {
      currentEl.removeChild(element);
    };
  }, [containerRef]);

  return (
    <div style={{ width: '100%', height: '100%' }} ref={containerRef}>
      {!offline && (
        <MapSwitcher styles={styles} selectedId={effectiveStyleId} onSelect={setSelectedStyleId} />
      )}
      {mapReady && children}
    </div>
  );
};

export default MapView;

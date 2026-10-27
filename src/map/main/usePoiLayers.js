import { useEffect, useMemo, useState } from 'react';
import { useAttributePreference, usePreference } from '../../common/util/preferences';
import usePersistedState from '../../common/util/usePersistedState';
import { cachePoiLayers, getCachedPoiLayers } from '../../offline/poiKmlStore';
import { parsePoiLayers } from './poiLayers';

// KML de POIs configurados y cuáles ocultó el usuario en este dispositivo. Se guardan
// los ocultos (no los visibles) para que un KML nuevo en la lista aparezca activado.
export default () => {
  const poiLayersPref = useAttributePreference('poiLayers');
  const poiLayerPref = usePreference('poiLayer');

  const configured = useMemo(
    () => parsePoiLayers(poiLayersPref, poiLayerPref),
    [poiLayersPref, poiLayerPref],
  );
  const [cached, setCached] = useState([]);

  // Online la preferencia manda y se persiste; offline (sin preferencias) se usa la
  // lista persistida para poder cargar los KML cacheados.
  useEffect(() => {
    if (configured.length > 0) {
      cachePoiLayers(configured);
      return undefined;
    }
    let cancelled = false;
    getCachedPoiLayers().then((layers) => {
      if (!cancelled) setCached(layers);
    });
    return () => {
      cancelled = true;
    };
  }, [configured]);

  const [hidden, setHidden] = usePersistedState('hiddenPoiLayers', []);

  return { layers: configured.length > 0 ? configured : cached, hidden, setHidden };
};

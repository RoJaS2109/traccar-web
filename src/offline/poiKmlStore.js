import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';

// Antes del selector de KML se cacheaba un único KML en estas claves; se siguen
// leyendo para no perder el caché de las instalaciones existentes.
const LEGACY_KML_PATH = 'poi/general.kml';
const LEGACY_META_KEY = 'poiKmlMeta';
const LEGACY_POI_LAYER_KEY = 'poiLayer';
const POI_LAYERS_KEY = 'poiLayers';

// --- lista de KML persistida ---
// La lista depende de preferencias de usuario/servidor que no están disponibles
// offline. Se persiste para poder cargar los KML cacheados cuando la preferencia
// no resuelve (arranque en frío sin red).

export const cachePoiLayers = async (layers) => {
  try {
    await Preferences.set({ key: POI_LAYERS_KEY, value: JSON.stringify(layers) });
  } catch (error) {
    console.warn('No se pudo persistir la lista de KML', error);
  }
};

export const getCachedPoiLayers = async () => {
  try {
    const { value } = await Preferences.get({ key: POI_LAYERS_KEY });
    if (value) return JSON.parse(value);
    const legacy = await Preferences.get({ key: LEGACY_POI_LAYER_KEY });
    return legacy.value ? [{ name: '', url: legacy.value }] : [];
  } catch (error) {
    console.warn('No se pudo leer la lista de KML persistida', error);
    return [];
  }
};

// --- utilidades ---

// FNV-1a 32-bit: hash barato para detección de cambios (fallback a Last-Modified).
const hashString = (str) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};

// Cada KML se cachea en su propio archivo y su propia metadata, según su URL.
const kmlPath = (url) => `poi/${hashString(url)}.kml`;
const metaKey = (url) => `poiKmlMeta:${hashString(url)}`;

// --- metadata del caché (Preferences) ---

const getCachedMeta = async (url) => {
  try {
    const { value } = await Preferences.get({ key: metaKey(url) });
    if (value) return JSON.parse(value);
    const legacy = await Preferences.get({ key: LEGACY_META_KEY });
    const legacyMeta = legacy.value ? JSON.parse(legacy.value) : null;
    return legacyMeta?.url === url ? { ...legacyMeta, path: LEGACY_KML_PATH } : null;
  } catch (error) {
    console.warn('No se pudo leer la metadata del KML cacheado', error);
    return null;
  }
};

const cacheMeta = async (url, meta) => {
  try {
    await Preferences.set({ key: metaKey(url), value: JSON.stringify(meta) });
  } catch (error) {
    console.warn('No se pudo guardar la metadata del KML', error);
  }
};

// KML válido: raíz <kml> y que el parser no reporte errores.
const isValidKml = (text) => {
  if (typeof text !== 'string' || !/<kml[\s>]/i.test(text)) return false;
  const dom = new DOMParser().parseFromString(text, 'text/xml');
  return dom.querySelector('parsererror') == null && dom.documentElement?.localName === 'kml';
};

// Escritura atómica: primero a un archivo temporal y luego rename. Un cierre a
// mitad de escritura deja el temporal corrupto pero el caché anterior intacto.
const writeAtomicText = async (path, text) => {
  const tmpPath = `${path}.tmp`;
  await Filesystem.writeFile({
    path: tmpPath,
    data: text,
    encoding: Encoding.UTF8,
    directory: Directory.Data,
    recursive: true,
  });
  await Filesystem.rename({
    from: tmpPath,
    to: path,
    directory: Directory.Data,
  });
};

// --- caché KML ---

export const getCachedKml = async (url) => {
  try {
    const meta = await getCachedMeta(url);
    if (meta?.url !== url) return null;
    const result = await Filesystem.readFile({
      path: meta.path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return typeof result.data === 'string' ? result.data : null;
  } catch {
    return null;
  }
};

// --- fetch condicional + cacheo ---
// Devuelve { text, fromCache } o null. `fromCache: true` indica que `text` es el
// contenido cacheado (no hace falta re-renderizar). Nunca pisa el caché con
// contenido inválido.

export const fetchAndCacheKml = async (url, { signal }) => {
  const cached = await getCachedKml(url);
  const meta = await getCachedMeta(url);
  const lastModified = meta?.url === url ? meta.lastModified : null;

  const doFetch = async (ifModifiedSince, retrying = false) => {
    const headers = ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : undefined;
    const response = await fetch(url, { signal, headers });

    if (response.status === 304) {
      // Sin cambios: usar caché. Si no existe o no se pudo leer, reintentar
      // sin If-Modified-Since para forzar una descarga completa.
      if (cached != null) return { text: cached, fromCache: true, unchanged: true };
      if (retrying) return null;
      return doFetch(null, true);
    }

    if (!response.ok) {
      // Error HTTP: no tocar el caché; devolver el contenido previo si existe.
      return cached != null ? { text: cached, fromCache: true } : null;
    }

    const text = await response.text();

    if (!isValidKml(text)) {
      // Respuesta no es un KML válido: no pisar el caché y tratarla como error
      // de red (se devuelve el caché previo, si existe).
      console.warn('KML descargado inválido; se conserva el caché anterior');
      return cached != null ? { text: cached, fromCache: true } : null;
    }

    const responseLastModified = response.headers.get('Last-Modified');
    const newMeta = {
      url,
      path: kmlPath(url),
      lastModified: responseLastModified ?? meta?.lastModified ?? null,
      size: text.length,
      hash: hashString(text),
      cachedAt: Date.now(),
    };

    // Fallback a tamaño/hash cuando no hay Last-Modified: si el contenido no
    // cambió, no hace falta reescribir el archivo.
    const unchangedBySizeHash =
      !responseLastModified &&
      meta?.path === newMeta.path &&
      meta?.size === newMeta.size &&
      meta?.hash === newMeta.hash;

    if (!unchangedBySizeHash) {
      await writeAtomicText(newMeta.path, text);
      await cacheMeta(url, newMeta);
    }

    return { text, fromCache: false };
  };

  try {
    return await doFetch(lastModified);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    // Error de red: devolver el caché si existe.
    return cached != null ? { text: cached, fromCache: true } : null;
  }
};

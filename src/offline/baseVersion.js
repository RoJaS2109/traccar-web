// Lógica pura del caché de `baseVersion` (la identidad del base en servicio que
// publica trak-mapas en GET /maps/version). Separada de baseVersionStore.js —que sí
// toca Preferences y la red— para poder testearla sin plugins nativos.

// Cuánto vale una consulta antes de volver a preguntar. Pasado el TTL el valor
// cacheado se sigue usando (incluso sin red): es la última verdad conocida.
export const BASE_VERSION_TTL_MS = 60 * 60 * 1000;

// El caché guarda contra qué servidor se obtuvo. Cambiar de servidor lo invalida:
// comparar contra la versión de otro servidor no significa nada.
export const isCacheFromServer = (cache, serverUrl) =>
  Boolean(cache && cache.value && serverUrl && cache.serverUrl === serverUrl);

// Versión vigente según el caché, o null si no sirve (otro servidor, vacío, corrupto).
export const resolveBaseVersion = ({ cache, serverUrl }) =>
  isCacheFromServer(cache, serverUrl) ? cache.value : null;

export const isBaseVersionStale = ({ cache, serverUrl, now, ttlMs = BASE_VERSION_TTL_MS }) => {
  if (!isCacheFromServer(cache, serverUrl)) return true;
  if (!Number.isFinite(cache.fetchedAt)) return true;
  return now - cache.fetchedAt > ttlMs;
};

// Solo se consulta al servidor si hay conexión confirmada (`online === true`). Con
// `false` o desconocido no se intenta: el llamador se queda con el último valor
// conocido y, si nunca hubo, con null (la UI degrada a la comparación por zoom).
export const shouldRefreshBaseVersion = ({
  cache,
  serverUrl,
  online,
  now,
  ttlMs = BASE_VERSION_TTL_MS,
}) => online === true && isBaseVersionStale({ cache, serverUrl, now, ttlMs });

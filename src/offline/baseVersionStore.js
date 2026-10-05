// Caché persistente de `baseVersion` (la identidad del base en servicio), guardado en
// Preferences junto a `serverUrl`. La UI lo compara con el `buildVersion` de cada zona
// descargada para marcar "Base anterior".
//
// El caché es lo que permite seguir detectando el desfasaje sin red: sin conexión se
// devuelve el último valor conocido. Solo se consulta al servidor si hay conexión
// confirmada y el valor venció (ver baseVersion.js, que es la parte pura y testeada).
import { Preferences } from '@capacitor/preferences';
import { getServerUrl } from './nativeBootstrap';
import { resolveBaseVersion, shouldRefreshBaseVersion } from './baseVersion';
import { fetchBaseVersion } from './mapDownloader';

const KEY = 'baseVersionCache';

const readCache = async () => {
  try {
    const { value } = await Preferences.get({ key: KEY });
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Valor ausente, corrupto o plugin no disponible (web): se trata como sin caché.
    return null;
  }
};

const writeCache = async (cache) => {
  try {
    await Preferences.set({ key: KEY, value: JSON.stringify(cache) });
  } catch {
    // Sin persistencia la comparación sigue funcionando en memoria durante la sesión.
  }
};

// Consulta el servidor y actualiza el caché. Propaga el error del servicio (la UI no
// lo muestra: la versión es información auxiliar, nunca bloquea nada).
export const refreshBaseVersion = async (serverUrl = getServerUrl()) => {
  const value = await fetchBaseVersion();
  if (value) await writeCache({ value, serverUrl, fetchedAt: Date.now() });
  return value;
};

// Versión vigente para el servidor configurado:
//  - si hay red y el caché venció (o es de otro servidor), se consulta;
//  - si la consulta falla, o no hay red, se devuelve el último valor conocido;
//  - null si nunca se pudo consultar contra este servidor.
export const getCurrentBaseVersion = async ({ online } = {}) => {
  const serverUrl = getServerUrl();
  const cache = await readCache();
  const now = Date.now();
  if (shouldRefreshBaseVersion({ cache, serverUrl, online, now })) {
    const refreshed = await refreshBaseVersion(serverUrl).catch(() => null);
    if (refreshed) return refreshed;
  }
  return resolveBaseVersion({ cache, serverUrl });
};

import { Preferences } from '@capacitor/preferences';

const KEY = 'lastPosition';

// Throttling: no escribir en Preferences en cada update de posición. Se guarda
// como mínimo cada MIN_INTERVAL_MS y solo si el dispositivo se movió más de
// MIN_DISTANCE_M desde el último guardado en memoria.
const MIN_INTERVAL_MS = 30_000;
const MIN_DISTANCE_M = 50;

let memory = null; // { lat, lng, at }

const distanceMeters = (a, b) => {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

export const saveLastPosition = async ({ lat, lng }) => {
  if (typeof lat !== 'number' || typeof lng !== 'number') return;
  try {
    const now = Date.now();
    if (
      memory &&
      now - memory.at < MIN_INTERVAL_MS &&
      distanceMeters(memory, { lat, lng }) < MIN_DISTANCE_M
    ) {
      return;
    }
    await Preferences.set({ key: KEY, value: JSON.stringify({ lat, lng, timestamp: now }) });
    memory = { lat, lng, at: now };
  } catch (error) {
    console.warn('No se pudo guardar la última posición', error);
  }
};

export const getLastPosition = async () => {
  try {
    const { value } = await Preferences.get({ key: KEY });
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.warn('No se pudo leer la última posición', error);
    return null;
  }
};

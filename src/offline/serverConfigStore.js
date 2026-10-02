import { Preferences } from '@capacitor/preferences';

const KEY = 'serverConfig';

export const cacheServerConfig = async (config) => {
  try {
    await Preferences.set({ key: KEY, value: JSON.stringify(config) });
  } catch (error) {
    console.warn('No se pudo cachear la config del servidor', error);
  }
};

export const getCachedServerConfig = async () => {
  try {
    const { value } = await Preferences.get({ key: KEY });
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.warn('No se pudo leer la config cacheada del servidor', error);
    return null;
  }
};

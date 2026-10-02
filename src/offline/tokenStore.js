import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { isNative } from './nativeBootstrap';

const TOKEN_KEY = 'sessionToken';

// POST /api/session/token devuelve el token como string JSON (con comillas dobles
// alrededor) porque el recurso es @Produces(APPLICATION_JSON). Este normalizador
// quita las comillas externas y valida el formato. Devuelve null si no es válido.
export const normalizeToken = (token) => {
  if (typeof token !== 'string') return null;
  let value = token.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
};

export const saveToken = async (token) => {
  if (!isNative() || !token) return;
  const normalized = normalizeToken(token);
  if (!normalized) {
    // Token inválido: no se guarda y no bloquea el login.
    console.warn('Token de sesión con formato inválido, no se guarda');
    return;
  }
  try {
    await SecureStorage.setItem(TOKEN_KEY, normalized);
  } catch (error) {
    // No bloquea el login: si el secure storage falla, se sigue sin token persistido.
    console.warn('No se pudo guardar el token de sesión', error);
  }
};

export const getToken = async () => {
  if (!isNative()) return null;
  try {
    // Normaliza también al leer para tolerar un token viejo guardado con comillas.
    return normalizeToken(await SecureStorage.getItem(TOKEN_KEY));
  } catch (error) {
    console.warn('No se pudo leer el token de sesión', error);
    return null;
  }
};

export const removeToken = async () => {
  if (!isNative()) return;
  try {
    await SecureStorage.removeItem(TOKEN_KEY);
  } catch (error) {
    console.warn('No se pudo borrar el token de sesión', error);
  }
};

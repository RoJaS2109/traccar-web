import { useSelector } from 'react-redux';

// Null-safe: en modo offline `server` o `user` pueden ser null o carecer de
// `attributes`. Sin estos guardas, la pantalla offline crashea al renderizar.
const containsProperty = (object, key) =>
  object != null && object.hasOwnProperty(key) && object[key] !== null;

export const usePreference = (key, defaultValue) =>
  useSelector((state) => {
    const { server, user } = state.session;
    if (server?.forceSettings) {
      if (containsProperty(server, key)) {
        return server[key];
      }
      if (containsProperty(user, key)) {
        return user[key];
      }
      return defaultValue;
    }
    if (containsProperty(user, key)) {
      return user[key];
    }
    if (containsProperty(server, key)) {
      return server[key];
    }
    return defaultValue;
  });

export const useAttributePreference = (key, defaultValue) =>
  useSelector((state) => {
    const { server, user } = state.session;
    const serverAttributes = server?.attributes;
    const userAttributes = user?.attributes;
    if (server?.forceSettings) {
      if (containsProperty(serverAttributes, key)) {
        return serverAttributes[key];
      }
      if (containsProperty(userAttributes, key)) {
        return userAttributes[key];
      }
      return defaultValue;
    }
    if (containsProperty(userAttributes, key)) {
      return userAttributes[key];
    }
    if (containsProperty(serverAttributes, key)) {
      return serverAttributes[key];
    }
    return defaultValue;
  });

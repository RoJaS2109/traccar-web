import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const DEFAULT_SERVER = 'https://mh.rudatrak.com';

let serverUrl = DEFAULT_SERVER;

export const isNative = () => Capacitor.isNativePlatform();

export const getServerUrl = () => serverUrl;

export const initNativeBootstrap = async () => {
  if (!isNative()) return;

  const { value } = await Preferences.get({ key: 'serverUrl' });
  if (value) serverUrl = value;

  const base = serverUrl.replace(/\/+$/, '');

  // Parchea fetch para resolver rutas relativas /api/... y /poi/... contra el servidor.
  // Solo interfiere con strings que empiezan con "/" o con Request cuya url lo haga.
  // Un URL object relativo no puede construirse sin base, así que no es un caso real.
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch(`${base}${input}`, init);
    }
    if (input instanceof Request && input.url.startsWith('/')) {
      return originalFetch(`${base}${input.url}`, input);
    }
    return originalFetch(input, init);
  };

  // Parchea WebSocket para apuntar al host del servidor. Se usa herencia de clase
  // para que onopen/onmessage/onerror y send() se hereden intactos.
  // SocketController arma `${protocol}//${window.location.host}/api/socket`; en nativo
  // location.host es "localhost", así que hay que reescribir el host además de la ruta.
  const serverHost = base.replace(/^https?:\/\//, '');
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      if (typeof url === 'string') {
        if (url.startsWith('/')) {
          url = `${base.replace(/^http/, 'ws')}${url}`;
        } else if (url.includes(window.location.host)) {
          url = url.replace(window.location.host, serverHost);
        }
      }
      super(url, protocols);
    }
  };
};

// API para que la UI de login/cambio de servidor pueda actualizar la URL.
export const setServerUrl = async (url) => {
  serverUrl = url;
  await Preferences.set({ key: 'serverUrl', value: url });
};

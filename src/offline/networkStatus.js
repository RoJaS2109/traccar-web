import { Network } from '@capacitor/network';
import { Capacitor } from '@capacitor/core';

// Detección de conectividad para el APK. navigator.onLine es inestable en el WebView
// de Android (provocó un render loop), así que se usa:
//   - Señal fuerte: networkStatusChange connected:false → offline inmediato.
//   - Señal fuerte: WebSocket abierto → online inmediato.
//   - Señal débil (socket cerrado, connected:true): se confirma con una sonda a
//     /api/server. Histéresis: 2 fallos → offline, 1 éxito → online (con debounce).
//   - Estando offline se sondea /api/server cada PROBE_INTERVAL_MS para detectar la vuelta.
// La sonda usa Promise.race con timer manual (no AbortSignal), que CapacitorHttp tolera
// mejor que un aborto.

const PROBE_TIMEOUT_MS = 5000;
const PROBE_INTERVAL_MS = 20000;
const OFFLINE_FAILURES = 2;
const ONLINE_DEBOUNCE_MS = 1500;

let online = true;
let consecutiveFailures = 0;
let initialized = false;
let probing = false;
let intervalId = null;
let probeTimerId = null;
let onlineTimerId = null;

const listeners = new Set();

const notify = () => {
  listeners.forEach((listener) => listener(online));
};

const stopInterval = () => {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
};

const startInterval = () => {
  if (intervalId === null) {
    intervalId = setInterval(runProbe, PROBE_INTERVAL_MS);
  }
};

const cancelPendingOnline = () => {
  if (onlineTimerId !== null) {
    clearTimeout(onlineTimerId);
    onlineTimerId = null;
  }
};

const setOnline = (value) => {
  if (!value) cancelPendingOnline();
  if (online === value) return;
  online = value;
  if (value) {
    stopInterval();
  } else {
    startInterval();
  }
  notify();
};

// Vuelta a online con debounce para evitar bucles/flicker con flapping de red.
const scheduleOnline = () => {
  if (onlineTimerId !== null) return;
  onlineTimerId = setTimeout(() => {
    onlineTimerId = null;
    setOnline(true);
  }, ONLINE_DEBOUNCE_MS);
};

const probeServer = () => {
  if (probing) return Promise.resolve(null);
  probing = true;
  const timeout = new Promise((resolve) => {
    probeTimerId = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  const request = fetch('/api/server')
    .then(() => true)
    .catch(() => false);
  return Promise.race([request, timeout]).finally(() => {
    clearTimeout(probeTimerId);
    probing = false;
  });
};

const applyProbeResult = (ok, { immediate = false } = {}) => {
  if (ok) {
    consecutiveFailures = 0;
    if (!online) {
      if (immediate) setOnline(true);
      else scheduleOnline();
    }
  } else {
    cancelPendingOnline();
    consecutiveFailures += 1;
    if (consecutiveFailures >= OFFLINE_FAILURES) {
      setOnline(false);
    }
  }
};

const runProbe = () => {
  probeServer().then((ok) => {
    if (ok !== null) applyProbeResult(ok);
  });
};

export const getOnline = () => online;

export const subscribe = (listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Botón "Reintentar": sonda inmediata; un éxito vuelve a online sin debounce.
export const checkNow = () =>
  probeServer().then((ok) => {
    if (ok !== null) applyProbeResult(ok, { immediate: true });
    return online;
  });

// Señal del WebSocket (SocketController): abierto → online seguro; cerrado → sonda.
export const reportSocketState = (connected) => {
  if (connected) {
    consecutiveFailures = 0;
    setOnline(true);
  } else {
    runProbe();
  }
};

// Conectividad nativa cruda (para que ServerProvider distinga offline de error real).
export const isNativeConnected = async () => {
  if (!Capacitor.isNativePlatform()) return true;
  try {
    const status = await Network.getStatus();
    return status.connected;
  } catch {
    return true;
  }
};

export const initNetworkStatus = async () => {
  if (initialized) return;
  initialized = true;

  if (!Capacitor.isNativePlatform()) {
    if (!navigator.onLine) setOnline(false);
    window.addEventListener('online', runProbe);
    window.addEventListener('offline', () => setOnline(false));
    return;
  }

  try {
    const status = await Network.getStatus();
    if (!status.connected) setOnline(false);
    await Network.addListener('networkStatusChange', (status) => {
      if (status.connected) runProbe();
      else setOnline(false);
    });
  } catch (error) {
    console.warn('No se pudo inicializar @capacitor/network', error);
  }
};

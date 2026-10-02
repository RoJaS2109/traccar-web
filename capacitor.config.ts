import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rudatrak.app',
  appName: 'RudaTrak',
  webDir: 'build',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // CapacitorHttp habilitado: el fetch/XHR del WebView evita CORS contra
    // mh.rudatrak.com (el servidor NO envía access-control-allow-origin, así
    // que el fetch nativo cross-origin fallaría). Los Web Workers de MapLibre
    // enrutan sus requests al hilo principal vía el Dispatcher, así que
    // también pasan por este interceptor y no hay choque con ellos.
    CapacitorHttp: { enabled: true },
  },
};

export default config;

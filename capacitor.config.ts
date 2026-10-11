import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rudatrak.app',
  appName: 'RudaTrak',
  webDir: 'build',
  // Sin esto, el APK debug (DEBUGGABLE) vuelca a logcat lo que devuelven los plugins: el token de sesión que lee
  // SecureStorage al arrancar y los KML de los POIs. Un APK release no es debuggable y ya no loguea; esto lo deja igual
  // en los dos.
  loggingBehavior: 'none',
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

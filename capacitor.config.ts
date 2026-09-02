import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rudatrak.app',
  appName: 'RudaTrak',
  webDir: 'build',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // Deshabilitado: el interceptor nativo de CapacitorHttp rompe los Web
    // Workers de MapLibre GL (error _capacitor_http_interceptor_ y loop de
    // reintentos hasta OOM). El servidor ya responde Access-Control-Allow-Origin: *
    // así que el fetch nativo del WebView pasa el CORS sin ayuda.
    CapacitorHttp: { enabled: false },
  },
};

export default config;

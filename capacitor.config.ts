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
    // mh.rudatrak.com. El choque con los Web Workers de MapLibre se resuelve
    // con maplibregl.setWorkerCount(0) en MapView.jsx (workers desactivados
    // en nativo), no deshabilitando el interceptor.
    CapacitorHttp: { enabled: true },
  },
};

export default config;

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rudatrak.app',
  appName: 'RudaTrak',
  webDir: 'build',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorHttp: { enabled: true },
  },
};

export default config;

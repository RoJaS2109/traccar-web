import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { CssBaseline, StyledEngineProvider } from '@mui/material';
import store from './store';
import { LocalizationProvider } from './common/components/LocalizationProvider';
import ErrorHandler from './common/components/ErrorHandler';
import Navigation from './Navigation';
import preloadImages from './map/core/preloadImages';
import NativeInterface from './common/components/NativeInterface';
import ServerProvider from './ServerProvider';
import ErrorBoundary from './ErrorBoundary';
import AppThemeProvider from './AppThemeProvider';
import { initNativeBootstrap } from './offline/nativeBootstrap';
import { registerOfflineProtocol } from './offline/offlineProtocol';
import { initNetworkStatus } from './offline/networkStatus';
import { cleanupOrphanParts, reconcileZones } from './offline/mapDownloader';

preloadImages();
registerOfflineProtocol();

initNativeBootstrap().then(() => {
  initNetworkStatus();
  // Descargas cortadas por cierre de la app dejan archivos .part huérfanos.
  cleanupOrphanParts().catch(() => {});
  // La tabla `zones` (lista de la pantalla) y los archivos de maps/ (render offline)
  // se arman por caminos distintos: al arrancar se los vuelve a alinear.
  reconcileZones().catch(() => {});
  const root = createRoot(document.getElementById('root'));
  root.render(
    <ErrorBoundary>
      <Provider store={store}>
        <LocalizationProvider>
          <StyledEngineProvider injectFirst>
            <AppThemeProvider>
              <CssBaseline enableColorScheme />
              <ServerProvider>
                <BrowserRouter>
                  <Navigation />
                </BrowserRouter>
                <ErrorHandler />
                <NativeInterface />
              </ServerProvider>
            </AppThemeProvider>
          </StyledEngineProvider>
        </LocalizationProvider>
      </Provider>
    </ErrorBoundary>,
  );
});

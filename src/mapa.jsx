import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { CssBaseline, StyledEngineProvider } from '@mui/material';
import store from './store';
import { LocalizationProvider } from './common/components/LocalizationProvider';
import ErrorHandler from './common/components/ErrorHandler';
import preloadImages from './map/core/preloadImages';
import ServerProvider from './ServerProvider';
import ErrorBoundary from './ErrorBoundary';
import AppThemeProvider from './AppThemeProvider';
import MapaApp from './MapaApp';

preloadImages();

const root = createRoot(document.getElementById('root'));
root.render(
  <ErrorBoundary>
    <Provider store={store}>
      <LocalizationProvider>
        <StyledEngineProvider injectFirst>
          <AppThemeProvider>
            <CssBaseline />
            <ServerProvider>
              <BrowserRouter>
                <MapaApp />
              </BrowserRouter>
              <ErrorHandler />
            </ServerProvider>
          </AppThemeProvider>
        </StyledEngineProvider>
      </LocalizationProvider>
    </Provider>
  </ErrorBoundary>,
);

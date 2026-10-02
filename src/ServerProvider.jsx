import { useState } from 'react';
import { Alert, IconButton } from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';
import { useDispatch, useSelector } from 'react-redux';
import { useAsyncTask } from './reactHelper';
import { sessionActions } from './store';
import Loader from './common/components/Loader';
import { useOnlineStatus } from './offline/useOnlineStatus';
import { isNativeConnected } from './offline/networkStatus';
import { cacheServerConfig, getCachedServerConfig } from './offline/serverConfigStore';

const ServerProvider = ({ children }) => {
  const dispatch = useDispatch();
  const online = useOnlineStatus();

  const server = useSelector((state) => state.session.server);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useAsyncTask(
    async ({ signal }) => {
      if (loaded) return;
      try {
        const response = await fetch('/api/server', { signal });
        if (response.ok) {
          const config = await response.json();
          dispatch(sessionActions.updateServer(config));
          cacheServerConfig(config);
          setLoaded(true);
          setError(null);
        } else {
          const message = await response.text();
          throw Error(message || response.statusText);
        }
      } catch (error) {
        // ¿Falta de red (arranque offline) o error real del servidor?
        // online: estado con histéresis; isNativeConnected: conectividad nativa cruda
        // (cubre el arranque en frío antes de que online se confirme offline).
        const nativeDown = !(await isNativeConnected());
        if (nativeDown || !online) {
          const cached = await getCachedServerConfig();
          dispatch(sessionActions.updateServer(cached || { attributes: {} }));
          setError(null);
        } else {
          setError(error.message);
        }
      }
    },
    [loaded, online, dispatch],
  );

  if (error) {
    return (
      <Alert
        severity="error"
        action={
          <IconButton color="inherit" size="small" onClick={() => setError(null)}>
            <ReplayIcon fontSize="inherit" />
          </IconButton>
        }
      >
        {error}
      </Alert>
    );
  }
  if (!server) {
    return <Loader />;
  }
  return children;
};

export default ServerProvider;

import { useState } from 'react';
import { Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { useMediaQuery, useTheme } from '@mui/material';
import { makeStyles } from 'tss-react/mui';
import BottomMenu from './common/components/BottomMenu';
import SocketController from './SocketController';
import CachingController from './CachingController';
import { useCatch, useAsyncTask } from './reactHelper';
import { sessionActions } from './store';
import UpdateController from './UpdateController';
import MotionController from './main/MotionController';
import TermsDialog from './common/components/TermsDialog';
import Loader from './common/components/Loader';
import fetchOrThrow from './common/util/fetchOrThrow';
import { isNative, setSessionToken } from './offline/nativeBootstrap';
import { getToken, removeToken } from './offline/tokenStore';
import { useOnlineStatus } from './offline/useOnlineStatus';
import OfflineScreen from './offline/OfflineScreen';

const useStyles = makeStyles()(() => ({
  page: {
    flexGrow: 1,
    overflow: 'auto',
  },
  menu: {
    zIndex: 4,
    '@media print': {
      display: 'none',
    },
  },
}));

const App = () => {
  const { classes } = useStyles();
  const theme = useTheme();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const desktop = useMediaQuery(theme.breakpoints.up('md'));

  const newServer = useSelector((state) => state.session.server.newServer);
  const termsUrl = useSelector((state) => state.session.server.attributes.termsUrl);
  const user = useSelector((state) => state.session.user);

  const online = useOnlineStatus();

  // null = aún no se leyó SecureStorage; true/false = hay/no hay token guardado.
  const [hasToken, setHasToken] = useState(null);

  const acceptTerms = useCatch(async () => {
    const response = await fetchOrThrow(`/api/users/${user.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...user, attributes: { ...user.attributes, termsAccepted: true } }),
    });
    dispatch(sessionActions.updateUser(await response.json()));
  });

  useAsyncTask(
    async ({ signal }) => {
      if (user) return null;

      if (isNative()) {
        const token = await getToken();
        if (token) {
          setHasToken(true);
          setSessionToken(token);
          let tokenResponse;
          try {
            tokenResponse = await fetch(`/api/session?token=${encodeURIComponent(token)}`, {
              signal,
            });
          } catch {
            // Sin red: conservar el token. La rama de render muestra la pantalla
            // offline cuando online=false y hay token guardado.
            return null;
          }
          if (tokenResponse.ok) {
            dispatch(sessionActions.updateUser(await tokenResponse.json()));
            return null;
          }
          if (tokenResponse.status === 401) {
            setSessionToken(null);
            await removeToken();
            setHasToken(false);
            window.sessionStorage.setItem(
              'postLogin',
              window.location.pathname + window.location.search,
            );
            navigate('/login', { replace: true });
          }
          return null;
        }
        setHasToken(false);
        if (!online) {
          // Sin red y sin token: la rama de render navega a /login con el mensaje.
          return null;
        }
      }

      const response = await fetch('/api/session', { signal });
      if (response.ok) {
        dispatch(sessionActions.updateUser(await response.json()));
      } else {
        window.sessionStorage.setItem(
          'postLogin',
          window.location.pathname + window.location.search,
        );
        navigate(newServer ? '/register' : '/login', { replace: true });
      }
      return null;
    },
    [user, dispatch, navigate, newServer, online],
  );

  if (user == null) {
    if (isNative() && !online && hasToken !== null) {
      if (hasToken) {
        return <OfflineScreen />;
      }
      return <Navigate to="/login" replace />;
    }
    return <Loader />;
  }

  if (termsUrl && !user.attributes.termsAccepted) {
    return <TermsDialog open onCancel={() => navigate('/login')} onAccept={() => acceptTerms()} />;
  }

  return (
    <>
      <SocketController />
      <CachingController />
      <UpdateController />
      <MotionController />
      <div className={classes.page}>
        <Outlet />
      </div>
      {!desktop && (
        <div className={classes.menu}>
          <BottomMenu />
        </div>
      )}
    </>
  );
};

export default App;

import { lazy, Suspense } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { makeStyles } from 'tss-react/mui';
import SocketController from './SocketController';
import CachingController from './CachingController';
import { useCatch, useAsyncTask } from './reactHelper';
import { sessionActions, devicesActions } from './store';
import UpdateController from './UpdateController';
import MotionController from './main/MotionController';
import TermsDialog from './common/components/TermsDialog';
import Loader from './common/components/Loader';
import fetchOrThrow from './common/util/fetchOrThrow';
import { useNavigate } from 'react-router-dom';
import StatusCard from './common/components/StatusCard';

const MainMap = lazy(() => import('./main/MainMap'));

const useStyles = makeStyles()(() => ({
  root: {
    height: '100%',
    width: '100%',
  },
}));

const MapaApp = () => {
  const { classes } = useStyles();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const newServer = useSelector((state) => state.session.server.newServer);
  const termsUrl = useSelector((state) => state.session.server.attributes.termsUrl);
  const user = useSelector((state) => state.session.user);

  const positions = useSelector((state) => state.session.positions);
  const selectedDeviceId = useSelector((state) => state.devices.selectedId);

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
      if (!user) {
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
      }
      return null;
    },
    [user, dispatch, navigate, newServer],
  );

  if (user == null) {
    return <Loader />;
  }
  if (termsUrl && !user.attributes.termsAccepted) {
    return <TermsDialog open onCancel={() => navigate('/login')} onAccept={() => acceptTerms()} />;
  }

  const positionValues = Object.values(positions);
  const selectedPosition = positionValues.find(
    (position) => selectedDeviceId && position.deviceId === selectedDeviceId,
  );

  return (
    <>
      <SocketController />
      <CachingController />
      <UpdateController />
      <MotionController />
      <div className={classes.root}>
        <Suspense fallback={null}>
          <MainMap
            filteredPositions={positionValues}
            selectedPosition={selectedPosition}
            onEventsClick={() => {}}
          />
        </Suspense>
      </div>
      {selectedDeviceId && (
        <StatusCard
          deviceId={selectedDeviceId}
          position={selectedPosition}
          onClose={() => dispatch(devicesActions.selectId(null))}
          desktopPadding={0}
        />
      )}
    </>
  );
};

export default MapaApp;

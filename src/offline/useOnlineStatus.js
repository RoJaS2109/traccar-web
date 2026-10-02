import { useSyncExternalStore } from 'react';
import { getOnline, subscribe } from './networkStatus';

export const useOnlineStatus = () => useSyncExternalStore(subscribe, getOnline);

export default useOnlineStatus;

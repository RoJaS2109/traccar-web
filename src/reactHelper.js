import { useRef, useEffect, useCallback, useState } from 'react';
import { useDispatch } from 'react-redux';
import { errorsActions } from './store';
import { getOnline } from './offline/networkStatus';

export const pageSize = 50;

// Error de red a nivel de fetch (p. ej. "Failed to fetch" del navegador o de
// CapacitorHttp). Cuando la pantalla offline ya cubre la pérdida de red, no
// tiene sentido mostrar el snackbar por cada fetch fallido.
const isNetworkError = (error) =>
  error?.name === 'TypeError' ||
  /failed to fetch|fetch failed|network error|network request failed|offline|no internet|connection/i.test(
    error?.message || '',
  );

const isOfflineNetworkError = (error) => getOnline() === false && isNetworkError(error);

export const usePrevious = (value) => {
  const ref = useRef();
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
};

export const useAsyncTask = (effect, deps) => {
  const dispatch = useDispatch();
  useEffect(() => {
    const controller = new AbortController();
    let cleanup;
    effect({ signal: controller.signal })
      .then((result) => {
        cleanup = result;
      })
      .catch((error) => {
        if (error.name !== 'AbortError' && !isOfflineNetworkError(error)) {
          dispatch(errorsActions.push(error.message));
        }
      });
    return () => {
      controller.abort();
      cleanup?.();
    };
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [...deps, dispatch]);
};

export const useCatch = (method) => {
  const dispatch = useDispatch();
  return (...parameters) => {
    method(...parameters).catch((error) => {
      if (!isOfflineNetworkError(error)) {
        dispatch(errorsActions.push(error.message));
      }
    });
  };
};

export const useCatchCallback = (method, deps) => {
  const dispatch = useDispatch();
  return useCallback(
    (...parameters) => {
      method(...parameters).catch((error) => {
        if (!isOfflineNetworkError(error)) {
          dispatch(errorsActions.push(error.message));
        }
      });
    },
    // eslint-disable-next-line @eslint-react/exhaustive-deps
    deps,
  );
};

export const useScrollToLoad = (loadMore) => {
  const [sentinel, setSentinel] = useState(null);
  const loadingRef = useRef(false);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  useEffect(() => {
    if (!sentinel) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !loadingRef.current) {
        loadingRef.current = true;
        Promise.resolve(loadMoreRef.current?.()).finally(() => {
          loadingRef.current = false;
        });
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel]);

  return setSentinel;
};

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from '../common/components/LocalizationProvider';
import { map } from '../map/core/MapView';
import { estimateZone, downloadZone } from './mapDownloader';

const MIN_ZOOM = 0;
const MAX_ZOOM = 14;
const WIFI_WARNING_BYTES = 50 * 1024 * 1024;

const SOURCE_ID = 'download-zone-preview';
const FILL_ID = 'download-zone-fill';
const LINE_ID = 'download-zone-line';

const bboxOfMap = () => {
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
};

const bboxSummary = (bbox) => {
  const [west, south, east, north] = bbox;
  const c = (value) => value.toFixed(2);
  return `lat ${c(south)}…${c(north)} · lng ${c(west)}…${c(east)}`;
};

const formatBytes = (bytes) => {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const bboxToFeature = ([west, south, east, north]) => ({
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  },
});

const showPreview = (bbox) => {
  try {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } },
      });
      map.addLayer({
        id: FILL_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: { 'fill-color': '#1976d2', 'fill-opacity': 0.15 },
      });
      map.addLayer({
        id: LINE_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: { 'line-color': '#1976d2', 'line-width': 2 },
      });
    }
    map.getSource(SOURCE_ID)?.setData(bboxToFeature(bbox));
  } catch {
    // Mapa no listo o estilo sin cargar: se omite el rectángulo, el diálogo sigue.
  }
};

const hidePreview = () => {
  try {
    if (map.getLayer(FILL_ID)) map.removeLayer(FILL_ID);
    if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  } catch {
    // Ya removido o mapa no disponible.
  }
};

const errorMessage = (t, error) => {
  switch (error?.code) {
    case 'noToken':
    case 'unauthorized':
      return t('offlineMapsSessionRequired');
    case 'tooLarge':
      return t('offlineMapsTooLarge');
    case 'busy':
      return t('offlineMapsBusy');
    case 'rateLimited':
      return t('offlineMapsRateLimited');
    case 'network':
      return t('offlineMapsNetworkLost');
    case 'noSpace':
      return t('offlineMapsNoSpace');
    default:
      return t('offlineMapsJobFailed');
  }
};

const NewZoneDialog = ({ open, onClose, onDone }) => {
  const t = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [bbox, setBbox] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [stage, setStage] = useState('idle'); // idle | extracting | downloading
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  // Cancellation por descarga: cada descarga crea su propia bandera para que una
  // descarga nueva no "descancele" una vieja que sigue escribiendo su .part.
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    cancelRef.current = null;
    setStage('idle');
    setError(null);
    setProgress(null);
    setEstimate(null);
    setBbox(bboxOfMap());
    setName(`Zona ${new Date().toLocaleDateString()}`);
    showPreview(bboxOfMap());
    return () => hidePreview();
  }, [open]);

  const busy = estimating || stage === 'extracting' || stage === 'downloading';

  // 401 = token expirado/revocado: el downloader ya limpió el token, redirigir a login.
  const handleError = (err) => {
    if (err.code === 'unauthorized') {
      navigate('/login');
      return;
    }
    setError(errorMessage(t, err));
  };

  const handleEstimate = async () => {
    setError(null);
    setEstimate(null);
    setEstimating(true);
    try {
      const [minLng, minLat, maxLng, maxLat] = bbox;
      const result = await estimateZone({
        minLng,
        minLat,
        maxLng,
        maxLat,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
      });
      setEstimate(result);
    } catch (err) {
      handleError(err);
    } finally {
      setEstimating(false);
    }
  };

  const handleDownload = async () => {
    setError(null);
    setProgress(null);
    const cancel = { cancelled: false };
    cancelRef.current = cancel;
    try {
      await downloadZone({
        name: name.trim() || 'Zona',
        bbox,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        onStage: setStage,
        onProgress: setProgress,
        isCancelled: () => cancel.cancelled,
      });
      onDone?.();
    } catch (err) {
      setStage('idle');
      if (err.code === 'cancelled') setError(t('offlineMapsCancelled'));
      else handleError(err);
    }
  };

  const handleCancel = () => {
    if (cancelRef.current) cancelRef.current.cancelled = true;
    setStage('idle');
    setError(t('offlineMapsCancelled'));
  };

  const tooLarge =
    estimate != null && estimate.maxBytes != null && estimate.bytes > estimate.maxBytes;
  const warnWifi = estimate != null && estimate.bytes >= WIFI_WARNING_BYTES;

  const progressValue =
    progress?.lengthComputable && progress.contentLength > 0
      ? Math.min(100, (progress.bytes / progress.contentLength) * 100)
      : undefined;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t('offlineMapsNew')}</DialogTitle>
      <DialogContent>
        <TextField
          label={t('offlineMapsName')}
          fullWidth
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          sx={{ mb: 2 }}
        />
        {bbox && (
          <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
            {bboxSummary(bbox)}
          </Typography>
        )}
        {estimate && !tooLarge && (
          <Typography variant="body1" sx={{ mb: 1 }}>
            {t('offlineMapsEstimated')}: {formatBytes(estimate.bytes)}
          </Typography>
        )}
        {warnWifi && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            {t('offlineMapsWifiWarning')}
          </Alert>
        )}
        {tooLarge && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {t('offlineMapsTooLarge')}
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        {stage === 'extracting' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 1 }}>
            <CircularProgress size={20} />
            <Typography variant="body2">{t('offlineMapsPreparing')}</Typography>
          </Box>
        )}
        {stage === 'downloading' && (
          <Box sx={{ my: 1 }}>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t('offlineMapsDownloading')}
            </Typography>
            <LinearProgress
              variant={progressValue != null ? 'determinate' : 'indeterminate'}
              value={progressValue}
            />
            <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mt: 0.5 }}>
              {t('offlineMapsKeepOpen')}
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={busy ? handleCancel : onClose}>{t('offlineMapsCancel')}</Button>
        {!estimate ? (
          <Button onClick={handleEstimate} disabled={estimating} variant="contained">
            {t('offlineMapsEstimate')}
          </Button>
        ) : (
          <Button onClick={handleDownload} disabled={busy || tooLarge} variant="contained">
            {t('offlineMapsDownload')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default NewZoneDialog;

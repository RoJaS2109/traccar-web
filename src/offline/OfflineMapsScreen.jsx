import { useEffect, useState } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Snackbar,
  Toolbar,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from '../common/components/LocalizationProvider';
import { formatTime } from '../common/util/formatter';
import { useOnlineStatus } from './useOnlineStatus';
import { listZones, deleteZone } from './mapDownloader';
import { getCurrentBaseVersion } from './baseVersionStore';
import NewZoneDialog from './NewZoneDialog';
import { OUTDATED_LABEL_KEY, outdatedReason } from './offlineOutdated';

const formatBytes = (bytes) => {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const bboxSummary = (bbox) => {
  const [west, south, east, north] = bbox;
  const c = (value) => value.toFixed(2);
  return `lat ${c(south)}…${c(north)} · lng ${c(west)}…${c(east)}`;
};

const OfflineMapsScreen = ({ open, onClose }) => {
  const t = useTranslation();
  const online = useOnlineStatus();

  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newZoneOpen, setNewZoneOpen] = useState(false);
  // Zona que se está reemplazando (null = descarga de una zona nueva).
  const [redownloadTarget, setRedownloadTarget] = useState(null);
  const [notice, setNotice] = useState(null);
  // Última versión conocida del base en servicio (null si nunca se pudo consultar).
  const [baseVersion, setBaseVersion] = useState(null);

  const refresh = async () => {
    try {
      setZones(await listZones());
    } catch {
      setZones([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    refresh();
    getCurrentBaseVersion({ online })
      .then(setBaseVersion)
      .catch(() => setBaseVersion(null));
  }, [open, online]);

  const handleDelete = async (zone) => {
    if (window.confirm(t('offlineMapsDeleteConfirm'))) {
      await deleteZone(zone.id).catch(() => {});
      await refresh();
    }
  };

  // Re-descarga una zona desactualizada: abre el diálogo precargado con su bbox. NO se
  // borra nada acá: el reemplazo es atómico (mapDownloader.replaceZone baja y valida la
  // nueva primero y recién entonces borra la vieja). Cancelar no destruye nada.
  const handleRedownload = (zone) => {
    if (!window.confirm(t('offlineMapsRedownloadConfirm'))) return;
    setRedownloadTarget(zone);
    setNewZoneOpen(true);
  };

  const closeNewZone = () => {
    setNewZoneOpen(false);
    setRedownloadTarget(null);
  };

  const handleNewZoneDone = (result) => {
    const reemplazaba = redownloadTarget != null;
    closeNewZone();
    refresh();
    if (!reemplazaba) setNotice(t('offlineMapsDone'));
    else if (result?.oldDeleted === false) setNotice(t('offlineMapsReplaceOrphan'));
    else setNotice(t('offlineMapsReplaced'));
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <AppBar position="static" color="primary" elevation={2}>
        <Toolbar variant="dense">
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" noWrap>
              {t('offlineMapsTitle')}
            </Typography>
          </Box>
          <IconButton
            color="inherit"
            edge="end"
            onClick={onClose}
            aria-label={t('offlineMapsCancel')}
          >
            <CloseIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Box sx={{ flexGrow: 1, overflowY: 'auto', p: 2 }}>
        {!online && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {t('offlineMapsOfflineNotice')}
          </Alert>
        )}
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : zones.length === 0 ? (
          <Typography color="textSecondary" sx={{ textAlign: 'center', p: 4 }}>
            {t('offlineMapsEmpty')}
          </Typography>
        ) : (
          <List>
            {zones.map((zone) => {
              const reason = outdatedReason(zone, baseVersion);
              return (
                <ListItem
                  key={zone.id}
                  divider
                  secondaryAction={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      {reason && (
                        <IconButton
                          edge="end"
                          aria-label={t('offlineMapsRedownload')}
                          title={t('offlineMapsRedownload')}
                          onClick={() => handleRedownload(zone)}
                        >
                          <RefreshIcon />
                        </IconButton>
                      )}
                      <IconButton
                        edge="end"
                        aria-label={t('offlineMapsDelete')}
                        onClick={() => handleDelete(zone)}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Box>
                  }
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <span>{zone.name}</span>
                        {reason && (
                          <Chip
                            size="small"
                            // 'unknown' no es una certeza (puede estar perfectamente al
                            // día), así que no se pinta como advertencia.
                            color={reason === 'unknown' ? 'default' : 'warning'}
                            label={t(OUTDATED_LABEL_KEY[reason])}
                          />
                        )}
                      </Box>
                    }
                    secondary={`${formatBytes(zone.sizeBytes)} · ${bboxSummary(zone.bbox)} · ${formatTime(
                      zone.createdAt,
                      'date',
                    )}`}
                  />
                </ListItem>
              );
            })}
          </List>
        )}
      </Box>

      {online && (
        <Box sx={{ p: 2 }}>
          <Button
            variant="contained"
            fullWidth
            startIcon={<AddIcon />}
            onClick={() => {
              setRedownloadTarget(null);
              setNewZoneOpen(true);
            }}
          >
            {t('offlineMapsNew')}
          </Button>
        </Box>
      )}

      <NewZoneDialog
        open={newZoneOpen}
        onClose={closeNewZone}
        onDone={handleNewZoneDone}
        initialBbox={redownloadTarget?.bbox ?? null}
        replacesZoneId={redownloadTarget?.id ?? null}
      />

      <Snackbar
        open={notice != null}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        message={notice}
      />
    </Dialog>
  );
};

export default OfflineMapsScreen;

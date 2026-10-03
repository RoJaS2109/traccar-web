import { useEffect, useState } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Toolbar,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import { useTranslation } from '../common/components/LocalizationProvider';
import { formatTime } from '../common/util/formatter';
import { useOnlineStatus } from './useOnlineStatus';
import { listZones, deleteZone } from './mapDownloader';
import NewZoneDialog from './NewZoneDialog';

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
    if (open) refresh();
  }, [open]);

  const handleDelete = async (zone) => {
    if (window.confirm(t('offlineMapsDeleteConfirm'))) {
      await deleteZone(zone.id).catch(() => {});
      await refresh();
    }
  };

  const handleNewZoneDone = () => {
    setNewZoneOpen(false);
    refresh();
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
            {zones.map((zone) => (
              <ListItem
                key={zone.id}
                divider
                secondaryAction={
                  <IconButton
                    edge="end"
                    aria-label={t('offlineMapsDelete')}
                    onClick={() => handleDelete(zone)}
                  >
                    <DeleteIcon />
                  </IconButton>
                }
              >
                <ListItemText
                  primary={zone.name}
                  secondary={`${formatBytes(zone.sizeBytes)} · ${bboxSummary(zone.bbox)} · ${formatTime(
                    zone.createdAt,
                    'date',
                  )}`}
                />
              </ListItem>
            ))}
          </List>
        )}
      </Box>

      {online && (
        <Box sx={{ p: 2 }}>
          <Button
            variant="contained"
            fullWidth
            startIcon={<AddIcon />}
            onClick={() => setNewZoneOpen(true)}
          >
            {t('offlineMapsNew')}
          </Button>
        </Box>
      )}

      <NewZoneDialog
        open={newZoneOpen}
        onClose={() => setNewZoneOpen(false)}
        onDone={handleNewZoneDone}
      />
    </Dialog>
  );
};

export default OfflineMapsScreen;

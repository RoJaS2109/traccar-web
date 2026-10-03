import { useState } from 'react';
import { AppBar, Box, Button, IconButton, Toolbar, Typography } from '@mui/material';
import MapIcon from '@mui/icons-material/Map';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import MapView from '../map/core/MapView';
import MapCurrentLocation from '../map/MapCurrentLocation';
import PoiMap from '../map/main/PoiMap';
import OfflineCamera from './OfflineCamera';
import OfflineMapsScreen from './OfflineMapsScreen';
import { useTranslation } from '../common/components/LocalizationProvider';
import { checkNow } from './networkStatus';

const OfflineScreen = () => {
  const t = useTranslation();
  const [mapsOpen, setMapsOpen] = useState(false);

  const handleRetry = async () => {
    await checkNow();
  };

  return (
    <Box sx={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static" color="warning" elevation={2}>
        <Toolbar variant="dense">
          <WifiOffIcon sx={{ mr: 1 }} />
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" noWrap>
              {t('offlineTitle')}
            </Typography>
            <Typography variant="body2" noWrap>
              {t('offlineDescription')}
            </Typography>
          </Box>
          <IconButton
            color="inherit"
            onClick={() => setMapsOpen(true)}
            aria-label={t('offlineMapsTitle')}
          >
            <MapIcon />
          </IconButton>
          <Button color="inherit" variant="outlined" onClick={handleRetry} sx={{ ml: 1 }}>
            {t('offlineRetry')}
          </Button>
        </Toolbar>
      </AppBar>
      <Box sx={{ flexGrow: 1, position: 'relative' }}>
        <MapView offline>
          <OfflineCamera />
          <MapCurrentLocation />
          <PoiMap />
        </MapView>
      </Box>
      <OfflineMapsScreen open={mapsOpen} onClose={() => setMapsOpen(false)} />
    </Box>
  );
};

export default OfflineScreen;

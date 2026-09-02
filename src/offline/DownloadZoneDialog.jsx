import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import { downloadZone } from './OfflineManager';
import { tileCount } from './tileMath';
import { map } from '../map/core/MapView';

const LAYERS = [
  { id: 'capabaseargenmap', label: 'Argenmap' },
  { id: 'mapabase_topo', label: 'Topográfico' },
];

export const DownloadZoneDialog = ({ open, onClose }) => {
  const [layer, setLayer] = useState('capabaseargenmap');
  const [maxZoom, setMaxZoom] = useState(14);
  const [progress, setProgress] = useState(null);

  const bbox = () => {
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  };

  const estimate = () => tileCount(bbox(), 5, maxZoom);

  const start = async () => {
    const [minLng, minLat, maxLng, maxLat] = bbox();
    const id = `${layer}-${Date.now()}`;
    setProgress({ done: 0, total: estimate() });
    await downloadZone({
      id,
      name: `${layer} ${new Date().toLocaleDateString()}`,
      layer,
      bbox: [minLng, minLat, maxLng, maxLat],
      minZoom: 5,
      maxZoom,
      onProgress: (done, total) => setProgress({ done, total }),
    });
    setProgress(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Descargar zona</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Se descargará el área visible del mapa (mínimo zoom 5). Tiles estimados:{' '}
          {estimate().toLocaleString()}
        </Typography>
        <FormControl fullWidth sx={{ mb: 2 }}>
          <InputLabel>Capa</InputLabel>
          <Select value={layer} onChange={(e) => setLayer(e.target.value)} label="Capa">
            {LAYERS.map((l) => (
              <MenuItem key={l.id} value={l.id}>
                {l.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel>Zoom máximo</InputLabel>
          <Select value={maxZoom} onChange={(e) => setMaxZoom(e.target.value)} label="Zoom máximo">
            {[11, 12, 13, 14, 15, 16].map((z) => (
              <MenuItem key={z} value={z}>
                {z}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {progress && (
          <LinearProgress
            variant="determinate"
            value={(progress.done / progress.total) * 100}
            sx={{ mt: 2 }}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={!!progress}>
          Cancelar
        </Button>
        <Button onClick={start} disabled={!!progress} variant="contained">
          Descargar
        </Button>
      </DialogActions>
    </Dialog>
  );
};

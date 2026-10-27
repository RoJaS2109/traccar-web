import { useEffect, useState } from 'react';
import { useTheme, Menu, MenuItem, ListItemText, ListSubheader, Checkbox } from '@mui/material';
import { makeStyles } from 'tss-react/mui';
import { createRoot } from 'react-dom/client';
import PlaceIcon from '@mui/icons-material/Place';
import { map } from '../core/MapView';
import { useTranslation } from '../../common/components/LocalizationProvider';
import usePoiLayers from '../main/usePoiLayers';

const useStyles = makeStyles()(() => ({
  button: {
    '&&': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#333',
    },
  },
}));

// Botón del mapa para elegir qué KML de POIs se muestran. Solo aparece con más de uno.
const MapPoiSelector = () => {
  const theme = useTheme();
  const t = useTranslation();
  const { classes } = useStyles();
  const [anchorEl, setAnchorEl] = useState(null);

  const { layers, hidden, setHidden } = usePoiLayers();
  const visible = layers.length > 1;

  useEffect(() => {
    if (!visible) return undefined;
    let element;
    let iconRoot;
    const control = {
      onAdd: () => {
        element = document.createElement('div');
        element.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const button = document.createElement('button');
        button.type = 'button';
        button.title = t('mapPoiLayer');
        button.className = `maplibregl-ctrl-icon ${classes.button}`;
        button.onclick = () => setAnchorEl(button);
        element.appendChild(button);
        iconRoot = createRoot(button);
        iconRoot.render(<PlaceIcon fontSize="small" />);
        return element;
      },
      onRemove: () => {
        queueMicrotask(() => iconRoot.unmount());
        element.remove();
      },
    };
    map.addControl(control, theme.direction === 'rtl' ? 'top-left' : 'top-right');
    return () => map.removeControl(control);
  }, [visible, theme.direction, classes.button, t]);

  const toggle = (url) =>
    setHidden((previous) =>
      previous.includes(url) ? previous.filter((value) => value !== url) : [...previous, url],
    );

  return (
    <Menu
      anchorEl={anchorEl}
      open={visible && Boolean(anchorEl)}
      onClose={() => setAnchorEl(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      <ListSubheader>{t('mapPoiLayer')}</ListSubheader>
      {layers.map((layer) => (
        <MenuItem key={layer.url} onClick={() => toggle(layer.url)}>
          <Checkbox edge="start" size="small" checked={!hidden.includes(layer.url)} />
          <ListItemText>{layer.name}</ListItemText>
        </MenuItem>
      ))}
    </Menu>
  );
};

export default MapPoiSelector;

import { useEffect, useRef } from 'react';
import { useTheme } from '@mui/material';
import { makeStyles } from 'tss-react/mui';
import { createRoot } from 'react-dom/client';
import ExploreIcon from '@mui/icons-material/Explore';
import NavigationIcon from '@mui/icons-material/Navigation';
import { map } from '../core/MapView';

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

// Ícono del modo: flecha de rumbo cuando el mapa gira con el sentido de marcha, brújula
// cuando queda fijo al norte.
const icon = (headingUp) =>
  headingUp ? <NavigationIcon fontSize="small" /> : <ExploreIcon fontSize="small" />;

// Botón para alternar entre "rumbo arriba" y "norte arriba". Sigue el patrón de
// MapNotification: el control lo dibuja maplibre y React renderiza el ícono dentro del
// botón. Solo tiene sentido durante la navegación, así que se oculta cuando no se navega.
const MapHeadingMode = ({ visible, headingUp, onToggle }) => {
  const theme = useTheme();
  const { classes } = useStyles();

  // Los refs se reasignan en cada render: el control lo crea maplibre una sola vez y debe
  // ver siempre el valor vigente sin necesidad de recrearse.
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  const headingUpRef = useRef(headingUp);
  headingUpRef.current = headingUp;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const containerRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    const control = {
      onAdd: () => {
        const container = document.createElement('div');
        container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        container.style.display = visibleRef.current ? '' : 'none';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `maplibregl-ctrl-icon ${classes.button}`;
        button.onclick = () => onToggleRef.current();
        container.appendChild(button);
        const root = createRoot(button);
        // El ícono y la visibilidad se leen de los refs: si este efecto se reejecuta (por
        // un cambio de dirección del tema) el botón nuevo no debe quedar sin ícono ni
        // visible fuera de la navegación esperando un cambio de estado que no va a venir.
        root.render(icon(headingUpRef.current));
        rootRef.current = root;
        containerRef.current = container;
        return container;
      },
      onRemove: () => {
        const root = rootRef.current;
        rootRef.current = null;
        // El unmount se difiere fuera del render de maplibre, que no es el de React.
        queueMicrotask(() => root?.unmount());
        containerRef.current?.remove();
        containerRef.current = null;
      },
    };
    map.addControl(control, theme.direction === 'rtl' ? 'top-left' : 'top-right');
    return () => map.removeControl(control);
  }, [theme.direction, classes.button]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.style.display = visible ? '' : 'none';
    }
  }, [visible]);

  useEffect(() => {
    rootRef.current?.render(icon(headingUp));
  }, [headingUp]);

  return null;
};

export default MapHeadingMode;

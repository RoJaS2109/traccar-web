import { grey } from '@mui/material/colors';

const validatedColor = (color) => (/^#([0-9A-Fa-f]{3}){1,2}$/.test(color) ? color : null);

// Paleta del sitio web de RudaTrak: asfalto y naranja de ruta.
const asfalto = '#202428';
const asfalto2 = '#2b3035';
const ruta = '#e2792b';
const rutaClara = '#f08a3c';
const banquina = '#f2f3f2';
const tinta = '#23272b';

export default (server, darkMode) => {
  const serverPrimary = validatedColor(server?.attributes?.colorPrimary);
  const serverSecondary = validatedColor(server?.attributes?.colorSecondary);
  return {
    mode: darkMode ? 'dark' : 'light',
    background: {
      default: darkMode ? asfalto : banquina,
      paper: darkMode ? asfalto2 : '#ffffff',
    },
    text: darkMode
      ? { primary: '#e7eaec', secondary: '#b9c0c5' }
      : { primary: tinta, secondary: '#565d64' },
    // Sobre el naranja el sitio usa texto oscuro; con un color del servidor, MUI calcula el contraste.
    primary: serverPrimary
      ? { main: serverPrimary }
      : { main: darkMode ? rutaClara : ruta, contrastText: '#1a1d20' },
    secondary: serverSecondary
      ? { main: serverSecondary }
      : { main: darkMode ? '#e7eaec' : asfalto },
    neutral: {
      main: grey[500],
    },
    geometry: {
      main: '#3bb2d0',
    },
    alwaysDark: {
      main: asfalto,
    },
  };
};

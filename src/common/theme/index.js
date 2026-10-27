import { useMemo } from 'react';
import { createTheme } from '@mui/material/styles';
import palette from './palette';
import dimensions from './dimensions';
import components from './components';
import { fontBody, fontTitle } from './fonts';

const titles = { fontFamily: fontTitle, fontWeight: 700 };

export default (server, darkMode, direction) =>
  useMemo(
    () =>
      createTheme({
        typography: {
          fontFamily: fontBody,
          // Barlow se autoaloja hasta 600: la negrita usa ese peso en vez de una sintética.
          fontWeightBold: 600,
          h1: titles,
          h2: titles,
          h3: titles,
          h4: titles,
          h5: { ...titles, fontWeight: 600 },
          h6: { ...titles, fontWeight: 600 },
          button: { textTransform: 'none', fontWeight: 600 },
        },
        shape: {
          borderRadius: 8,
        },
        palette: palette(server, darkMode),
        direction,
        dimensions,
        components,
      }),
    [server, darkMode, direction],
  );

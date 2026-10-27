// Fuentes del sitio web de RudaTrak (Barlow y Barlow Condensed, licencia OFL), autoalojadas.
import barlow400 from '../../resources/fonts/barlow-latin-400-normal.woff2';
import barlow500 from '../../resources/fonts/barlow-latin-500-normal.woff2';
import barlow600 from '../../resources/fonts/barlow-latin-600-normal.woff2';
import condensed500 from '../../resources/fonts/barlow-condensed-latin-500-normal.woff2';
import condensed600 from '../../resources/fonts/barlow-condensed-latin-600-normal.woff2';
import condensed700 from '../../resources/fonts/barlow-condensed-latin-700-normal.woff2';

export const fontBody =
  '"Barlow", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
export const fontTitle =
  '"Barlow Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';

const fontFace = (family, weight, url) => `
  @font-face {
    font-family: "${family}";
    font-style: normal;
    font-weight: ${weight};
    font-display: swap;
    src: url("${url}") format("woff2");
  }`;

export const fontFaces = [
  fontFace('Barlow', 400, barlow400),
  fontFace('Barlow', 500, barlow500),
  fontFace('Barlow', 600, barlow600),
  fontFace('Barlow Condensed', 500, condensed500),
  fontFace('Barlow Condensed', 600, condensed600),
  fontFace('Barlow Condensed', 700, condensed700),
].join('\n');

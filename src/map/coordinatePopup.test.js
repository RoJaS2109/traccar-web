import { describe, expect, it } from 'vitest';
import { coordinatePopupHtml } from './coordinatePopup';

const COORDS = '-34.603700, -58.381600';

// Cada <div style="...">texto</div> del popup, con su style y su texto.
const textosDelPopup = (html) =>
  [...html.matchAll(/<div\s+style="([^"]*)"[^>]*>([^<]*)</g)].map(([, style, texto]) => ({
    style,
    texto,
  }));

describe('coordinatePopupHtml', () => {
  // El popup de MapLibre tiene fondo blanco fijo y no define color de texto: lo hereda
  // del body, que en tema oscuro es blanco. Sin `color` propio el texto desaparece.
  it('todo texto declara su color en lugar de heredarlo del body', () => {
    const textos = textosDelPopup(coordinatePopupHtml(COORDS));

    expect(textos).toHaveLength(2);
    textos.forEach(({ style, texto }) => {
      expect(style, `"${texto}" no declara color y quedaría invisible en tema oscuro`).toContain(
        'color:',
      );
    });
  });

  it('incluye las coordenadas, la leyenda y el copiado al portapapeles', () => {
    const html = coordinatePopupHtml(COORDS);

    expect(html).toContain(COORDS);
    expect(html).toContain('Click para Copiar');
    expect(html).toContain('navigator.clipboard.writeText');
  });
});

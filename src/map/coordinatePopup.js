// HTML del popup del pin de coordenadas (MapCoordinatePicker).
//
// OJO con los colores: `.maplibregl-popup-content` (CSS de MapLibre) define
// `background:#fff` pero NO el color del texto, que queda heredado del body. Con el
// tema oscuro de la app —que se activa con `prefers-color-scheme: dark`, es decir con
// el modo oscuro de Android— el body hereda `color:#fff`, así que cualquier texto del
// popup sin `color` propio se pinta blanco sobre el fondo blanco: invisible.
//
// Regla: todo texto de este popup declara su color. Mismo problema ya resuelto en
// `map/main/PoiMap.js` (su línea de coordenadas usa `color:#888` explícito).
export const coordinatePopupHtml = (coordsText) =>
  '<div ' +
  'style="font-size:13px;color:#999;text-align:center;margin-bottom:2px">Click para Copiar</div>' +
  '<div ' +
  'style="font-size:13px;color:#000;padding:2px 10px 6px;white-space:nowrap;font-family:monospace;cursor:pointer;user-select:all;text-align:center" ' +
  `title="Copiar coordenadas" ` +
  `onclick="var t=this.textContent;navigator.clipboard.writeText(t).catch(function(){});this.textContent='¡Copiado!';setTimeout(function(){this.textContent=t;}.bind(this),1200)">` +
  `${coordsText}</div>`;

import maplibregl from 'maplibre-gl';
import { readTile } from './tileStore';

let offlineProtocolRegistered = false;

// PNG 1×1 transparente (gris + alfa). Se devuelve cuando un tile no está
// descargado para que MapLibre no loguee un error por cada hueco ni rompa el
// render: el área queda transparente y se ve la capa background del estilo.
const EMPTY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const emptyPngBuffer = () => {
  const binary = atob(EMPTY_PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

// URL: offline://{layer}/{z}/{x}/{y}
//
// MapLibre 5 usa el handler con firma (params, abortController) => Promise<{ data }>,
// no el estilo de callback de v2/v3. Por eso se devuelve { data: ArrayBuffer } (o se
// lanza un error) en vez de llamar a callback(null, buffer).
export const registerOfflineProtocol = () => {
  if (offlineProtocolRegistered) return;
  maplibregl.addProtocol('offline', async (params) => {
    const [, layer, z, x, y] = params.url.replace('offline://', '').split('/');
    const buffer = await readTile(layer, Number(z), Number(x), Number(y));
    if (buffer) {
      return { data: buffer };
    }
    return { data: emptyPngBuffer() };
  });
  offlineProtocolRegistered = true;
};

import maplibregl from 'maplibre-gl';
import { getTile } from './zoneStore';

let offlineProtocolRegistered = false;

// URL: offline://mapas/{z}/{x}/{y}
//
// MapLibre 5 usa el handler con firma (params, abortController) => Promise<{ data }>,
// no el estilo de callback de v2/v3. Se devuelve { data: ArrayBuffer } con el tile MVT
// ya descomprimido (getTile delega la descompresión gzip a pmtiles), o un ArrayBuffer
// vacío para los tiles inexistentes: fuera de toda zona o hueco dentro de una. Un
// buffer vacío es lo que MapLibre interpreta como "tile sin datos" (igual que hace el
// Protocol.tilev4 integrado de pmtiles), sin loguear error por cada hueco.
export const registerOfflineProtocol = () => {
  if (offlineProtocolRegistered) return;
  maplibregl.addProtocol('offline', async (params) => {
    const path = (params.url.split('://')[1] ?? '').split('/').filter(Boolean);
    const [z, x, y] = path.slice(-3).map(Number);
    const data = await getTile(z, x, y);
    return { data: data ?? new ArrayBuffer(0) };
  });
  offlineProtocolRegistered = true;
};

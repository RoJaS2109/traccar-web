import maplibregl from 'maplibre-gl';
import { readTile } from './tileStore';

let offlineProtocolRegistered = false;

// URL: offline://{layer}/{z}/{x}/{y}
export const registerOfflineProtocol = () => {
  if (offlineProtocolRegistered) return;
  maplibregl.addProtocol('offline', async (params, callback) => {
    const [, layer, z, x, y] = params.url.replace('offline://', '').split('/');
    try {
      const buffer = await readTile(layer, Number(z), Number(x), Number(y));
      if (buffer) {
        callback(null, buffer);
      } else {
        callback(new Error('tile not found'));
      }
    } catch (error) {
      callback(error);
    }
  });
  offlineProtocolRegistered = true;
};

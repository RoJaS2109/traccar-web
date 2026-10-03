import { Protocol } from 'pmtiles';

// Instancia única del protocolo pmtiles, compartida entre el registro global de
// MapLibre y el estilo online (que usa protocol.add para inyectar un FetchSource
// con Authorization). Una sola instancia garantiza que add() y el despacho de tiles
// miren el mismo mapa de PMTiles.
export const pmtilesProtocol = new Protocol();

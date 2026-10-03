import { Directory, Filesystem } from '@capacitor/filesystem';

// Convierte base64 (lo que Filesystem.readFile devuelve para binarios en nativo)
// a ArrayBuffer. La cadena puede ser grande (tiles MVT de cientos de KB), así que
// se decodifica en un solo pase sobre un Uint8Array.
const base64ToArrayBuffer = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

// LRU mínimo basado en Map (el orden de inserción marca la antigüedad: reinsertar
// en get() lo mueve al final). Límite por bytes y por cantidad de entradas para no
// desbordar el heap del WebView, que es limitado (32 bits en la app).
class LruCache {
  constructor(maxBytes, maxEntries) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.bytes = 0;
    this.map = new Map();
  }

  get(key) {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.bytes -= this.map.get(key).byteLength;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.byteLength;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.map.keys().next().value;
      this.bytes -= this.map.get(oldestKey).byteLength;
      this.map.delete(oldestKey);
    }
  }
}

// Source de pmtiles que lee el archivo desde Filesystem (Directory.Data) usando
// offset/length. pmtiles pide primero getBytes(0, 16384) para el header, después
// lecturas de directorios (pequeñas y repetidas) y por último las de tiles. La
// descompresión gzip del MVT la hace pmtiles en getZxy(); esta clase devuelve bytes
// crudos, como exige la interfaz Source.
export class CapacitorPmtilesSource {
  constructor(path, directory = Directory.Data) {
    this.path = path;
    this.directory = directory;
    // Caché LRU compartida: cubre los directorios (muchas lecturas cortas) y, de
    // paso, los tiles que MapLibre vuelva a pedir en pans/refrescos.
    this.cache = new LruCache(16 * 1024 * 1024, 256);
  }

  getKey() {
    return this.path;
  }

  async getBytes(offset, length) {
    const key = `${offset}:${length}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return { data: cached };

    const result = await Filesystem.readFile({
      path: this.path,
      directory: this.directory,
      offset,
      length,
    });

    const data = base64ToArrayBuffer(result.data);
    this.cache.set(key, data);
    return { data };
  }
}

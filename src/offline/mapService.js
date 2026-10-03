// Lógica pura del cliente trak-mapas, separada de mapDownloader.js (que importa los
// plugins nativos de Capacitor) para poder testearla con vitest sin tocar Capacitor.
//
// - MapServiceError: error tipado con `code` para que la UI mapee cada caso a un
//   mensaje sin inspeccionar strings.
// - mapHttpStatus: mapea el status HTTP (y el body JSON ya parseado) a un error tipado.
// - validatePmtilesSize / validatePmtilesHeader: validación del .part descargado.

export class MapServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MapServiceError';
    this.code = code;
    Object.assign(this, details);
  }
}

// Mapea el status HTTP a un MapServiceError tipado. Devuelve null para 2xx (no es
// error). Refleja el contrato del servicio trak-mapas:
//   401 unauthorized · 413 tooLarge · 429 rateLimited · 503 busy ·
//   404 notFound · 409 conflict · 410 gone · resto (>=300) server.
export const mapHttpStatus = (status, data) => {
  if (status === 401)
    return new MapServiceError('unauthorized', 'Sesión expirada o revocada', { status });
  if (status === 503) return new MapServiceError('busy', 'El servidor está ocupado', { status });
  if (status === 413)
    return new MapServiceError('tooLarge', 'La zona es demasiado grande', {
      status,
      bytes: data?.bytes,
      maxBytes: data?.maxBytes,
    });
  if (status === 429)
    return new MapServiceError('rateLimited', 'Demasiados pedidos', {
      status,
      retryAfter: data?.retryAfter,
    });
  if (status === 404)
    return new MapServiceError('notFound', data?.error || 'No encontrado', { status });
  if (status === 409)
    return new MapServiceError('conflict', data?.error || 'Conflicto', { status });
  if (status === 410)
    return new MapServiceError('gone', data?.error || 'Ya no disponible', { status });
  if (status < 200 || status >= 300)
    return new MapServiceError('server', data?.error || `Error ${status}`, { status });
  return null;
};

export const PMTILES_MAGIC = 'PMTiles';
export const PMTILES_SPEC_V3 = 3;

// Valida el tamaño de un .part descargado: no vacío y, si se conoce el largo total,
// completo.
export const validatePmtilesSize = ({ size, contentLength, lengthComputable }) => {
  if (!size || size <= 0) {
    throw new MapServiceError('validation', 'El archivo descargado está vacío');
  }
  if (lengthComputable && contentLength > 0 && size !== contentLength) {
    throw new MapServiceError('validation', 'La descarga quedó incompleta');
  }
};

// Valida los primeros bytes de un .pmtiles: magic "PMTiles" y versión de spec 3.
export const validatePmtilesHeader = (bytes) => {
  const magic = String.fromCharCode(...Array.from(bytes.slice(0, 7)));
  if (magic !== PMTILES_MAGIC || bytes[7] !== PMTILES_SPEC_V3) {
    throw new MapServiceError('validation', 'El archivo no es un PMTiles válido');
  }
};

import { describe, it, expect } from 'vitest';
import {
  MapServiceError,
  mapHttpStatus,
  validatePmtilesSize,
  validatePmtilesHeader,
  PMTILES_MAGIC,
  PMTILES_SPEC_V3,
} from './mapService';

const headerBytes = () => {
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 7; i += 1) bytes[i] = PMTILES_MAGIC.charCodeAt(i);
  bytes[7] = PMTILES_SPEC_V3;
  return bytes;
};

describe('mapHttpStatus', () => {
  it.each([
    [401, 'unauthorized'],
    [413, 'tooLarge'],
    [429, 'rateLimited'],
    [503, 'busy'],
    [404, 'notFound'],
    [409, 'conflict'],
    [410, 'gone'],
  ])('mapea %i a %s', (status, code) => {
    const error = mapHttpStatus(status, {});
    expect(error).toBeInstanceOf(MapServiceError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });

  it('devuelve null para 2xx', () => {
    expect(mapHttpStatus(200, {})).toBeNull();
    expect(mapHttpStatus(201, {})).toBeNull();
  });

  it('mapea un status no catalogado (>=300) a server con el mensaje del body', () => {
    const error = mapHttpStatus(500, { error: 'explosión' });
    expect(error.code).toBe('server');
    expect(error.message).toBe('explosión');
  });

  it('propaga bytes/maxBytes en 413 y retryAfter en 429', () => {
    const tooLarge = mapHttpStatus(413, { bytes: 10, maxBytes: 5 });
    expect(tooLarge.bytes).toBe(10);
    expect(tooLarge.maxBytes).toBe(5);
    const rate = mapHttpStatus(429, { retryAfter: 15 });
    expect(rate.retryAfter).toBe(15);
  });
});

describe('validatePmtilesSize', () => {
  it('rechaza archivo vacío (size 0)', () => {
    expect(() => validatePmtilesSize({ size: 0 })).toThrow(/vacío/);
  });

  it('rechaza descarga incompleta (size < contentLength)', () => {
    expect(() =>
      validatePmtilesSize({ size: 100, contentLength: 200, lengthComputable: true }),
    ).toThrow(/incompleta/);
  });

  it('acepta size > 0 con longitud desconocida', () => {
    expect(() =>
      validatePmtilesSize({ size: 100, contentLength: 0, lengthComputable: false }),
    ).not.toThrow();
  });
});

describe('validatePmtilesHeader', () => {
  it('acepta magic PMTiles + versión 3', () => {
    expect(() => validatePmtilesHeader(headerBytes())).not.toThrow();
  });

  it('rechaza magic incorrecto', () => {
    const bytes = headerBytes();
    bytes[0] = 'X'.charCodeAt(0);
    expect(() => validatePmtilesHeader(bytes)).toThrow(/no es un PMTiles/);
  });

  it('rechaza versión distinta de 3', () => {
    const bytes = headerBytes();
    bytes[7] = 2;
    expect(() => validatePmtilesHeader(bytes)).toThrow(/no es un PMTiles/);
  });
});

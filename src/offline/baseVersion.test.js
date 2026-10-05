import { describe, it, expect } from 'vitest';
import {
  BASE_VERSION_TTL_MS,
  isBaseVersionStale,
  isCacheFromServer,
  resolveBaseVersion,
  shouldRefreshBaseVersion,
} from './baseVersion';

const SERVIDOR = 'https://mh.rudatrak.com';
const OTRO = 'https://otro.rudatrak.com';
const VERSION = 'sudamerica-20261003-z15-v2.pmtiles:8647255196';
const AHORA = 1_800_000_000_000;

const cache = (extra = {}) => ({
  value: VERSION,
  serverUrl: SERVIDOR,
  fetchedAt: AHORA,
  ...extra,
});

describe('resolveBaseVersion', () => {
  it('devuelve la versión cacheada del servidor configurado', () => {
    expect(resolveBaseVersion({ cache: cache(), serverUrl: SERVIDOR })).toBe(VERSION);
  });

  it('devuelve la versión cacheada aunque esté vencida (es la última verdad conocida)', () => {
    const viejo = cache({ fetchedAt: AHORA - 10 * BASE_VERSION_TTL_MS });
    expect(resolveBaseVersion({ cache: viejo, serverUrl: SERVIDOR })).toBe(VERSION);
  });

  it('cambio de servidor: descarta el caché y devuelve null', () => {
    expect(resolveBaseVersion({ cache: cache(), serverUrl: OTRO })).toBeNull();
  });

  it('sin caché (nunca se consultó) devuelve null', () => {
    expect(resolveBaseVersion({ cache: null, serverUrl: SERVIDOR })).toBeNull();
  });

  it('ignora un caché sin valor o corrupto', () => {
    expect(resolveBaseVersion({ cache: cache({ value: null }), serverUrl: SERVIDOR })).toBeNull();
    expect(resolveBaseVersion({ cache: cache({ value: '' }), serverUrl: SERVIDOR })).toBeNull();
  });

  it('ignora el caché si no se sabe contra qué servidor se obtuvo', () => {
    expect(
      resolveBaseVersion({ cache: cache({ serverUrl: undefined }), serverUrl: SERVIDOR }),
    ).toBeNull();
  });
});

describe('isCacheFromServer', () => {
  it('exige valor y coincidencia de servidor', () => {
    expect(isCacheFromServer(cache(), SERVIDOR)).toBe(true);
    expect(isCacheFromServer(cache(), OTRO)).toBe(false);
    expect(isCacheFromServer(null, SERVIDOR)).toBe(false);
  });
});

describe('isBaseVersionStale', () => {
  it('fresca dentro del TTL', () => {
    expect(isBaseVersionStale({ cache: cache(), serverUrl: SERVIDOR, now: AHORA + 1000 })).toBe(
      false,
    );
  });

  it('vencida pasado el TTL', () => {
    const now = AHORA + BASE_VERSION_TTL_MS + 1;
    expect(isBaseVersionStale({ cache: cache(), serverUrl: SERVIDOR, now })).toBe(true);
  });

  it('sin fecha de consulta se considera vencida', () => {
    const sinFecha = cache({ fetchedAt: undefined });
    expect(isBaseVersionStale({ cache: sinFecha, serverUrl: SERVIDOR, now: AHORA })).toBe(true);
  });

  it('caché de otro servidor se considera vencida', () => {
    expect(isBaseVersionStale({ cache: cache(), serverUrl: OTRO, now: AHORA })).toBe(true);
  });
});

describe('shouldRefreshBaseVersion', () => {
  it('sin red no consulta, aunque el caché esté vencido', () => {
    const now = AHORA + 10 * BASE_VERSION_TTL_MS;
    expect(
      shouldRefreshBaseVersion({ cache: cache(), serverUrl: SERVIDOR, online: false, now }),
    ).toBe(false);
  });

  it('con red desconocida (undefined) tampoco consulta', () => {
    const now = AHORA + 10 * BASE_VERSION_TTL_MS;
    expect(
      shouldRefreshBaseVersion({ cache: cache(), serverUrl: SERVIDOR, online: undefined, now }),
    ).toBe(false);
  });

  it('con red y caché vencido consulta', () => {
    const now = AHORA + BASE_VERSION_TTL_MS + 1;
    expect(
      shouldRefreshBaseVersion({ cache: cache(), serverUrl: SERVIDOR, online: true, now }),
    ).toBe(true);
  });

  it('con red y caché fresco no consulta', () => {
    expect(
      shouldRefreshBaseVersion({
        cache: cache(),
        serverUrl: SERVIDOR,
        online: true,
        now: AHORA + 1,
      }),
    ).toBe(false);
  });

  it('con red y sin caché consulta (primera vez)', () => {
    expect(
      shouldRefreshBaseVersion({ cache: null, serverUrl: SERVIDOR, online: true, now: AHORA }),
    ).toBe(true);
  });

  it('con red y caché de otro servidor consulta', () => {
    expect(
      shouldRefreshBaseVersion({ cache: cache(), serverUrl: OTRO, online: true, now: AHORA }),
    ).toBe(true);
  });
});

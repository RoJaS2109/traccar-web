import { describe, it, expect } from 'vitest';
import {
  CURRENT_MAX_ZOOM,
  OFFLINE_DEFAULT_MAX_ZOOM,
  computeOfflineMaxZoom,
} from './offlineMaxZoom';

describe('computeOfflineMaxZoom', () => {
  it('devuelve el fallback cuando no hay zonas', () => {
    expect(computeOfflineMaxZoom([])).toBe(OFFLINE_DEFAULT_MAX_ZOOM);
    expect(computeOfflineMaxZoom(null)).toBe(OFFLINE_DEFAULT_MAX_ZOOM);
    expect(computeOfflineMaxZoom(undefined)).toBe(OFFLINE_DEFAULT_MAX_ZOOM);
  });

  it('devuelve el maxZoom de una única zona', () => {
    expect(computeOfflineMaxZoom([{ maxZoom: 15 }])).toBe(15);
    expect(computeOfflineMaxZoom([{ maxZoom: 14 }])).toBe(14);
  });

  it('devuelve el mínimo entre varias zonas', () => {
    expect(computeOfflineMaxZoom([{ maxZoom: 14 }, { maxZoom: 15 }])).toBe(14);
    expect(computeOfflineMaxZoom([{ maxZoom: 15 }, { maxZoom: 13 }, { maxZoom: 14 }])).toBe(13);
  });

  it('ignora zonas sin maxZoom válido', () => {
    expect(computeOfflineMaxZoom([{ maxZoom: 15 }, { maxZoom: undefined }, {}])).toBe(15);
    expect(computeOfflineMaxZoom([{ maxZoom: undefined }, {}])).toBe(OFFLINE_DEFAULT_MAX_ZOOM);
  });

  it('CURRENT_MAX_ZOOM es 15 (build z15 vigente)', () => {
    expect(CURRENT_MAX_ZOOM).toBe(15);
  });
});

import { describe, it, expect } from 'vitest';
import { OUTDATED_LABEL_KEY, isOutdated, outdatedReason } from './offlineOutdated';
import { CURRENT_MAX_ZOOM } from './offlineMaxZoom';

const VIGENTE = 'sudamerica-20261003-z15-v2.pmtiles:8647255196';
const VIEJA = 'sudamerica-20261003-z15.pmtiles:8501666385';

const zona = (extra = {}) => ({
  id: 'z1',
  buildVersion: VIGENTE,
  maxZoom: CURRENT_MAX_ZOOM,
  ...extra,
});

describe('outdatedReason', () => {
  it('marca por zoom cuando la zona se bajó a un zoom menor que el vigente', () => {
    expect(outdatedReason(zona({ maxZoom: CURRENT_MAX_ZOOM - 1 }), VIGENTE)).toBe('zoom');
  });

  it('el motivo zoom gana sobre el de base (mismo caso, ambos desfasajes)', () => {
    expect(outdatedReason(zona({ maxZoom: 13, buildVersion: VIEJA }), VIGENTE)).toBe('zoom');
  });

  it('marca por base cuando el buildVersion difiere del vigente', () => {
    expect(outdatedReason(zona({ buildVersion: VIEJA }), VIGENTE)).toBe('base');
  });

  it('marca como desconocida una zona sin buildVersion cuando el servidor informa versión', () => {
    expect(outdatedReason(zona({ buildVersion: null }), VIGENTE)).toBe('unknown');
  });

  it('no marca nada si la zona está al día', () => {
    expect(outdatedReason(zona(), VIGENTE)).toBeNull();
    expect(isOutdated(zona(), VIGENTE)).toBe(false);
  });

  describe('sin red / servidor sin versión (currentVersion null)', () => {
    it('no marca por origen una zona sin buildVersion', () => {
      expect(outdatedReason(zona({ buildVersion: null }), null)).toBeNull();
    });

    it('no marca por base: no hay contra qué comparar', () => {
      expect(outdatedReason(zona({ buildVersion: VIEJA }), null)).toBeNull();
    });

    it('sigue marcando por zoom: no depende del servidor', () => {
      expect(outdatedReason(zona({ maxZoom: 12 }), null)).toBe('zoom');
    });
  });

  it('tolera una zona vacía o nula', () => {
    expect(outdatedReason(null, VIGENTE)).toBeNull();
    expect(outdatedReason(undefined, VIGENTE)).toBeNull();
  });

  it('una zona sin maxZoom no se marca por zoom', () => {
    expect(outdatedReason(zona({ maxZoom: null }), VIGENTE)).toBeNull();
  });

  it('cada motivo tiene su clave de traducción', () => {
    for (const reason of ['zoom', 'base', 'unknown']) {
      expect(OUTDATED_LABEL_KEY[reason]).toMatch(/^offlineMaps/);
    }
  });
});

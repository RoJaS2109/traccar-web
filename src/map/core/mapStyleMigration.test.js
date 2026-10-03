import { describe, it, expect } from 'vitest';
import {
  migrateSelectedMapStyle,
  MAP_STYLE_STORAGE_KEY,
  MAP_STYLE_MIGRATION_VERSION_KEY,
  MAP_STYLE_MIGRATION_VERSION,
} from './mapStyleMigration';

const makeStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
  };
};

describe('migrateSelectedMapStyle', () => {
  it('no hace nada fuera de nativo', () => {
    const storage = makeStorage({ [MAP_STYLE_STORAGE_KEY]: '"argenmap"' });
    migrateSelectedMapStyle(storage, false);
    expect(storage.getItem(MAP_STYLE_STORAGE_KEY)).toBe('"argenmap"');
    expect(storage.getItem(MAP_STYLE_MIGRATION_VERSION_KEY)).toBeNull();
  });

  it('reemplaza argenmap por openFreeMap y marca la versión', () => {
    const storage = makeStorage({ [MAP_STYLE_STORAGE_KEY]: '"argenmap"' });
    migrateSelectedMapStyle(storage, true);
    expect(storage.getItem(MAP_STYLE_STORAGE_KEY)).toBe('"openFreeMap"');
    expect(storage.getItem(MAP_STYLE_MIGRATION_VERSION_KEY)).toBe(MAP_STYLE_MIGRATION_VERSION);
  });

  it('reemplaza argenmapTopo por openFreeMap', () => {
    const storage = makeStorage({ [MAP_STYLE_STORAGE_KEY]: '"argenmapTopo"' });
    migrateSelectedMapStyle(storage, true);
    expect(storage.getItem(MAP_STYLE_STORAGE_KEY)).toBe('"openFreeMap"');
  });

  it('no toca estilos que no son IGN', () => {
    const storage = makeStorage({ [MAP_STYLE_STORAGE_KEY]: '"locationIqStreets"' });
    migrateSelectedMapStyle(storage, true);
    expect(storage.getItem(MAP_STYLE_STORAGE_KEY)).toBe('"locationIqStreets"');
  });

  it('no repite la migración si ya está versionada', () => {
    const storage = makeStorage({
      [MAP_STYLE_STORAGE_KEY]: '"argenmap"',
      [MAP_STYLE_MIGRATION_VERSION_KEY]: MAP_STYLE_MIGRATION_VERSION,
    });
    migrateSelectedMapStyle(storage, true);
    expect(storage.getItem(MAP_STYLE_STORAGE_KEY)).toBe('"argenmap"');
  });
});

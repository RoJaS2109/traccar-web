// Migración idempotente del estilo de mapa guardado. Sin imports de Capacitor para
// poder testearla en node; el flag nativo se recibe por parámetro.

export const MAP_STYLE_STORAGE_KEY = 'selectedMapStyle';
export const MAP_STYLE_MIGRATION_VERSION_KEY = 'mapStyleMigrationVersion';
export const MAP_STYLE_MIGRATION_VERSION = '1';

const NEW_DEFAULT = 'openFreeMap';
const LEGACY_STYLES = ['argenmap', 'argenmapTopo'];

// Reemplaza una sola vez el estilo guardado si quedó en un estilo raster IGN
// (argenmap / argenmapTopo) por el nuevo default. Idempotente: marca una clave de
// versión para no volver a correr.
export const migrateSelectedMapStyle = (storage, isNativeFlag, newDefault = NEW_DEFAULT) => {
  if (!isNativeFlag) return false;
  if (storage.getItem(MAP_STYLE_MIGRATION_VERSION_KEY) === MAP_STYLE_MIGRATION_VERSION) {
    return false;
  }
  const raw = storage.getItem(MAP_STYLE_STORAGE_KEY);
  if (raw != null) {
    let current;
    try {
      current = JSON.parse(raw);
    } catch {
      current = raw;
    }
    if (LEGACY_STYLES.includes(current)) {
      storage.setItem(MAP_STYLE_STORAGE_KEY, JSON.stringify(newDefault));
    }
  }
  storage.setItem(MAP_STYLE_MIGRATION_VERSION_KEY, MAP_STYLE_MIGRATION_VERSION);
  return true;
};

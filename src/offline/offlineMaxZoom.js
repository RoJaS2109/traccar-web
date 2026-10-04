// Tope de detalle actual de las zonas offline. El build Protomaps vigente es z15:
// NewZoneDialog descarga a este zoom y OfflineMapsScreen marca como "desactualizada"
// cualquier zona con maxZoom menor. Se centraliza aquí para no repetir el número.
export const CURRENT_MAX_ZOOM = 15;

// Fallback del maxzoom de la fuente del estilo offline cuando no hay zonas instaladas.
// Es conservador (14): sin zonas no hay tiles propios, y 14 evita que MapLibre pida
// tiles z15+ que nadie sirve.
export const OFFLINE_DEFAULT_MAX_ZOOM = 14;

// Mínimo maxZoom entre las zonas instaladas. Evita que una zona nueva z15 mezclada con
// zonas viejas z14 genere gris a z15+ (en esas áreas MapLibre hará overzoom del tile
// z14). Sin zonas, o sin ningún maxZoom válido, devuelve el fallback.
export const computeOfflineMaxZoom = (zones) => {
  if (!Array.isArray(zones) || zones.length === 0) return OFFLINE_DEFAULT_MAX_ZOOM;
  const maxZooms = zones.map((zone) => zone?.maxZoom).filter(Number.isFinite);
  return maxZooms.length === 0 ? OFFLINE_DEFAULT_MAX_ZOOM : Math.min(...maxZooms);
};

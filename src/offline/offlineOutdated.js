// Cuándo una zona descargada dejó de estar al día. Hay tres motivos distintos y la UI
// los distingue porque la acción del usuario es la misma (volver a descargar) pero la
// certeza no:
//
//  - 'zoom'    : se bajó a un zoom menor que el vigente (CURRENT_MAX_ZOOM).
//  - 'base'    : se recortó de un base distinto del vigente (buildVersion ≠ actual).
//  - 'unknown' : no tiene buildVersion (se descargó antes de que existiera el campo)
//                y el servidor sí informa una versión vigente: el origen se desconoce.
import { CURRENT_MAX_ZOOM } from './offlineMaxZoom';

export const OUTDATED_LABEL_KEY = {
  zoom: 'offlineMapsOutdated',
  base: 'offlineMapsOutdatedBase',
  unknown: 'offlineMapsOutdatedUnknown',
};

export const outdatedReason = (zone, currentVersion) => {
  if (!zone) return null;
  if (zone.maxZoom != null && zone.maxZoom < CURRENT_MAX_ZOOM) return 'zoom';
  // Sin versión vigente conocida (servidor que todavía no expone /maps/version, o sin
  // red y sin caché previo) no se puede afirmar nada sobre el origen de la zona: se
  // degrada a la comparación por zoom, en vez de marcar todo como desconocido.
  if (!currentVersion) return null;
  if (!zone.buildVersion) return 'unknown';
  if (zone.buildVersion !== currentVersion) return 'base';
  return null;
};

export const isOutdated = (zone, currentVersion) => outdatedReason(zone, currentVersion) !== null;

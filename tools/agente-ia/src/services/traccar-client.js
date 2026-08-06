import logger from '../config/logger.js';

let initialized = false;

export function initTraccarClient() {
  // TODO: Implementar cliente HTTP para la API de Traccar
  logger.info('Traccar client: stub initialized');
  initialized = true;
}

export function isInitialized() {
  return initialized;
}

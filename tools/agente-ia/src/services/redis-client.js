import logger from '../config/logger.js';

let connected = false;

export async function connectRedis() {
  // TODO: Implementar con ioredis cuando Redis esté configurado
  logger.info('Redis client: stub connect (Redis not yet implemented)');
  connected = false;
}

export function isRedisConnected() {
  return connected;
}

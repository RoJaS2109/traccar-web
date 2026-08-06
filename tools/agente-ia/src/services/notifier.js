import logger from '../config/logger.js';

// TODO: Implementar notificaciones (email, Telegram, etc.)
export async function sendNotification(channel, message) {
  logger.info(`Notification stub: [${channel}] ${message}`);
  return true;
}

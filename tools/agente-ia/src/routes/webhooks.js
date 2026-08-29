import { Router } from 'express';
import logger from '../config/logger.js';

const router = Router();

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;

function isAuthorized(req) {
  // Sin token configurado → aceptar sin validar (modo dev / auth deshabilitada).
  if (!WEBHOOK_TOKEN) {
    return true;
  }
  return req.headers.authorization === `Bearer ${WEBHOOK_TOKEN}`;
}

// POST /webhook/evento — receptor del EventForwarder de Traccar.
router.post('/evento', (req, res) => {
  if (!isAuthorized(req)) {
    logger.warn('Webhook /evento: token inválido o ausente');
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  logger.info(`Webhook /evento recibido: ${JSON.stringify(req.body)}`);

  // TODO: enrutar al agente guardián (src/agents/guardian.js) para la escalada.
  // La lógica de escalada (máquina de estados, timers, Redis, Telegram/Ollama)
  // todavía no está implementada: el agente-ia es un esqueleto.

  // Traccar exige respuesta 2xx para considerar el forward exitoso.
  res.json({ status: 'ok', message: 'Evento recibido' });
});

// Alias de compatibilidad: POST /webhook (ruta raíz previa).
router.post('/', (req, res) => {
  if (!isAuthorized(req)) {
    logger.warn('Webhook /: token inválido o ausente');
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  logger.info(`Webhook / recibido: ${JSON.stringify(req.body)}`);
  res.json({ status: 'ok', message: 'Evento recibido' });
});

export default router;

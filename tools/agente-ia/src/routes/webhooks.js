import { Router } from 'express';
import logger from '../config/logger.js';

const router = Router();

// TODO: Implementar endpoints de webhook
router.post('/', (req, res) => {
  logger.info('Webhook received (stub):', req.body);
  res.json({ status: 'ok', message: 'Webhook endpoint not yet implemented' });
});

export default router;

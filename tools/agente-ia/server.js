import express from 'express';
import logger from './src/config/logger.js';
import { connectRedis, isRedisConnected } from './src/services/redis-client.js';
import { initTraccarClient } from './src/services/traccar-client.js';
import webhookRoutes from './src/routes/webhooks.js';

const app = express();
const PORT = process.env.PORT || 3008;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Middleware
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  const redisStatus = isRedisConnected() ? 'connected' : 'disconnected';
  res.json({
    status: 'ok',
    service: 'rudatrak-ia',
    environment: NODE_ENV,
    uptime: process.uptime(),
    redis: redisStatus,
  });
});

// API routes
app.use('/webhook', webhookRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Inicializar servicios y arrancar servidor
 */
const startServer = async () => {
  try {
    logger.info(`Starting rudatrak-ia in ${NODE_ENV} mode`);

    // Conectar a Redis
    try {
      await connectRedis();
    } catch (error) {
      logger.error('Failed to connect to Redis:', error.message);
      logger.warn('Continuing without Redis (state will be lost on restart)');
    }

    // Inicializar cliente Traccar
    try {
      initTraccarClient();
    } catch (error) {
      logger.error('Failed to initialize Traccar client:', error.message);
      throw error;
    }

    // Arrancar servidor Express
    const server = app.listen(PORT, () => {
      logger.info(`🚀 rudatrak-ia listening on port ${PORT}`);
      logger.info(`📍 Traccar API: ${process.env.TRACCAR_API_URL || 'http://localhost:8082'}`);
      logger.info(`📍 Redis: ${process.env.REDIS_URL || 'redis://localhost:6379'}`);
      logger.info(`📍 Health check: http://localhost:${PORT}/health`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      logger.info('SIGINT received, shutting down gracefully...');
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

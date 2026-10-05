import { config } from '../config.js';
import { openApiCollections } from '../db/connection.js';
import { openPgPool } from '../db/pg-connection.js';
import { createApp } from './server.js';
import { logger } from '../utils/logger.js';

async function bootstrap() {
    logger.info('Starting API server...');

    const [collections, pgPool] = await Promise.all([
        openApiCollections(),
        openPgPool(),
    ]);
    const app = createApp(collections, pgPool);

    const server = app.listen(config.api.port, () => {
        logger.info('API server listening on port %d', config.api.port);
    });

    // Graceful shutdown — same pattern as the Kafka poller's SIGTERM handling:
    // stop accepting new connections, let in-flight requests finish, then exit.
    const shutdown = (signal: string) => {
        logger.info({ signal }, 'Received signal, shutting down gracefully...');
        server.close(() => {
            void collections.client.close().then(() => {
                void pgPool.end().then(() => {
                    logger.info('HTTP server, MongoDB, and PostgreSQL connections closed');
                    process.exit(0);
                });
            });
        });

        // Force-close after 10s if connections hang
        setTimeout(() => {
            logger.warn('Forced shutdown after timeout');
            process.exit(1);
        }, 10_000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
    logger.fatal({ err }, 'Fatal error during API bootstrap. Exiting');
    process.exit(1);
});

import { config } from '../config.js';
import { openApiCollections } from '../db/connection.js';
import { createApp } from './server.js';
import { logger } from '../utils/logger.js';

async function bootstrap() {
    logger.info('Starting API server...');

    const collections = await openApiCollections();
    const app = createApp(collections);

    const server = app.listen(config.api.port, () => {
        logger.info('API server listening on port %d', config.api.port);
    });

    // Graceful shutdown — same pattern as the Kafka poller's SIGTERM handling:
    // stop accepting new connections, let in-flight requests finish, then exit.
    const shutdown = (signal: string) => {
        logger.info({ signal }, 'Received signal, shutting down gracefully...');
        server.close(() => {
            void collections.client.close().then(() => {
                logger.info('HTTP server and MongoDB connection closed');
                process.exit(0);
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

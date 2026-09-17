import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createStatusRouter } from './routes/status.js';
import { logger } from '../utils/logger.js';
import type { ApiCollections } from '../db/connection.js';

/**
 * Create the Express application.
 * `collections` is optional so the app can be built without MongoDB
 * (e.g. health-check-only tests). When absent, the /v1 routes are
 * not mounted.
 */
export function createApp(collections?: ApiCollections): express.Express {
    const app = express();

    app.use(helmet());
    app.use(cors());
    app.use(rateLimiter);

    app.use((req, _res, next) => {
        logger.info({ method: req.method, path: req.path }, 'incoming request');
        next();
    });

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' });
    });

    // Delays route — only when MongoDB collections are available
    if (collections) {
        app.use('/v1', createStatusRouter(collections));
    }

    app.use(errorHandler);

    return app;
}

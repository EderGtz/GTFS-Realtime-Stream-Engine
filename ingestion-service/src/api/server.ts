import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { join } from 'node:path';
import type pg from 'pg';
import { rateLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createStatusRouter } from './routes/status.js';
import { createRoutePerformanceRouter } from './routes/routePerformance.js';
import { createRouteHistoryRouter } from './routes/routeHistory.js';
import { logger } from '../utils/logger.js';
import type { ApiCollections } from '../db/connection.js';

/**
 * Create the Express application.
 * `collections` is optional so the app can be built without MongoDB
 * (e.g. health-check-only tests). When absent, the /v1 routes are
 * not mounted. `pgPool` is optional for the same reason, when
 * absent, the /v1/routes/:id/history route is not mounted.
 */
export function createApp(collections?: ApiCollections, pgPool?: pg.Pool): express.Express {
    const app = express();

    app.use(helmet({
        hsts: false,
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "unpkg.com"],
                styleSrc: ["'self'", "unpkg.com", "'unsafe-inline'"],
                imgSrc: [
                    "'self'",
                    "data:",
                    "tile.openstreetmap.org",
                    "*.tile.openstreetmap.org"
                ],
                connectSrc: ["'self'"],
                upgradeInsecureRequests: null,
            },
        },
        referrerPolicy: {
            policy: 'strict-origin-when-cross-origin',
        },
    }));
    app.use(cors());
    app.use(rateLimiter);

    app.use((req, _res, next) => {
        logger.info({ method: req.method, path: req.path }, 'incoming request');
        next();
    });

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' });
    });

    // Static files — map.html, map.js
    app.use(express.static(join(import.meta.dirname, '../public')));

    app.get('/map', (_req, res) => {
        res.sendFile(join(import.meta.dirname, '../public/map.html'));
    });

    app.get('/', (_req, res) => {
        res.redirect('/map');
    });

    // Delays route — only when MongoDB collections are available
    if (collections) {
        app.use('/v1', createStatusRouter(collections));
        app.use('/v1', createRoutePerformanceRouter(collections));
    }

    // History route — only when PostgreSQL pool is available
    if (pgPool) {
        app.use('/v1', createRouteHistoryRouter(pgPool));
    }

    app.use(errorHandler);

    return app;
}

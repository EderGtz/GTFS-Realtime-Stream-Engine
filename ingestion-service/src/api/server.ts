import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

export function createApp(): express.Express {
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

    // Routes will be mounted here in step 4
    // app.use('/v1', delaysRouter);

    app.use(errorHandler);

    return app;
}
 
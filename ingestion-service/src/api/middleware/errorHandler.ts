import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger.js';

/**
 * Global error handler.
 * Generic messages in production, full details in development/test.
 */
export function errorHandler(
    err: Error,
    _req: Request,
    res: Response,
    _next: NextFunction,
): void {
    logger.error({ err }, 'Unhandled error in request pipeline');

    const isDev = process.env.NODE_ENV !== 'production';

    res.status(500).json({
        error: isDev ? err.message : 'Internal server error',
    });
}

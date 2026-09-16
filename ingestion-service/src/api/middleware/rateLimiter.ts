import rateLimit from 'express-rate-limit';

/**
 * In-memory rate limiter: 100 requests per 15 minutes per IP.
 * Redis-backed limiter deferred to Phase 5 (multi-instance deploy).
 */
export const rateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});

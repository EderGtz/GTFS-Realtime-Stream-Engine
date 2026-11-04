import rateLimit from 'express-rate-limit';

/** Rate limiter window: 15 minutes. */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Requests allowed per IP per window.
 *
 * WHY 600 (was 100): the map polls every 30 s = 30 req/15 min per open tab,
 * and demo visitors arrive from mobile networks where CGNAT shares one IP
 * across many users — the old ceiling 429'd normal map usage behind a shared
 * IP. This limiter is now origin protection (a backstop against scraping and
 * abuse), not per-user fairness.
 *
 * FUTURE FIX: key on something other than IP (API keys / Redis-backed store)
 * if real API consumers appear; deferred to Phase 5 (multi-instance deploy).
 */
export const RATE_LIMIT_MAX = 600;

export const rateLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});

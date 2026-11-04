import { describe, test, expect, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// Silence pino logs during tests
vi.mock('../../src/utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createApp } from '../../src/api/server.js';
import { RATE_LIMIT_MAX } from '../../src/api/middleware/rateLimiter.js';

describe('rate limiter — demo robustness (A3 + M6)', () => {
    // One map tab polls /v1/status/live every 30 s = 30 req/15 min. The
    // ceiling (600) must comfortably clear many tabs behind one CGNAT-shared
    // IP, while still tripping for a sustained hammering client — origin
    // protection, not per-user fairness. The limiter store is a module-level
    // singleton, so this is one sequential budget by design.
    test(
        'sustained burst up to the ceiling never 429s; request N+1 is limited',
        async () => {
            const app: Express = createApp(); // limiter is global — /health suffices

            for (let i = 1; i <= RATE_LIMIT_MAX; i++) {
                const res = await request(app).get('/health');
                if (res.status !== 200) {
                    throw new Error(`request ${i} got ${res.status}, expected 200`);
                }
            }

            const limited = await request(app).get('/health');
            expect(limited.status).toBe(429);
            expect(limited.body.error).toMatch(/too many requests/i);
            expect(limited.headers['retry-after']).toBeDefined();
        },
        60_000,
    );

    test('ceiling is in the origin-protection range', () => {
        // 10 map tabs per shared IP (30 req/15 min each) with headroom.
        expect(RATE_LIMIT_MAX).toBeGreaterThanOrEqual(300);
        // Still a backstop: not effectively unlimited.
        expect(RATE_LIMIT_MAX).toBeLessThanOrEqual(3000);
    });
});

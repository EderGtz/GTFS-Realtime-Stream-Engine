import { describe, test, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { ApiCollections } from '../../src/db/connection.js';

vi.mock('../../src/utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createApp } from '../../src/api/server.js';
import { computeP95 } from '../../src/api/routes/routePerformance.js';

// --- Helpers -----------------------------------------------------------

/**
 * Mock MongoDB collection whose aggregate() returns pre-computed results.
 * The route handler calls collection.aggregate([...]).toArray(),
 * so we return a cursor-like object with toArray().
 */
function mockAggregateCollection(pipelineResult: unknown[]) {
    return {
        aggregate: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(pipelineResult),
        }),
    };
}

function appWithAggregations(
    deviationResult: unknown[],
    bunchingResult: unknown[],
): Express {
    const collections = {
        client: { close: vi.fn() },
        deviations: mockAggregateCollection(deviationResult),
        bunching: mockAggregateCollection(bunchingResult),
    } as unknown as ApiCollections;
    return createApp(collections);
}

// --- Seed data ---------------------------------------------------------

const seededDeviationResult = [
    {
        count: 24,
        avg_abs: 142,
        max_abs: 520,
        all_abs: [
            10, 20, 30, 40, 50, 55, 60, 80, 90, 100,
            110, 120, 130, 140, 150, 160, 170, 180, 200, 250,
            300, 350, 400, 520,
        ],
        on_time_count: 15, // 15 out of 24 within ±180s
        route_long_name: 'Mattapan Station - Ruggles Station',
    },
];

const seededBunchingResult = [
    {
        active_events: 2,
        worst_distance_meters: 13.3,
    },
];

// --- Tests: computeP95 -----------------------------
describe('computeP95', () => {
    test('returns 0 for empty array', () => {
        expect(computeP95([])).toBe(0);
    });

    test('returns the single value for a one-element array', () => {
        expect(computeP95([42])).toBe(42);
    });

    test('interpolates correctly for 20 elements', () => {
        const data = Array.from({ length: 20 }, (_, i) => i + 1);
        expect(computeP95(data)).toBeCloseTo(19.05, 2);
    });

    test('interpolates correctly for 100 elements', () => {
        // 100 elements: floatIndex = 0.95 * 99 = 94.05
        // interpolated between sorted[94]=95 and sorted[95]=96
        // = 95 * 0.95 + 96 * 0.05 = 95.05
        const data = Array.from({ length: 100 }, (_, i) => i + 1);
        expect(computeP95(data)).toBeCloseTo(95.05, 2);
    });

    test('returns exact value when floatIndex lands on integer', () => {
        // 21 elements: floatIndex = 0.95 * 20 = 19.0
        // weight = 0, so result = sorted[19] = 20
        const data = Array.from({ length: 21 }, (_, i) => i + 1);
        expect(computeP95(data)).toBe(20);
    });

    test('handles two-element array', () => {
        // floatIndex = 0.95 * 1 = 0.95
        // = 100 * 0.05 + 200 * 0.95 = 195
        expect(computeP95([100, 200])).toBe(195);
    });
});

// --- Tests: GET /v1/routes/:id/performance -----------------------------

describe('GET /v1/routes/:id/performance', () => {
    test('returns correct response shape with seeded data', async () => {
        const app = appWithAggregations(seededDeviationResult, seededBunchingResult);
        const res = await request(app).get('/v1/routes/28/performance');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('route_id', '28');
        expect(res.body).toHaveProperty('route_long_name', 'Mattapan Station - Ruggles Station');
        expect(res.body).toHaveProperty('period', 'current');
        expect(res.body).toHaveProperty('deviation');
        expect(res.body).toHaveProperty('bunching');
    });

    test('computes deviation stats correctly', async () => {
        const app = appWithAggregations(seededDeviationResult, seededBunchingResult);
        const res = await request(app).get('/v1/routes/28/performance');

        const dev = res.body.deviation;
        expect(dev.count).toBe(24);
        expect(dev.avg_seconds).toBe(142);
        expect(dev.max_seconds).toBe(520);
        // p95 via linear interpolation: floatIndex = 0.95 * 23 = 21.85
        // sorted[21]=350, sorted[22]=400, weight=0.85
        // = 350 * 0.15 + 400 * 0.85 = 392.5, but IEEE 754 gives 392.499...
        // so Math.round yields 392
        expect(dev.p95_seconds).toBe(392);
        // 15 on-time out of 24 = 62.5%
        expect(dev.vehicles_on_time_pct).toBe(62.5);
    });

    test('computes bunching stats correctly', async () => {
        const app = appWithAggregations(seededDeviationResult, seededBunchingResult);
        const res = await request(app).get('/v1/routes/28/performance');

        const bunch = res.body.bunching;
        expect(bunch.active_events).toBe(2);
        expect(bunch.worst_distance_meters).toBeCloseTo(13.3, 1);
    });

    test('returns zero deviation stats when no deviations match', async () => {
        const app = appWithAggregations([], seededBunchingResult);
        const res = await request(app).get('/v1/routes/nonexistent/performance');

        expect(res.status).toBe(200);
        expect(res.body.deviation).toEqual({
            count: 0,
            avg_seconds: 0,
            p95_seconds: 0,
            max_seconds: 0,
            vehicles_on_time_pct: 0,
        });
        expect(res.body.route_long_name).toBeNull();
    });

    test('returns zero bunching stats when no bunching matches', async () => {
        const app = appWithAggregations(seededDeviationResult, []);
        const res = await request(app).get('/v1/routes/28/performance');

        expect(res.body.bunching).toEqual({
            active_events: 0,
            worst_distance_meters: null,
        });
    });

    test('returns zero stats for all fields when route has no data at all', async () => {
        const app = appWithAggregations([], []);
        const res = await request(app).get('/v1/routes/ghost/performance');

        expect(res.status).toBe(200);
        expect(res.body.route_id).toBe('ghost');
        expect(res.body.route_long_name).toBeNull();
        expect(res.body.deviation.count).toBe(0);
        expect(res.body.bunching.active_events).toBe(0);
        expect(res.body.bunching.worst_distance_meters).toBeNull();
    });

    test('route_id comes from URL param, not from aggregation result', async () => {
        const app = appWithAggregations(seededDeviationResult, seededBunchingResult);
        const res = await request(app).get('/v1/routes/Red/performance');

        expect(res.body.route_id).toBe('Red');
    });

    test('calls aggregate on both collections', async () => {
        const devColl = mockAggregateCollection(seededDeviationResult);
        const bunchColl = mockAggregateCollection(seededBunchingResult);
        const collections = {
            client: { close: vi.fn() },
            deviations: devColl,
            bunching: bunchColl,
        } as unknown as ApiCollections;
        const app = createApp(collections);

        await request(app).get('/v1/routes/28/performance');

        expect(devColl.aggregate).toHaveBeenCalledOnce();
        expect(bunchColl.aggregate).toHaveBeenCalledOnce();
    });

    test('returns 404 when no collections are mounted', async () => {
        const app = createApp(); // no collections → /v1 routes not mounted
        const res = await request(app).get('/v1/routes/28/performance');

        expect(res.status).toBe(404);
    });

    test('returns 500 with sanitized error when aggregation fails', async () => {
        const failingCollections = {
            client: { close: vi.fn() },
            deviations: {
                aggregate: vi.fn().mockReturnValue({
                    toArray: vi.fn().mockRejectedValue(new Error('aggregation failed')),
                }),
            },
            bunching: mockAggregateCollection([]),
        } as unknown as ApiCollections;

        const app = createApp(failingCollections);
        const res = await request(app).get('/v1/routes/28/performance');

        expect(res.status).toBe(500);
        expect(res.body.error).toBeDefined();
    });

    test('returns 400 for route ID with special characters', async () => {
        const app = appWithAggregations(seededDeviationResult, seededBunchingResult);
        const res = await request(app).get('/v1/routes/$injection/performance');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid route ID format');
    });

    test('returns 400 for route ID with spaces', async () => {
        const app = appWithAggregations(seededDeviationResult, seededBunchingResult);
        const res = await request(app).get('/v1/routes/route 28/performance');
        expect(res.status).toBe(400);
    });

    test('returns 400 for empty route ID', async () => {
        const app = appWithAggregations(seededDeviationResult, seededBunchingResult);
        const res = await request(app).get('/v1/routes//performance');
        // Express won't match this route — falls through to 404
        expect(res.status).toBe(404);
    });

    test('accepts numeric route IDs', async () => {
        const app = appWithAggregations(seededDeviationResult, seededBunchingResult);
        const res = await request(app).get('/v1/routes/28/performance');
        expect(res.status).toBe(200);
    });

    test('accepts alphanumeric route IDs with hyphens', async () => {
        const app = appWithAggregations(seededDeviationResult, seededBunchingResult);
        const res = await request(app).get('/v1/routes/Green-D/performance');
        expect(res.status).toBe(200);
    });

    test('on_time_pct rounds to one decimal place', async () => {
        // 1 on-time out of 3 = 33.333...% → 33.3
        const devResult = [
            {
                count: 3,
                avg_abs: 100,
                max_abs: 200,
                all_abs: [50, 100, 200],
                on_time_count: 1,
                route_long_name: null,
            },
        ];
        const app = appWithAggregations(devResult, []);
        const res = await request(app).get('/v1/routes/1/performance');

        expect(res.body.deviation.vehicles_on_time_pct).toBe(33.3);
    });
});
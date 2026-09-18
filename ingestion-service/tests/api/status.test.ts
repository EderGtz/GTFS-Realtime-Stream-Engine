import { describe, test, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { ApiCollections } from '../../src/db/connection.js';

// Silence pino logs during tests
vi.mock('../../src/utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createApp } from '../../src/api/server.js';

// --- Helpers -----------------------------------------------------------

/**
 * Mock MongoDB collection that applies $gte filters from the query.
 * This lets us test the time-window filtering behavior without a real DB.
 */
function mockCollection(docs: Record<string, unknown>[]) {
    return {
        find: vi.fn().mockImplementation((filter: Record<string, unknown>) => {
            let filtered = docs;
            for (const [field, condition] of Object.entries(filter)) {
                if (condition && typeof condition === 'object' && '$gte' in condition) {
                    const cutoff = (condition as Record<string, unknown>)['$gte'] as Date;
                    filtered = filtered.filter((doc) => {
                        const val = doc[field];
                        return val instanceof Date && val >= cutoff;
                    });
                }
            }
            return {
                toArray: vi.fn().mockResolvedValue(filtered),
            };
        }),
    };
}

function appWithCollections(
    deviations: Record<string, unknown>[],
    bunching: Record<string, unknown>[],
): Express {
    const collections = {
        client: { close: vi.fn() },
        deviations: mockCollection(deviations),
        bunching: mockCollection(bunching),
    } as unknown as ApiCollections;
    return createApp(collections);
}

// --- Seed data ---------------------------------------------------------

// Use timestamps 30s ago so they're always within the live window filter.
function recentDate(secondsAgo: number): Date {
    return new Date(Date.now() - secondsAgo * 1000);
}

const seededDeviations = [
    {
        vehicle_id: 'y3227',
        trip_id: 'NorthBase-77',
        kind: 'arrival' as const,
        deviation_seconds: 160,
        scheduled_at: recentDate(90),
        actual_at: recentDate(30),
        location: { type: 'Point', coordinates: [-71.1425, 42.3954] },
        route_id: 'Red',
        route_long_name: 'Red Line',
    },
    {
        vehicle_id: 'y3280',
        trip_id: 'NorthBase-12',
        kind: 'departure' as const,
        deviation_seconds: -45,
        scheduled_at: recentDate(120),
        actual_at: recentDate(60),
        // no location field — should map to null
        // no route_long_name — should map to null
    },
];

const seededBunching = [
    {
        route_id: '57',
        direction_id: 1,
        vehicle_a: 'y3227',
        vehicle_b: 'y3280',
        start_time: recentDate(180),
        end_time: recentDate(30),
        observation_count: 13,
        min_distance_meters: 15.5,
    },
];

// --- Tests -------------------------------------------------------------

describe('GET /v1/status/live', () => {
    test('returns seeded data with correct shape', async () => {
        const app = appWithCollections(seededDeviations, seededBunching);
        const res = await request(app).get('/v1/status/live');

        expect(res.status).toBe(200);
        expect(res.body.delays).toHaveLength(2);
        expect(res.body.bunching).toHaveLength(1);
        expect(res.body.meta.delay_count).toBe(2);
        expect(res.body.meta.bunching_count).toBe(1);
    });

    test('maps deviation documents to delay entries correctly', async () => {
        const app = appWithCollections(seededDeviations, []);
        const res = await request(app).get('/v1/status/live');

        const d0 = res.body.delays[0];
        expect(d0.vehicle_id).toBe('y3227');
        expect(d0.trip_id).toBe('NorthBase-77');
        expect(d0.kind).toBe('arrival');
        expect(d0.deviation_seconds).toBe(160);
        expect(d0.scheduled_at).toBe(seededDeviations[0]!.scheduled_at.toISOString());
        expect(d0.actual_at).toBe(seededDeviations[0]!.actual_at.toISOString());
        expect(d0.location).toEqual({ type: 'Point', coordinates: [-71.1425, 42.3954] });

        // route enrichment fields
        expect(d0.route_id).toBe('Red');
        expect(d0.route_long_name).toBe('Red Line');
        expect(d0.direction_id).toBeNull();
    });

    test('location is null when deviation document has no location', async () => {
        const app = appWithCollections(seededDeviations, []);
        const res = await request(app).get('/v1/status/live');

        expect(res.body.delays[1].location).toBeNull();
    });

    test('route_long_name is null when deviation document has no route_long_name', async () => {
        const app = appWithCollections(seededDeviations, []);
        const res = await request(app).get('/v1/status/live');

        // d1 has no route_long_name in seeded data
        expect(res.body.delays[1].route_long_name).toBeNull();
    });

    test('dates are ISO 8601 strings', async () => {
        const app = appWithCollections(seededDeviations, seededBunching);
        const res = await request(app).get('/v1/status/live');

        expect(res.body.delays[0].scheduled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(res.body.bunching[0].start_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(res.body.meta.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('empty database returns empty arrays, not error', async () => {
        const app = appWithCollections([], []);
        const res = await request(app).get('/v1/status/live');

        expect(res.status).toBe(200);
        expect(res.body.delays).toEqual([]);
        expect(res.body.bunching).toEqual([]);
        expect(res.body.meta.delay_count).toBe(0);
        expect(res.body.meta.bunching_count).toBe(0);
    });

    test('meta.delay_count and meta.bunching_count match array lengths', async () => {
        const app = appWithCollections(seededDeviations, seededBunching);
        const res = await request(app).get('/v1/status/live');

        expect(res.body.meta.delay_count).toBe(res.body.delays.length);
        expect(res.body.meta.bunching_count).toBe(res.body.bunching.length);
    });

    test('filters out stale deviations older than live window', async () => {
        const stale = {
            vehicle_id: 'stale_v',
            trip_id: 'old_trip',
            kind: 'arrival' as const,
            deviation_seconds: 500,
            scheduled_at: recentDate(600),   // 10 min ago
            actual_at: recentDate(600),      // 10 min ago — beyond 3-min window
        };
        const fresh = {
            ...seededDeviations[0],
            actual_at: recentDate(30),        // 30s ago — within window
            scheduled_at: recentDate(90),
        };
        const app = appWithCollections([stale, fresh], []);
        const res = await request(app).get('/v1/status/live');

        expect(res.status).toBe(200);
        expect(res.body.delays).toHaveLength(1);
        expect(res.body.delays[0].vehicle_id).toBe('y3227');
    });

    test('filters out stale bunching events older than live window', async () => {
        const staleBunching = {
            route_id: '57',
            direction_id: 1,
            vehicle_a: 'A',
            vehicle_b: 'B',
            start_time: recentDate(600),
            end_time: recentDate(600),        // 10 min ago — beyond 3-min window
            observation_count: 3,
            min_distance_meters: 20.0,
        };
        const freshBunching = {
            ...seededBunching[0],
            end_time: recentDate(30),         // 30s ago — within window
        };
        const app = appWithCollections([], [staleBunching, freshBunching]);
        const res = await request(app).get('/v1/status/live');

        expect(res.status).toBe(200);
        expect(res.body.bunching).toHaveLength(1);
        expect(res.body.bunching[0].vehicle_a).toBe('y3227');
    });

    test('passes time filter to MongoDB find()', async () => {
        const coll = mockCollection(seededDeviations);
        const collections = {
            client: { close: vi.fn() },
            deviations: coll,
            bunching: mockCollection([]),
        } as unknown as ApiCollections;
        const app = createApp(collections);

        await request(app).get('/v1/status/live');

        // Verify find() was called with a $gte filter on actual_at
        expect(coll.find).toHaveBeenCalledOnce();
        const filter = coll.find.mock.calls[0]![0];
        expect(filter).toHaveProperty('actual_at');
        expect(filter.actual_at).toHaveProperty('$gte');
        expect(filter.actual_at.$gte).toBeInstanceOf(Date);
    });

    test('returns 500 with sanitized error when MongoDB query fails', async () => {
        const failingCollections = {
            client: { close: vi.fn() },
            deviations: {
                find: vi.fn().mockReturnValue({
                    toArray: vi.fn().mockRejectedValue(new Error('connection lost')),
                }),
            },
            bunching: mockCollection([]),
        } as unknown as ApiCollections;

        const app = createApp(failingCollections);
        const res = await request(app).get('/v1/status/live');

        expect(res.status).toBe(500);
        expect(res.body.error).toBeDefined();
    });

    test('returns 404 when no collections are mounted', async () => {
        const app = createApp(); // no collections → /v1 routes not mounted
        const res = await request(app).get('/v1/status/live');

        expect(res.status).toBe(404);
    });
});

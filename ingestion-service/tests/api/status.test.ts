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

function mockCollection(docs: Record<string, unknown>[]) {
    return {
        find: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(docs),
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

const seededDeviations = [
    {
        vehicle_id: 'y3227',
        trip_id: 'NorthBase-77',
        kind: 'arrival' as const,
        deviation_seconds: 160,
        scheduled_at: new Date('2026-09-14T19:15:00Z'),
        actual_at: new Date('2026-09-14T19:17:40Z'),
        location: { type: 'Point', coordinates: [-71.1425, 42.3954] },
    },
    {
        vehicle_id: 'y3280',
        trip_id: 'NorthBase-12',
        kind: 'departure' as const,
        deviation_seconds: -45,
        scheduled_at: new Date('2026-09-14T20:00:00Z'),
        actual_at: new Date('2026-09-14T19:59:15Z'),
        // no location field — should map to null
    },
];

const seededBunching = [
    {
        route_id: '57',
        direction_id: 1,
        vehicle_a: 'y3227',
        vehicle_b: 'y3280',
        start_time: new Date('2026-09-14T20:16:30Z'),
        end_time: new Date('2026-09-14T20:45:45Z'),
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
        expect(d0.scheduled_at).toBe('2026-09-14T19:15:00.000Z');
        expect(d0.actual_at).toBe('2026-09-14T19:17:40.000Z');
        expect(d0.location).toEqual({ type: 'Point', coordinates: [-71.1425, 42.3954] });

        // route_id / direction_id not in deviation docs → null
        expect(d0.route_id).toBeNull();
        expect(d0.direction_id).toBeNull();
    });

    test('location is null when deviation document has no location', async () => {
        const app = appWithCollections(seededDeviations, []);
        const res = await request(app).get('/v1/status/live');

        expect(res.body.delays[1].location).toBeNull();
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

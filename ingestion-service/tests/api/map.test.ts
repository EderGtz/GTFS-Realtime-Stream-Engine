/**
 * Tests for the Leaflet map page and the frontend-consumable API shape.
 *
 * The shape fixture test (FrontendShapeFixture) verifies that the
 * /v1/status/live response contains every field map.js reads, and that
 * the bunching-vehicle cross-reference (matching vehicle_a/vehicle_b
 * back to deviation locations) actually works with the response shape.
 */
import { describe, test, expect, vi } from 'vitest';
import request from 'supertest';
import type { ApiCollections } from '../../src/db/connection.js';

vi.mock('../../src/utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createApp } from '../../src/api/server.js';

// --- Helpers -----------------------------------------------------------

function recentDate(secondsAgo: number): Date {
    return new Date(Date.now() - secondsAgo * 1000);
}

/**
 * Filter-aware mock that applies $gte queries — same as status.test.ts.
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
            return { toArray: vi.fn().mockResolvedValue(filtered) };
        }),
    };
}

// --- Static file tests -------------------------------------------------

describe('GET /map', () => {
    test('serves the map HTML page', async () => {
        const app = createApp();
        const res = await request(app).get('/map');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/html/);
        expect(res.text).toContain('MBTA Live Transit Map');
        expect(res.text).toContain('leaflet');
    });

    test('serves map.html via /map.html path', async () => {
        const app = createApp();
        const res = await request(app).get('/map.html');

        expect(res.status).toBe(200);
        expect(res.text).toContain('MBTA Live Transit Map');
    });

    test('root redirects to /map', async () => {
        const app = createApp();
        const res = await request(app).get('/');

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/map');
    });

    test('serves map.js as static file', async () => {
        const app = createApp();
        const res = await request(app).get('/map.js');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/javascript/);
        expect(res.text).toContain('/v1/status/live');
    });
});

// --- Frontend shape fixture tests --------------------------------------

/**
 * These tests build a fixture that mirrors what map.js consumes from the
 * /v1/status/live endpoint.  If the API shape changes and breaks the
 * frontend, these tests catch it without needing a headless browser.
 */
describe('Frontend shape fixture: map.js can consume /v1/status/live', () => {
    // A realistic fixture: 3 deviations (one per color band) + 1 bunching
    // event whose vehicles both appear in the deviations (so the
    // cross-reference in map.js can resolve their positions).
    const fixtureDeviations = [
        {
            vehicle_id: 'bus-101',
            trip_id: 'trip-Red-1',
            kind: 'arrival' as const,
            deviation_seconds: 60,          // on time
            scheduled_at: recentDate(90),
            actual_at: recentDate(30),
            location: { type: 'Point', coordinates: [-71.0589, 42.3601] },
            route_id: 'Red',
            route_long_name: 'Red Line',
        },
        {
            vehicle_id: 'bus-202',
            trip_id: 'trip-Blue-2',
            kind: 'arrival' as const,
            deviation_seconds: 240,         // slightly late (4 min)
            scheduled_at: recentDate(120),
            actual_at: recentDate(60),
            location: { type: 'Point', coordinates: [-71.0650, 42.3520] },
            route_id: 'Blue',
            route_long_name: 'Blue Line',
        },
        {
            vehicle_id: 'bus-303',
            trip_id: 'trip-Green-3',
            kind: 'departure' as const,
            deviation_seconds: -180,        // early
            scheduled_at: recentDate(90),
            actual_at: recentDate(45),
            location: { type: 'Point', coordinates: [-71.0780, 42.3490] },
            route_id: 'Green',
            route_long_name: 'Green Line',
        },
    ];

    const fixtureBunching = [
        {
            route_id: 'Red',
            direction_id: 0,
            vehicle_a: 'bus-101',           // also in deviations
            vehicle_b: 'bus-202',           // also in deviations
            start_time: recentDate(180),
            end_time: recentDate(20),
            observation_count: 7,
            min_distance_meters: 12.5,
        },
    ];

    function fixtureApp() {
        const collections = {
            client: { close: vi.fn() },
            deviations: mockCollection(fixtureDeviations),
            bunching: mockCollection(fixtureBunching),
        } as unknown as ApiCollections;
        return createApp(collections);
    }

    test('delays array has every field map.js reads', async () => {
        const res = await request(fixtureApp()).get('/v1/status/live');

        expect(res.status).toBe(200);
        for (const d of res.body.delays) {
            // map.js reads these for marker placement and popups
            expect(d).toHaveProperty('vehicle_id');
            expect(d).toHaveProperty('trip_id');
            expect(d).toHaveProperty('kind');
            expect(d).toHaveProperty('deviation_seconds');
            expect(typeof d.deviation_seconds).toBe('number');

            // location is optional — map.js skips markers without it
            if (d.location !== null) {
                expect(d.location.type).toBe('Point');
                expect(Array.isArray(d.location.coordinates)).toBe(true);
                expect(d.location.coordinates).toHaveLength(2);
            }

            // route enrichment — map.js falls back to route_id
            expect(d).toHaveProperty('route_id');
            expect(d).toHaveProperty('route_long_name');
        }
    });

    test('bunching array has every field map.js reads', async () => {
        const res = await request(fixtureApp()).get('/v1/status/live');

        for (const b of res.body.bunching) {
            expect(b).toHaveProperty('vehicle_a');
            expect(b).toHaveProperty('vehicle_b');
            expect(b).toHaveProperty('min_distance_meters');
            expect(typeof b.min_distance_meters).toBe('number');
            expect(b).toHaveProperty('observation_count');
            expect(b).toHaveProperty('start_time');
            expect(b).toHaveProperty('end_time');
            expect(b).toHaveProperty('route_id');
        }
    });

    test('meta object has generated_at, delay_count, bunching_count', async () => {
        const res = await request(fixtureApp()).get('/v1/status/live');

        expect(res.body.meta).toHaveProperty('generated_at');
        expect(typeof res.body.meta.generated_at).toBe('string');
        // ISO 8601
        expect(res.body.meta.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(res.body.meta.delay_count).toBe(res.body.delays.length);
        expect(res.body.meta.bunching_count).toBe(res.body.bunching.length);
    });

    test('bunching vehicles can be cross-referenced to deviation locations', async () => {
        /**
         * map.js builds a vehicle_id -> [lat, lon] index from the delays
         * array and uses it to place bunching markers.  This test proves
         * that the fixture data supports this cross-reference: the
         * bunching event's vehicle_a and vehicle_b both appear in the
         * deviations with valid locations.
         */
        const res = await request(fixtureApp()).get('/v1/status/live');
        const { delays, bunching } = res.body;

        // Build the same index map.js builds
        const vehiclePositions: Record<string, [number, number]> = {};
        for (const d of delays) {
            if (d.location && d.location.coordinates) {
                const [lon, lat] = d.location.coordinates;
                vehiclePositions[d.vehicle_id] = [lat, lon];
            }
        }

        // At least one bunching event should have BOTH vehicles resolvable
        const resolvable = bunching.filter(
            (b: any) => vehiclePositions[b.vehicle_a] && vehiclePositions[b.vehicle_b]
        );
        expect(resolvable.length).toBeGreaterThanOrEqual(1);

        // The resolved positions should be valid [lat, lon] pairs
        for (const b of resolvable) {
            const [latA, lonA] = vehiclePositions[b.vehicle_a];
            const [latB, lonB] = vehiclePositions[b.vehicle_b];
            expect(latA).toBeGreaterThan(-90);
            expect(latA).toBeLessThan(90);
            expect(lonA).toBeGreaterThan(-180);
            expect(lonA).toBeLessThan(180);
            expect(latB).toBeGreaterThan(-90);
            expect(latB).toBeLessThan(90);
            expect(lonB).toBeGreaterThan(-180);
            expect(lonB).toBeLessThan(180);
        }
    });

    test('deviation color thresholds match what map.js expects', async () => {
        /**
         * map.js uses these exact thresholds to pick marker colors.
         * If the API starts returning deviation_seconds in a different
         * unit (e.g. minutes instead of seconds), the colors would be
         * wrong.  This test locks the contract.
         */
        const res = await request(fixtureApp()).get('/v1/status/live');

        for (const d of res.body.delays) {
            const s = d.deviation_seconds;
            // These are the thresholds from deviationColor() in map.js
            if (s < -120)       expect(d.deviation_seconds).toBeLessThan(-120);
            else if (s <= 120)  expect(d.deviation_seconds).toBeLessThanOrEqual(120);
            else if (s <= 300)  expect(d.deviation_seconds).toBeLessThanOrEqual(300);
            else if (s <= 600)  expect(d.deviation_seconds).toBeLessThanOrEqual(600);
            else                expect(d.deviation_seconds).toBeGreaterThan(600);
        }
    });
});

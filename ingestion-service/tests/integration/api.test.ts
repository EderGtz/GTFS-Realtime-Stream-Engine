import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MongoClient } from 'mongodb';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { connectDbWithRetry } from '../../src/db/connection.js';
import { createApp } from '../../src/api/server.js';
import type { ApiCollections } from '../../src/db/connection.js';
import type { Express } from 'express';

// Skip when Docker is not available (CI without Docker socket)
const dockerSock = await import('node:fs')
    .then(fs => fs.existsSync('/var/run/docker.sock'))
    .catch(() => false);

const describeIfDocker = dockerSock ? describe : describe.skip;

const BUNCHING = 'bunching_events';
const DEVIATIONS = 'schedule_deviations';

// Use recent timestamps so the live-window filter doesn't discard them.
function recentDate(secondsAgo: number): Date {
    return new Date(Date.now() - secondsAgo * 1000);
}

const seededDeviations = [
    {
        vehicle_id: 'int-v1',
        trip_id: 'int-trip-1',
        stop_sequence: 5,
        kind: 'arrival',
        deviation_seconds: 120,
        scheduled_at: recentDate(90),
        actual_at: recentDate(30),
        location: { type: 'Point', coordinates: [-71.05, 42.36] },
    },
    {
        vehicle_id: 'int-v2',
        trip_id: 'int-trip-2',
        stop_sequence: 1,
        kind: 'departure',
        deviation_seconds: -30,
        scheduled_at: recentDate(120),
        actual_at: recentDate(60),
        // no location — should come back as null
    },
];

const seededBunching = [
    {
        route_id: 'int-route-1',
        direction_id: 0,
        vehicle_a: 'int-v1',
        vehicle_b: 'int-v2',
        start_time: recentDate(180),
        end_time: recentDate(30),
        observation_count: 8,
        min_distance_meters: 22.3,
    },
];

// ----------------------------------------------------------------------

describeIfDocker('API Integration: /v1/status/live', () => {
    let container: StartedTestContainer;
    let client: MongoClient;
    let app: Express;

    beforeAll(async () => {
        container = await new GenericContainer('mongo:7.0')
            .withExposedPorts(27017)
            .start();

        const uri = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}`;
        client = await connectDbWithRetry(uri);
        const db = client.db('gtfs_realtime_test');

        await db.collection(DEVIATIONS).insertMany(seededDeviations);
        await db.collection(BUNCHING).insertMany(seededBunching);

        const collections: ApiCollections = {
            client,
            bunching: db.collection(BUNCHING),
            deviations: db.collection(DEVIATIONS),
        };
        app = createApp(collections);
    }, 60_000);

    afterAll(async () => {
        await client?.close();
        await container?.stop();
    });

    test('returns seeded deviation data', async () => {
        const res = await request(app).get('/v1/status/live');

        expect(res.status).toBe(200);
        expect(res.body.delays).toHaveLength(2);

        const d0 = res.body.delays.find((d: any) => d.vehicle_id === 'int-v1');
        expect(d0).toBeDefined();
        expect(d0.kind).toBe('arrival');
        expect(d0.deviation_seconds).toBe(120);
        expect(d0.location).toEqual({ type: 'Point', coordinates: [-71.05, 42.36] });
    });

    test('returns seeded bunching data', async () => {
        const res = await request(app).get('/v1/status/live');

        expect(res.body.bunching).toHaveLength(1);
        const b0 = res.body.bunching[0];
        expect(b0.route_id).toBe('int-route-1');
        expect(b0.vehicle_a).toBe('int-v1');
        expect(b0.vehicle_b).toBe('int-v2');
        expect(b0.observation_count).toBe(8);
        expect(b0.min_distance_meters).toBeCloseTo(22.3, 1);
    });

    test('deviation without location maps to null', async () => {
        const res = await request(app).get('/v1/status/live');

        const d2 = res.body.delays.find((d: any) => d.vehicle_id === 'int-v2');
        expect(d2).toBeDefined();
        expect(d2.location).toBeNull();
    });

    test('meta counts match array lengths', async () => {
        const res = await request(app).get('/v1/status/live');

        expect(res.body.meta.delay_count).toBe(res.body.delays.length);
        expect(res.body.meta.bunching_count).toBe(res.body.bunching.length);
        expect(typeof res.body.meta.generated_at).toBe('string');
    });
});

describeIfDocker('API Integration: empty database', () => {
    let container: StartedTestContainer;
    let client: MongoClient;
    let app: Express;

    beforeAll(async () => {
        container = await new GenericContainer('mongo:7.0')
            .withExposedPorts(27017)
            .start();

        const uri = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}`;
        client = await connectDbWithRetry(uri);
        const db = client.db('gtfs_realtime_empty');

        // Collections exist but are empty — no seeding
        const collections: ApiCollections = {
            client,
            bunching: db.collection(BUNCHING),
            deviations: db.collection(DEVIATIONS),
        };
        app = createApp(collections);
    }, 60_000);

    afterAll(async () => {
        await client?.close();
        await container?.stop();
    });

    test('returns empty arrays, not an error', async () => {
        const res = await request(app).get('/v1/status/live');

        expect(res.status).toBe(200);
        expect(res.body.delays).toEqual([]);
        expect(res.body.bunching).toEqual([]);
        expect(res.body.meta.delay_count).toBe(0);
        expect(res.body.meta.bunching_count).toBe(0);
    });
});

describe('API Integration: rate limiting', () => {
    test('returns 429 after exceeding the rate limit', async () => {
        const tightLimiter = rateLimit({
            windowMs: 100,
            limit: 3,
            standardHeaders: 'draft-7',
            legacyHeaders: false,
            message: { error: 'Too many requests, please try again later.' },
        });

        const limitedApp = express();
        limitedApp.use(tightLimiter);
        limitedApp.get('/test', (_req, res) => res.json({ ok: true }));

        for (let i = 0; i < 3; i++) {
            const res = await request(limitedApp).get('/test');
            expect(res.status).toBe(200);
        }

        const limited = await request(limitedApp).get('/test');
        expect(limited.status).toBe(429);
        expect(limited.body.error).toMatch(/too many requests/i);
    });
});

// Route Performance Endpoint Integration Tests

describeIfDocker('API Integration: /v1/routes/:id/performance', () => {
    let container: StartedTestContainer;
    let client: MongoClient;
    let app: Express;

    beforeAll(async () => {
        container = await new GenericContainer('mongo:7.0')
            .withExposedPorts(27017)
            .start();

        const uri = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}`;
        client = await connectDbWithRetry(uri);
        const db = client.db('gtfs_realtime_perf_test');

        // Seed deviations for two different routes to test filtering.
        // Route '28' gets 4 deviation documents; route '1' gets 1.
        await db.collection(DEVIATIONS).insertMany([
            {
                vehicle_id: 'perf-v1', trip_id: 'perf-trip-1',
                stop_sequence: 1, kind: 'arrival',
                deviation_seconds: 120,  // |120| <= 180 → on time
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                location: { type: 'Point', coordinates: [-71.05, 42.36] },
                route_id: '28', route_long_name: 'Mattapan Station - Ruggles Station',
            },
            {
                vehicle_id: 'perf-v2', trip_id: 'perf-trip-2',
                stop_sequence: 1, kind: 'arrival',
                deviation_seconds: 300,  // |300| > 180 → NOT on time
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                route_id: '28', route_long_name: 'Mattapan Station - Ruggles Station',
            },
            {
                vehicle_id: 'perf-v3', trip_id: 'perf-trip-3',
                stop_sequence: 1, kind: 'arrival',
                deviation_seconds: -60,  // |−60| <= 180 → on time
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                route_id: '28', route_long_name: 'Mattapan Station - Ruggles Station',
            },
            {
                vehicle_id: 'perf-v4', trip_id: 'perf-trip-4',
                stop_sequence: 1, kind: 'departure',
                deviation_seconds: 450,  // |450| > 180 → NOT on time
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                route_id: '28', route_long_name: 'Mattapan Station - Ruggles Station',
            },
            // Different route — should NOT appear in route '28' aggregation
            {
                vehicle_id: 'perf-other', trip_id: 'perf-other-trip',
                stop_sequence: 1, kind: 'arrival',
                deviation_seconds: 999,
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                route_id: '1', route_long_name: 'Harvard - Nubian',
            },
        ]);

        // Seed bunching events for route '28'
        await db.collection(BUNCHING).insertMany([
            {
                route_id: '28', direction_id: 0,
                vehicle_a: 'perf-v1', vehicle_b: 'perf-v2',
                start_time: recentDate(180), end_time: recentDate(30),
                observation_count: 10, min_distance_meters: 15.0,
            },
            {
                route_id: '28', direction_id: 1,
                vehicle_a: 'perf-v3', vehicle_b: 'perf-v4',
                start_time: recentDate(180), end_time: recentDate(30),
                observation_count: 5, min_distance_meters: 8.5,
            },
            // Different route
            {
                route_id: '1', direction_id: 0,
                vehicle_a: 'other-a', vehicle_b: 'other-b',
                start_time: recentDate(180), end_time: recentDate(30),
                observation_count: 3, min_distance_meters: 50.0,
            },
        ]);

        const collections: ApiCollections = {
            client,
            bunching: db.collection(BUNCHING),
            deviations: db.collection(DEVIATIONS),
        };
        app = createApp(collections);
    }, 60_000);

    afterAll(async () => {
        await client?.close();
        await container?.stop();
    });

    test('returns correct deviation stats for a specific route', async () => {
        const res = await request(app).get('/v1/routes/28/performance');

        expect(res.status).toBe(200);
        expect(res.body.route_id).toBe('28');

        const dev = res.body.deviation;
        expect(dev.count).toBe(4);  // 4 docs with route_id '28'
        // avg of |120|, |300|, |60|, |450| = 930/4 = 232.5 → 233
        expect(dev.avg_seconds).toBe(233);
        // max of |120|, |300|, |60|, |450| = 450
        expect(dev.max_seconds).toBe(450);
        // 2 on-time (|120| and |60| ≤ 180) out of 4 = 50%
        expect(dev.vehicles_on_time_pct).toBe(50);
    });

    test('returns correct bunching stats for a specific route', async () => {
        const res = await request(app).get('/v1/routes/28/performance');

        const bunch = res.body.bunching;
        expect(bunch.active_events).toBe(2);  // 2 docs with route_id '28'
        expect(bunch.worst_distance_meters).toBeCloseTo(8.5, 1);
    });

    test('filters out other routes', async () => {
        const res = await request(app).get('/v1/routes/1/performance');

        expect(res.status).toBe(200);
        expect(res.body.deviation.count).toBe(1);
        expect(res.body.deviation.avg_seconds).toBe(999);
        expect(res.body.bunching.active_events).toBe(1);
        expect(res.body.bunching.worst_distance_meters).toBeCloseTo(50.0, 1);
    });

    test('returns zero stats for a route that does not exist', async () => {
        const res = await request(app).get('/v1/routes/nonexistent/performance');

        expect(res.status).toBe(200);
        expect(res.body.deviation.count).toBe(0);
        expect(res.body.deviation.avg_seconds).toBe(0);
        expect(res.body.bunching.active_events).toBe(0);
        expect(res.body.bunching.worst_distance_meters).toBeNull();
    });

    test('route_long_name comes from deviation documents', async () => {
        const res = await request(app).get('/v1/routes/28/performance');

        expect(res.body.route_long_name).toBe('Mattapan Station - Ruggles Station');
    });

    test('period is always "current"', async () => {
        const res = await request(app).get('/v1/routes/28/performance');
        expect(res.body.period).toBe('current');
    });
});

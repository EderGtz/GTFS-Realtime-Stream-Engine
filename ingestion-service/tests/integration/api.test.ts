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
import {
    loadGtfsFixture,
    type GtfsFixture,
    type GtfsRow,
} from './gtfsFixtures.js';

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

// ----------------------------------------------------------------------
// Real-world entity values, pulled from the curated GTFS fixtures at
// tests/fixtures/gtfs/ (see its README.md).
// The seeded documents below are shaped exactly like the documents the
// analytics engine writes after enriching deviations from a real feed: real
// route ids and route_long_name values, real trip_id shapes (including MBTA's
// alphanumeric-with-colon style), and real stop coordinates -- including stops
// whose coordinates are blank in the feed, for which enrichment stores no
// location at all.
// ----------------------------------------------------------------------

const mbta = loadGtfsFixture('mbta-2019-07-25');
const wmata = loadGtfsFixture('wmata-2026-04-29');

function routeRow(feed: GtfsFixture, routeId: string): GtfsRow {
    const row = feed.routes.find((r) => r.route_id === routeId);
    if (row === undefined) {
        throw new Error(`fixture ${feed.name} has no route ${routeId}`);
    }
    return row;
}

/** First `count` trip_ids on a route, in stable sorted order. */
function tripsOnRoute(feed: GtfsFixture, routeId: string, count: number): string[] {
    return feed.trips
        .filter((t) => t.route_id === routeId)
        .map((t) => t.trip_id!) // guaranteed by the fixture schema (see README)
        .sort()
        .slice(0, count);
}

/** A real MBTA trip_id containing a colon ("40526281-20:45-BraintreeNQuincyL"
 * style) -- the exact shape that type-inference bugs corrupt. */
function quirkyTripId(feed: GtfsFixture): string {
    const row = feed.trips.find((t) => t.trip_id!.includes(':'));
    if (row === undefined) {
        throw new Error(`fixture ${feed.name} has no alphanumeric trip_id`);
    }
    return row.trip_id!;
}

function stopWithCoordinates(feed: GtfsFixture): GtfsRow {
    const row = feed.stops.find((s) => s.stop_lat !== '' && s.stop_lon !== '');
    if (row === undefined) {
        throw new Error(`fixture ${feed.name} has no stop with coordinates`);
    }
    return row;
}

/** MBTA generic "node-*-platform" stops ship blank coordinates in the real
 * feed; enrichment skips the location for those. */
function stopWithoutCoordinates(feed: GtfsFixture): GtfsRow {
    const row = feed.stops.find((s) => s.stop_lat === '' || s.stop_lon === '');
    if (row === undefined) {
        throw new Error(`fixture ${feed.name} has no coordinate-less stop`);
    }
    return row;
}

const ROUTE_28 = routeRow(mbta, '28');
const ROUTE_1 = routeRow(mbta, '1');
// WMATA's SHUTTLE route ships a genuinely empty route_long_name; the analytics
// engine stores no name for it, so its seeded documents omit the field.
const SHUTTLE = routeRow(wmata, 'SHUTTLE');

const QUIRKY_TRIP = quirkyTripId(mbta);
const ROUTE_28_TRIPS = tripsOnRoute(mbta, '28', 4);
const ROUTE_1_TRIP = tripsOnRoute(mbta, '1', 1)[0]!;
const LOCATED_STOP = stopWithCoordinates(mbta);
const COORDLESS_STOP = stopWithoutCoordinates(mbta);

const LOCATED_STOP_GEOJSON = {
    type: 'Point' as const,
    coordinates: [Number(LOCATED_STOP.stop_lon), Number(LOCATED_STOP.stop_lat)],
};

const seededDeviations = [
    {
        vehicle_id: 'int-v1',
        trip_id: QUIRKY_TRIP,
        stop_sequence: 5,
        kind: 'arrival',
        deviation_seconds: 120,
        scheduled_at: recentDate(90),
        actual_at: recentDate(30),
        location: LOCATED_STOP_GEOJSON,
    },
    {
        vehicle_id: 'int-v2',
        trip_id: ROUTE_28_TRIPS[0]!,
        stop_sequence: 1,
        kind: 'departure',
        deviation_seconds: -30,
        scheduled_at: recentDate(120),
        actual_at: recentDate(60),
        // no location — the real-feed equivalent of a deviation at a stop with
        // blank coordinates (COORDLESS_STOP), which must come back as null
    },
];

const seededBunching = [
    {
        route_id: ROUTE_28.route_id,
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
        expect(d0.location).toEqual(LOCATED_STOP_GEOJSON);
    });

    test('preserves real-world alphanumeric trip_ids verbatim', async () => {
        // MBTA trip_ids like "40526281-20:45-BraintreeNQuincyL" must survive
        // the whole stack as strings (the fixture feed's quirky shape).
        expect(QUIRKY_TRIP).toContain(':');
        const res = await request(app).get('/v1/status/live');
        const d0 = res.body.delays.find((d: any) => d.vehicle_id === 'int-v1');
        expect(d0.trip_id).toBe(QUIRKY_TRIP);
    });

    test('returns seeded bunching data', async () => {
        const res = await request(app).get('/v1/status/live');

        expect(res.body.bunching).toHaveLength(1);
        const b0 = res.body.bunching[0];
        expect(b0.route_id).toBe(ROUTE_28.route_id);
        expect(b0.vehicle_a).toBe('int-v1');
        expect(b0.vehicle_b).toBe('int-v2');
        expect(b0.observation_count).toBe(8);
        expect(b0.min_distance_meters).toBeCloseTo(22.3, 1);
    });

    test('deviation without location maps to null', async () => {
        // Mirrors the real feed: COORDLESS_STOP has blank coordinates, so
        // enrichment never writes a location for deviations there.
        expect(COORDLESS_STOP.stop_lat).toBe('');
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

        // Seed deviations shaped like the analytics engine's enriched output:
        // real MBTA route ids/names and trip_ids, real stop coordinates.
        // Route '28' gets 4 deviation documents; route '1' gets 1.
        await db.collection(DEVIATIONS).insertMany([
            {
                vehicle_id: 'perf-v1', trip_id: ROUTE_28_TRIPS[0]!,
                stop_sequence: 1, kind: 'arrival',
                deviation_seconds: 120,  // |120| <= 180 → on time
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                location: LOCATED_STOP_GEOJSON,
                route_id: ROUTE_28.route_id,
                route_long_name: ROUTE_28.route_long_name,
            },
            {
                vehicle_id: 'perf-v2', trip_id: ROUTE_28_TRIPS[1]!,
                stop_sequence: 1, kind: 'arrival',
                deviation_seconds: 300,  // |300| > 180 → NOT on time
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                route_id: ROUTE_28.route_id,
                route_long_name: ROUTE_28.route_long_name,
            },
            {
                vehicle_id: 'perf-v3', trip_id: ROUTE_28_TRIPS[2]!,
                stop_sequence: 1, kind: 'arrival',
                deviation_seconds: -60,  // |−60| <= 180 → on time
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                route_id: ROUTE_28.route_id,
                route_long_name: ROUTE_28.route_long_name,
            },
            {
                vehicle_id: 'perf-v4', trip_id: ROUTE_28_TRIPS[3]!,
                stop_sequence: 1, kind: 'departure',
                deviation_seconds: 450,  // |450| > 180 → NOT on time
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                route_id: ROUTE_28.route_id,
                route_long_name: ROUTE_28.route_long_name,
            },
            // Different route — should NOT appear in route '28' aggregation
            {
                vehicle_id: 'perf-other', trip_id: ROUTE_1_TRIP,
                stop_sequence: 1, kind: 'arrival',
                deviation_seconds: 999,
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                route_id: ROUTE_1.route_id,
                route_long_name: ROUTE_1.route_long_name,
            },
            // WMATA's SHUTTLE route has an empty route_long_name in the real
            // feed, so the analytics engine stores no route_long_name field on
            // its deviations at all.
            {
                vehicle_id: 'perf-shuttle', trip_id: tripsOnRoute(wmata, 'SHUTTLE', 1)[0]!,
                stop_sequence: 1, kind: 'arrival',
                deviation_seconds: 60,
                scheduled_at: recentDate(90), actual_at: recentDate(30),
                route_id: SHUTTLE.route_id,
            },
        ]);

        // Seed bunching events for route '28'
        await db.collection(BUNCHING).insertMany([
            {
                route_id: ROUTE_28.route_id, direction_id: 0,
                vehicle_a: 'perf-v1', vehicle_b: 'perf-v2',
                start_time: recentDate(180), end_time: recentDate(30),
                observation_count: 10, min_distance_meters: 15.0,
            },
            {
                route_id: ROUTE_28.route_id, direction_id: 1,
                vehicle_a: 'perf-v3', vehicle_b: 'perf-v4',
                start_time: recentDate(180), end_time: recentDate(30),
                observation_count: 5, min_distance_meters: 8.5,
            },
            // Different route
            {
                route_id: ROUTE_1.route_id, direction_id: 0,
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
        expect(res.body.route_id).toBe(ROUTE_28.route_id);

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

        expect(res.body.route_long_name).toBe(ROUTE_28.route_long_name);
    });

    test('route with an empty route_long_name in the feed comes back as null', async () => {
        // The real WMATA feed ships SHUTTLE with an empty route_long_name, so
        // enriched deviation documents carry no name for it at all. The API
        // must answer with null, not "" and not a 404/500.
        expect(SHUTTLE.route_long_name).toBe('');

        const res = await request(app).get('/v1/routes/SHUTTLE/performance');

        expect(res.status).toBe(200);
        expect(res.body.route_id).toBe(SHUTTLE.route_id);
        expect(res.body.deviation.count).toBe(1);
        expect(res.body.route_long_name).toBeNull();
    });

    test('period is always "current"', async () => {
        const res = await request(app).get('/v1/routes/28/performance');

        expect(res.body.period).toBe('current');
    });
});

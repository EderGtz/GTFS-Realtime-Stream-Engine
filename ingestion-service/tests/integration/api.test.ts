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

const seededDeviations = [
    {
        vehicle_id: 'int-v1',
        trip_id: 'int-trip-1',
        stop_sequence: 5,
        kind: 'arrival',
        deviation_seconds: 120,
        scheduled_at: new Date('2026-09-14T19:00:00Z'),
        actual_at: new Date('2026-09-14T19:02:00Z'),
        location: { type: 'Point', coordinates: [-71.05, 42.36] },
    },
    {
        vehicle_id: 'int-v2',
        trip_id: 'int-trip-2',
        stop_sequence: 1,
        kind: 'departure',
        deviation_seconds: -30,
        scheduled_at: new Date('2026-09-14T20:00:00Z'),
        actual_at: new Date('2026-09-14T19:59:30Z'),
        // no location — should come back as null
    },
];

const seededBunching = [
    {
        route_id: 'int-route-1',
        direction_id: 0,
        vehicle_a: 'int-v1',
        vehicle_b: 'int-v2',
        start_time: new Date('2026-09-14T19:30:00Z'),
        end_time: new Date('2026-09-14T19:45:00Z'),
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

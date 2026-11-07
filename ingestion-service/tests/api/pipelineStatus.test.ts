import { describe, test, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { ApiCollections } from '../../src/db/connection.js';

// Silence pino logs during tests
vi.mock('../../src/utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createApp } from '../../src/api/server.js';

// --- Helpers -----------------------------------------------------------

function appWithStatusDoc(doc: Record<string, unknown> | null): Express {
    const collections = {
        client: { close: vi.fn() },
        deviations: { find: vi.fn() },
        bunching: { find: vi.fn() },
        pipelineStatus: {
            findOne: vi.fn().mockResolvedValue(doc),
        },
    } as unknown as ApiCollections;
    return createApp(collections);
}

function secondsAgo(seconds: number): Date {
    return new Date(Date.now() - seconds * 1000);
}

const matchingCounts = {
    total_pings: 100,
    matched_pings: 95,
    missing_field_pings: 3,
    unmatched_pings: 2,
    gate_dropped_events: 1,
    matched_ratio: 0.95,
};

const healthyDoc = {
    reported_at: secondsAgo(10),
    window_total_records: 120,
    alerts: [],
    last_message_at: secondsAgo(15),
    consumer_lag_messages: 3,
    last_static_reload_at: secondsAgo(3600),
    static_bundle_version: 'feed-v1',
    matching: {
        last_window: matchingCounts,
        cumulative: { ...matchingCounts, total_pings: 1000, matched_pings: 950 },
    },
};

beforeEach(() => {
    vi.clearAllMocks();
});

// --- Tests -------------------------------------------------------------

describe('GET /v1/pipeline/status', () => {
    test('projects the analytics pipeline_status document with computed ages', async () => {
        const app = appWithStatusDoc(healthyDoc);
        const res = await request(app).get('/v1/pipeline/status');

        expect(res.status).toBe(200);
        expect(res.body.window_total_records).toBe(120);
        expect(res.body.consumer_lag_messages).toBe(3);
        expect(res.body.static_bundle_version).toBe('feed-v1');
        expect(res.body.last_static_reload_at).toBe(healthyDoc.last_static_reload_at.toISOString());

        // Ages are computed at read time — assert ranges, not exact values.
        expect(res.body.status_age_seconds).toBeGreaterThanOrEqual(9);
        expect(res.body.status_age_seconds).toBeLessThanOrEqual(12);
        expect(res.body.last_message_age_seconds).toBeGreaterThanOrEqual(14);
        expect(res.body.last_message_age_seconds).toBeLessThanOrEqual(17);

        //   counters pass through (last window + cumulative).
        expect(res.body.matching.last_window).toEqual(matchingCounts);
        expect(res.body.matching.cumulative.total_pings).toBe(1000);
    });

    test('surfaces alerts and tolerates missing optional fields', async () => {
        const app = appWithStatusDoc({
            reported_at: secondsAgo(5),
            window_total_records: 0,
            alerts: ['matched-ping ratio 12% below 50% for 30 min'],
        });
        const res = await request(app).get('/v1/pipeline/status');

        expect(res.status).toBe(200);
        expect(res.body.alerts).toEqual(['matched-ping ratio 12% below 50% for 30 min']);
        expect(res.body.last_message_at).toBeNull();
        expect(res.body.last_message_age_seconds).toBeNull();
        expect(res.body.consumer_lag_messages).toBeNull();
        expect(res.body.matching).toBeNull();
    });

    test('a stale document shows up as a growing status_age_seconds', async () => {
        const app = appWithStatusDoc({ ...healthyDoc, reported_at: secondsAgo(600) });
        const res = await request(app).get('/v1/pipeline/status');

        expect(res.status).toBe(200);
        expect(res.body.status_age_seconds).toBeGreaterThanOrEqual(599);
    });

    test('returns 503 when the analytics engine has never reported', async () => {
        const app = appWithStatusDoc(null);
        const res = await request(app).get('/v1/pipeline/status');

        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/analytics engine has not written/);
    });

    test('is not mounted without MongoDB collections', async () => {
        const app = createApp();
        const res = await request(app).get('/v1/pipeline/status');

        expect(res.status).toBe(404);
    });
});

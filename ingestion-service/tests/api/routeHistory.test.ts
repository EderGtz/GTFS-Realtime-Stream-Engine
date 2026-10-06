import { describe, test, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type pg from 'pg';
import { createRouteHistoryRouter } from '../../src/api/routes/routeHistory.js';

/**
 * Tests for GET /v1/routes/:id/history.
 * Uses a mock pg.Pool — no live PostgreSQL required.
 */

function makeMockPool(rows: any[] = []): { pool: pg.Pool; queryMock: ReturnType<typeof vi.fn> } {
    const queryMock = vi.fn().mockResolvedValue({ rows });
    const pool = { query: queryMock } as unknown as pg.Pool;
    return { pool, queryMock };
}

function makeApp(pool: pg.Pool) {
    const app = express();
    app.use('/v1', createRouteHistoryRouter(pool));
    return app;
}

const sampleRows = [
    {
        hour: '2026-10-05T10:00:00.000Z',
        avg_deviation: 120.5,
        p95_deviation: 350.0,
        vehicle_count: 18,
        on_time_pct: 72.2,
        bunching_events: 2,
    },
    {
        hour: '2026-10-05T11:00:00.000Z',
        avg_deviation: 95.0,
        p95_deviation: 280.0,
        vehicle_count: 22,
        on_time_pct: 81.8,
        bunching_events: 0,
    },
];

describe('GET /v1/routes/:id/history', () => {
    test('returns history data for a valid route', async () => {
        const { pool } = makeMockPool(sampleRows);
        const app = makeApp(pool);

        const res = await request(app).get('/v1/routes/28/history?days=7');

        expect(res.status).toBe(200);
        expect(res.body.route_id).toBe('28');
        expect(res.body.days).toBe(7);
        expect(res.body.data_points).toHaveLength(2);
        expect(res.body.data_points[0].on_time_pct).toBe(72.2);
        expect(res.body.data_points[0].hour).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('returns empty array when no data exists', async () => {
        const { pool } = makeMockPool([]);
        const app = makeApp(pool);

        const res = await request(app).get('/v1/routes/28/history?days=7');

        expect(res.status).toBe(200);
        expect(res.body.data_points).toEqual([]);
    });

    test('rejects invalid route ID format', async () => {
        const { pool } = makeMockPool();
        const app = makeApp(pool);

        const res = await request(app).get('/v1/routes/<script>/history');

        expect(res.status).toBe(400);
    });

    test('defaults to 7 days when days param is missing', async () => {
        const { pool, queryMock } = makeMockPool([]);
        const app = makeApp(pool);

        const res = await request(app).get('/v1/routes/28/history');

        expect(res.status).toBe(200);
        expect(res.body.days).toBe(7);
        // Verify the query received 7 as the days value
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('$2'),
            ['28', '7'],
        );
    });

    test('clamps days to maximum of 90', async () => {
        const { pool } = makeMockPool([]);
        const app = makeApp(pool);

        const res = await request(app).get('/v1/routes/28/history?days=999');

        expect(res.status).toBe(200);
        expect(res.body.days).toBe(90);
    });

    test('falls back to 7 for non-numeric days', async () => {
        const { pool } = makeMockPool([]);
        const app = makeApp(pool);

        const res = await request(app).get('/v1/routes/28/history?days=abc');

        expect(res.status).toBe(200);
        expect(res.body.days).toBe(7);
    });

    test('falls back to 7 for negative days', async () => {
        const { pool } = makeMockPool([]);
        const app = makeApp(pool);

        const res = await request(app).get('/v1/routes/28/history?days=-5');

        expect(res.status).toBe(200);
        expect(res.body.days).toBe(7);
    });

    test('rounds numeric fields correctly', async () => {
        const { pool } = makeMockPool([
            {
                hour: '2026-10-05T10:00:00.000Z',
                avg_deviation: 123.456,
                p95_deviation: 350.789,
                vehicle_count: 18,
                on_time_pct: 72.256,
                bunching_events: 2,
            },
        ]);
        const app = makeApp(pool);

        const res = await request(app).get('/v1/routes/28/history?days=7');

        expect(res.body.data_points[0].avg_deviation).toBe(123.5); // rounded to 1 decimal
        expect(res.body.data_points[0].p95_deviation).toBe(351);    // rounded to integer
        expect(res.body.data_points[0].on_time_pct).toBe(72.3);     // rounded to 1 decimal
    });

    test('calls query with correct SQL shape', async () => {
        const { pool, queryMock } = makeMockPool([]);
        const app = makeApp(pool);

        await request(app).get('/v1/routes/Red/history?days=3');

        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('route_hourly_stats');
        expect(sql).toContain('route_id');
        expect(sql).toContain('hour >=');
        expect(params).toEqual(['Red', '3']);
    });
});

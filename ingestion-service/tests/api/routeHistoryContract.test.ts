import { describe, test, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { createRouteHistoryRouter } from '../../src/api/routes/routeHistory.js';

/**
 * Contract test: the API side of GET /v1/routes/:id/history.
 *
 * Validates against tests/contracts/route_hourly_stats.json — the same file
 * the analytics engine validates its schema against
 * (analytics-engine/tests/test_schema_contract.py). If the SQL or response
 * shape drifts from the route_hourly_stats table, this fails.
 */

const contract = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../tests/contracts/route_hourly_stats.json'), 'utf8'),
);

function makeMockPool(rows: any[]): pg.Pool {
    return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as pg.Pool;
}

describe('route_hourly_stats contract', () => {
    test('SQL selects exactly the contract columns', () => {
        const source = readFileSync(
            join(import.meta.dirname, '../../src/api/routes/routeHistory.ts'),
            'utf8',
        );
        const sqlMatch = source.match(/SELECT([\s\S]*?)FROM route_hourly_stats/);
        expect(sqlMatch).not.toBeNull();

        const selected = sqlMatch![1]!
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c.length > 0);

        expect(selected).toEqual(contract.history_select_columns);
    });

    test('response shape matches the contract', async () => {
        // Build a row from the contract fields so a renamed/missing field
        // cannot silently pass.
        const row: Record<string, unknown> = {
            hour: '2026-10-05T10:00:00.000Z',
            avg_deviation: 120.5,
            p95_deviation: 350.0,
            vehicle_count: 18,
            on_time_pct: 72.2,
            bunching_events: 2,
        };
        const pool = makeMockPool([row]);
        const app = express();
        app.use('/v1', createRouteHistoryRouter(pool));

        const res = await request(app).get('/v1/routes/28/history?days=7');

        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(
            [...contract.history_response_fields].sort(),
        );
        expect(Object.keys(res.body.data_points[0]).sort()).toEqual(
            [...contract.history_datapoint_fields].sort(),
        );
    });
});

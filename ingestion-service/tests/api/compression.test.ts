import { describe, test, expect, vi } from 'vitest';
import request from 'supertest';
import type { ApiCollections } from '../../src/db/connection.js';

// Silence pino logs during tests
vi.mock('../../src/utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createApp } from '../../src/api/server.js';

// --- Helpers -----------------------------------------------------------

/** Minimal mock collection — enough to build a large /v1/status/live body. */
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
) {
    const collections = {
        client: { close: vi.fn() },
        deviations: mockCollection(deviations),
        bunching: mockCollection(bunching),
    } as unknown as ApiCollections;
    return createApp(collections);
}

/** ~40 deviation docs → JSON body well over the 1 KB compression threshold. */
function largeDeviationSet(): Record<string, unknown>[] {
    return Array.from({ length: 40 }, (_, i) => ({
        vehicle_id: `y${3000 + i}`,
        trip_id: `Trip-${i}`,
        kind: 'arrival',
        deviation_seconds: 30 + i,
        scheduled_at: new Date(),
        actual_at: new Date(),
        location: { type: 'Point', coordinates: [-71.1425, 42.3954] },
        route_id: 'Red',
        route_long_name: 'Red Line',
    }));
}

// --- Tests -------------------------------------------------------------

describe('compression middleware', () => {
    test('gzip-compresses JSON responses over 1 KB when the client accepts gzip', async () => {
        const app = appWithCollections(largeDeviationSet(), []);
        const res = await request(app)
            .get('/v1/status/live')
            .set('Accept-Encoding', 'gzip');

        expect(res.status).toBe(200);
        expect(res.headers['content-encoding']).toBe('gzip');
        // Vary keeps any future edge cache correct across encodings.
        expect(res.headers['vary']).toMatch(/accept-encoding/i);
    });

    test('leaves small responses uncompressed (below threshold)', async () => {
        const app = appWithCollections([], []);
        const res = await request(app)
            .get('/health')
            .set('Accept-Encoding', 'gzip');

        expect(res.status).toBe(200);
        expect(res.headers['content-encoding']).toBeUndefined();
    });

    test('serves identity when the client does not accept gzip', async () => {
        const app = appWithCollections(largeDeviationSet(), []);
        const res = await request(app)
            .get('/v1/status/live')
            .set('Accept-Encoding', 'identity');

        expect(res.status).toBe(200);
        expect(res.headers['content-encoding']).toBeUndefined();
    });
});

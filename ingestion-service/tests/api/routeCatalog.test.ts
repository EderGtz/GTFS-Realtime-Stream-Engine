import { describe, test, expect, vi, afterEach } from 'vitest';
import type pg from 'pg';
import type { ApiCollections } from '../../src/db/connection.js';
import {
    createRouteResolver,
    identityResolver,
} from '../../src/api/routeCatalog.js';

vi.mock('../../src/utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

/**
 * Tests for the case-insensitive route-ID catalog/resolver.
 * Pure mocks — no live MongoDB or PostgreSQL required.
 */

function mockCollections(distinctIds: string[]): ApiCollections {
    return {
        client: { close: vi.fn() },
        deviations: { distinct: vi.fn().mockResolvedValue(distinctIds) },
        bunching: { distinct: vi.fn().mockResolvedValue(distinctIds) },
    } as unknown as ApiCollections;
}

function mockPgPool(routeIds: string[]): pg.Pool {
    return {
        query: vi.fn().mockResolvedValue({
            rows: routeIds.map((route_id) => ({ route_id })),
        }),
    } as unknown as pg.Pool;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('createRouteResolver', () => {
    test('resolves any casing to the canonical ID', async () => {
        const resolve = createRouteResolver({
            collections: mockCollections(['Orange', 'Green-B', 'CR-Providence', '34E']),
        });

        await expect(resolve('orange')).resolves.toBe('Orange');
        await expect(resolve('GREEN-b')).resolves.toBe('Green-B');
        await expect(resolve('cr-providence')).resolves.toBe('CR-Providence');
        await expect(resolve('34e')).resolves.toBe('34E');
    });

    test('passes canonical IDs through unchanged', async () => {
        const resolve = createRouteResolver({
            collections: mockCollections(['Red', '28']),
        });

        await expect(resolve('Red')).resolves.toBe('Red');
        await expect(resolve('28')).resolves.toBe('28');
    });

    test('returns null for unknown route IDs', async () => {
        const resolve = createRouteResolver({
            collections: mockCollections(['Orange']),
        });

        await expect(resolve('sl1')).resolves.toBeNull();
        await expect(resolve('vehicle-1234')).resolves.toBeNull();
    });

    test('unions Mongo and PostgreSQL sources', async () => {
        const resolve = createRouteResolver({
            collections: mockCollections(['Orange']),
            pgPool: mockPgPool(['Red']),
        });

        await expect(resolve('orange')).resolves.toBe('Orange');
        await expect(resolve('red')).resolves.toBe('Red');
    });

    test('serves the catalog from cache until the TTL expires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
        const collections = mockCollections(['Orange']);
        const resolve = createRouteResolver({ collections });

        await resolve('orange');
        await resolve('orange');
        expect(collections.deviations.distinct).toHaveBeenCalledTimes(1);

        // Past the 5-minute TTL: one rebuild, then cached again.
        vi.setSystemTime(new Date('2026-11-24T12:06:00Z'));
        await resolve('orange');
        await resolve('orange');
        expect(collections.deviations.distinct).toHaveBeenCalledTimes(2);
    });

    test('keeps working from one source when the other fails', async () => {
        const resolve = createRouteResolver({
            collections: {
                client: { close: vi.fn() },
                deviations: {
                    distinct: vi.fn().mockRejectedValue(new Error('mongo down')),
                },
                bunching: { distinct: vi.fn().mockRejectedValue(new Error('mongo down')) },
            } as unknown as ApiCollections,
            pgPool: mockPgPool(['Red']),
        });

        await expect(resolve('red')).resolves.toBe('Red');
    });

    test('throws when every source fails (500, never a silent 404)', async () => {
        const resolve = createRouteResolver({
            collections: {
                client: { close: vi.fn() },
                deviations: {
                    distinct: vi.fn().mockRejectedValue(new Error('mongo down')),
                },
                bunching: { distinct: vi.fn().mockRejectedValue(new Error('mongo down')) },
            } as unknown as ApiCollections,
            pgPool: {
                query: vi.fn().mockRejectedValue(new Error('pg down')),
            } as unknown as pg.Pool,
        });

        await expect(resolve('Red')).rejects.toThrow();
    });
});

describe('identityResolver', () => {
    test('passes input through and never reports unknown IDs', async () => {
        await expect(identityResolver('orange')).resolves.toBe('orange');
        await expect(identityResolver('<script>')).resolves.toBe('<script>');
    });
});

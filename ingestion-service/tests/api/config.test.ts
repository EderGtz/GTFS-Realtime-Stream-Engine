import { describe, test, expect, vi, afterEach } from 'vitest';

/**
 * B7: the poller entry point must start without MONGO_URI/PG_DSN — the
 * config module used to envOrThrow them at module load, so every entry
 * point required every variable. DB config is lazy now (getters); the
 * non-DB sections are always safe to read.
 */

const savedEnv = {
    mongo: process.env.MONGO_URI,
    pg: process.env.PG_DSN,
};

afterEach(() => {
    vi.resetModules();
    if (savedEnv.mongo === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = savedEnv.mongo;
    if (savedEnv.pg === undefined) delete process.env.PG_DSN;
    else process.env.PG_DSN = savedEnv.pg;
});

describe('config lazy DB sections (B7)', () => {
    test('non-DB sections work without MONGO_URI/PG_DSN', async () => {
        process.env.MONGO_URI = '';
        process.env.PG_DSN = '';
        vi.resetModules();
        const { config } = await import('../../src/config.js');

        expect(config.kafka.brokers).toHaveLength(1);
        expect(config.mbta.vehiclePositionsUrl).toContain('https://');
        expect(typeof config.healthcheck.pingUrl).toBe('string');
        expect(typeof config.api.port).toBe('number');
    });

    test('touching config.mongo without MONGO_URI throws', async () => {
        process.env.MONGO_URI = '';
        vi.resetModules();
        const { config } = await import('../../src/config.js');

        expect(() => config.mongo).toThrow(/MONGO_URI/);
    });

    test('touching config.pg without PG_DSN throws', async () => {
        process.env.PG_DSN = '';
        vi.resetModules();
        const { config } = await import('../../src/config.js');

        expect(() => config.pg).toThrow(/PG_DSN/);
    });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';

describe('config env loading', () => {
    beforeEach(() => {
        vi.resetModules();
        
        // Fake env values
        vi.stubEnv('KAFKA_BROKER', 'localhost:9092');
    });

    test('loads the .env file when the config module is imported', async () => {
        const { config } = await import('../src/config.js');

        expect(config.kafka.brokers).toEqual(['localhost:9092']);
    });
});

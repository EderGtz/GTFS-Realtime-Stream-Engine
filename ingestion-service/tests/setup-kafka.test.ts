import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { publishTelemetries, setupKafka, disconnectKafka } from '../src/ingestion/producer.js';

const { 
    mockSend, 
    mockConnect,
    mockProducerConnect,
    mockProducerDisconnect,
    mockAdminConnect,
    mockAdminDisconnect,
    mockCreateTopics
} = vi.hoisted(() => ({
    mockSend: vi.fn(),
    mockConnect: vi.fn(),
    mockProducerConnect: vi.fn(),
    mockProducerDisconnect: vi.fn(),
    mockAdminConnect: vi.fn(),
    mockAdminDisconnect: vi.fn(),
    mockCreateTopics: vi.fn(),
}));

vi.mock('kafkajs', () => {
    return {
        Kafka: class {
            producer() {
                return {
                    connect: mockProducerConnect,
                    send: mockSend,
                    disconnect: mockProducerDisconnect,
                };
            }
            admin() {
                return {
                    connect: mockAdminConnect,
                    listTopics: vi.fn().mockResolvedValue([]),
                    createTopics: mockCreateTopics,
                    disconnect: mockAdminDisconnect,
                };
            }
        },
        Partitioners: {
            DefaultPartitioner: vi.fn()
        }
    };
});

vi.mock('../src/config.js', () => ({
    config: {
        mbta: { vehiclePositionsUrl: 'https://fake.test/VehiclePositions.pb' },
        kafka: { brokers: ['fake-broker:9092'], topic: 'raw.vehicle-positions', numPartitions: 4 },
    },
}));

vi.mock('../src/utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

describe('producer > setupKafka', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAdminConnect.mockResolvedValue(undefined);
        mockProducerConnect.mockResolvedValue(undefined);
        mockCreateTopics.mockResolvedValue(true);
    });

    afterEach(async () => {
        await disconnectKafka();
    });

    test('creates the topic with the configured partition count', async () => {
        await setupKafka();

        expect(mockCreateTopics).toHaveBeenCalledWith({
            topics: [{
                topic: 'raw.vehicle-positions',
                numPartitions: 4,
                replicationFactor: 1,
            }],
        });
    });

    test('connects both admin and producer clients', async () => {
        await setupKafka();

        expect(mockAdminConnect).toHaveBeenCalledTimes(1);
        expect(mockProducerConnect).toHaveBeenCalledTimes(1);
    });

    test('disconnects the admin client even if createTopics throws', async () => {
        mockCreateTopics.mockRejectedValue(new Error('broker unavailable'));

        await expect(setupKafka()).rejects.toThrow('broker unavailable');
        expect(mockAdminDisconnect).toHaveBeenCalledTimes(1);
    });

    test('retries admin.connect on transient failure and eventually succeeds', async () => {
        vi.useFakeTimers();
        mockAdminConnect
            .mockRejectedValueOnce(new Error('coordinator loading'))
            .mockResolvedValueOnce(undefined);

        const setupPromise = setupKafka();
        await vi.runAllTimersAsync();
        await setupPromise;

        expect(mockAdminConnect).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });

    test('throws after exhausting all retry attempts', async () => {
        vi.useFakeTimers();
        mockAdminConnect.mockRejectedValue(new Error('still down'));

        const setupPromise = setupKafka();
        const assertion = expect(setupPromise).rejects.toThrow('still down');
        await vi.runAllTimersAsync();
        await assertion;

        expect(mockAdminConnect).toHaveBeenCalledTimes(5); // matches your `attempts = 5` default
        vi.useRealTimers();
    });
});

describe('producer > disconnectKafka', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAdminConnect.mockResolvedValue(undefined);
        mockProducerConnect.mockResolvedValue(undefined);
        mockCreateTopics.mockResolvedValue(true);
    });

    test('disconnects the producer if it was connected via setupKafka', async () => {
        await setupKafka();
        await disconnectKafka();

        expect(mockProducerDisconnect).toHaveBeenCalledTimes(1);
    });

    test('does nothing if the producer was never connected', async () => {
        await disconnectKafka();
        expect(mockProducerDisconnect).not.toHaveBeenCalled();
    });
});
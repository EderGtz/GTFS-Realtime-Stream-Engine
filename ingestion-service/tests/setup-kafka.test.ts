import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTopics, setupKafka, disconnectKafka } from '../src/ingestion/producer.js';

const { 
    mockProducerConnect, 
    mockProducerDisconnect,
    mockAdminConnect, 
    mockAdminListTopics, 
    mockAdminCreateTopics, 
    mockAdminDisconnect,
} = vi.hoisted(() => ({
    mockProducerConnect: vi.fn(),
    mockProducerDisconnect: vi.fn(),
    mockAdminConnect: vi.fn(),
    mockAdminListTopics: vi.fn(),
    mockAdminCreateTopics: vi.fn(),
    mockAdminDisconnect: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
}));

vi.mock('kafkajs', () => ({
    Kafka: class {
        producer() {
            return {
                connect: mockProducerConnect,
                send: vi.fn(),
                disconnect: mockProducerDisconnect,
            };
        }
        admin() {
            return {
                connect: mockAdminConnect,
                listTopics: mockAdminListTopics,
                createTopics: mockAdminCreateTopics,
                disconnect: mockAdminDisconnect,
            };
        }
    },
    Partitioners: { DefaultPartitioner: vi.fn() }
}));

vi.mock('../src/config.js', () => ({
    config: {
        mbta: { vehiclePositionsUrl: 'https://fake.test/VehiclePositions.pb' },
        kafka: { brokers: ['fake-broker:9092'], topic: 'raw.vehicle-positions', numPartitions: 4 },
    },
}));

vi.mock('../src/utils/logger.js', () => ({ logger: mockLogger }));

describe('setupTopics', () => {
    const admin = {
        listTopics: mockAdminListTopics,
        createTopics: mockAdminCreateTopics,
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockAdminCreateTopics.mockResolvedValue(undefined);
    });

    test('creates the topic when it does not exist', async () => {
        mockAdminListTopics.mockResolvedValue([]);
        await setupTopics(admin);

        expect(mockAdminCreateTopics).toHaveBeenCalledWith({
            topics: [{ 
                topic: 'raw.vehicle-positions', 
                numPartitions: 4, 
                replicationFactor: 1 
            }],
        });
        expect(mockLogger.info).toHaveBeenCalledWith("Topic 'raw.vehicle-positions' created.");
    });

    test('does not create the topic when it already exists', async () => {
        mockAdminListTopics.mockResolvedValue(['raw.vehicle-positions']);
        await setupTopics(admin);

        expect(mockAdminCreateTopics).not.toHaveBeenCalled();
        expect(mockLogger.info).toHaveBeenCalledWith(
            "Topic 'raw.vehicle-positions' already exists."
        );
    });

        // Errors
    test('propagate errors when calling listTopics', async () => {
        const kafkaError = new Error('Kafka unavailable by the moment: connection rejected');
        
        mockAdminListTopics.mockRejectedValue(kafkaError);

        await expect(setupTopics(admin)).rejects.toThrow(
            'Kafka unavailable by the moment: connection rejected',
        );
        expect(mockAdminCreateTopics).not.toHaveBeenCalled();
    });

    test('propagate errors when calling createTopics', async () => {
        const kafkaError = new Error('Could not create topic: connection rejected');
        
        mockAdminListTopics.mockResolvedValue([]);
        mockAdminCreateTopics.mockRejectedValue(kafkaError);

        await expect(setupTopics(admin)).rejects.toThrow(
            'Could not create topic: connection rejected',
        );
    });
});

describe('setupKafka', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAdminConnect.mockResolvedValue(undefined);
        mockAdminListTopics.mockResolvedValue([]);
        mockAdminCreateTopics.mockResolvedValue(undefined);
        mockAdminDisconnect.mockResolvedValue(undefined);
        mockProducerConnect.mockResolvedValue(undefined);
    });

    test('connects the admin, sets up topics, disconnects admin, then connects producer', 
        async () => {

        await setupKafka();

        expect(mockAdminConnect).toHaveBeenCalledTimes(1);
        expect(mockAdminListTopics).toHaveBeenCalledTimes(1);
        expect(mockAdminDisconnect).toHaveBeenCalledTimes(1);
        expect(mockProducerConnect).toHaveBeenCalledTimes(1);
        
        expect(mockAdminDisconnect.mock.invocationCallOrder[0])
            .toBeLessThan(mockProducerConnect.mock.invocationCallOrder[0]!);
    });

    test('disconnects the admin client even if createTopics throws', async () => {
        mockAdminCreateTopics.mockRejectedValue(new Error('broker unavailable'));

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

        expect(mockAdminConnect).toHaveBeenCalledTimes(5); 
        vi.useRealTimers();
    });
});

describe('disconnectKafka', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockProducerDisconnect.mockResolvedValue(undefined);
        mockAdminConnect.mockResolvedValue(undefined);
        mockAdminListTopics.mockResolvedValue(['raw.vehicle-positions']);
        mockProducerConnect.mockResolvedValue(undefined);
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

    test('is safe to call more than once', async () => {
        await setupKafka();
        await disconnectKafka();
        await disconnectKafka();
        expect(mockProducerDisconnect).toHaveBeenCalledTimes(1);
    });
});
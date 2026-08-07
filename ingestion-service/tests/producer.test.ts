import { describe, test, expect, vi, beforeEach } from 'vitest';
import { publishTelemetries } from '../src/ingestion/producer.js';
import type { IVehicleTelemetry } from '../src/db/vehicle-telemetry.interface.js';

const { 
    mockSend, 
    mockConnect 
} = vi.hoisted(() => ({
    mockSend: vi.fn(),
    mockConnect: vi.fn(),
}));

vi.mock('kafkajs', () => {
    return {
        Kafka: class {
            producer() {
                return {
                    connect: mockConnect,
                    send: mockSend,
                };
            }
            admin() {
                return {
                    connect: vi.fn(),
                    listTopics: vi.fn().mockResolvedValue([]),
                    createTopics: vi.fn(),
                    disconnect: vi.fn(),
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

describe('producer > publishTelemetries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('returns 0 when given an empty array', async () => {
        const result = await publishTelemetries([]);
        expect(result.published).toBe(0);
        expect(mockSend).not.toHaveBeenCalled();
    });

    test('publishes messages to Kafka with the exact agreed schema', async () => {
        const mockTelemetry: IVehicleTelemetry = {
            vehicle_id: 'v123',
            trip_id: 't456',
            route_id: 'r789',
            location: {
                type: 'Point',
                coordinates: [-71.0, 42.0]
            },
            timestamp: new Date('2026-08-07T00:00:00Z')
        };

        const result = await publishTelemetries([mockTelemetry]);

        expect(result.published).toBe(1);
        expect(mockSend).toHaveBeenCalledTimes(1);

        const sendArgs = mockSend.mock.calls[0]![0];
        expect(sendArgs.topic).toBe('raw.vehicle-positions');

        const publishedMessage = sendArgs.messages[0];
        expect(publishedMessage.key).toBe('v123');

        const parsedValue = JSON.parse(publishedMessage.value);
        expect(parsedValue).toHaveProperty('vehicle_id', 'v123');
        expect(parsedValue).toHaveProperty('trip_id', 't456');
        expect(parsedValue).toHaveProperty('location.type', 'Point');
        expect(parsedValue.location.coordinates).toEqual([-71.0, 42.0]);
        expect(parsedValue).toHaveProperty('timestamp');
    });
});
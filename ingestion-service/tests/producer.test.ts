import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { publishTelemetries } from '../src/ingestion/producer.js';
import type { IVehicleTelemetry } from '../src/config.js';

const { mockSend } = vi.hoisted(() => ({
    mockSend: vi.fn(),
}));

vi.mock('kafkajs', () => ({
    Kafka: class {
        producer() {
            return {
                connect: vi.fn().mockResolvedValue(undefined),
                send: mockSend,
                disconnect: vi.fn().mockResolvedValue(undefined),
            };
        }
        admin() {
            return {
                connect: vi.fn(),
                listTopics: vi.fn(),
                createTopics: vi.fn(),
                disconnect: vi.fn(),
            };
        }
    },
    Partitioners: { DefaultPartitioner: vi.fn() }
}));

vi.mock('../src/config.js', () => ({
    config: {
        mbta: { 
            vehiclePositionsUrl: 'https://fake.test/VehiclePositions.pb' 
        },
        kafka: { 
            brokers: ['fake-broker:9092'], 
            topic: 'raw.vehicle-positions', 
            numPartitions: 4 },
    },
}));

vi.mock('../src/utils/logger.js', () => ({
    logger: { 
        info: vi.fn(), 
        warn: vi.fn(), 
        error: vi.fn(), 
        fatal: vi.fn() 
    },
}));

const telemetry = (
    overrides: Partial<IVehicleTelemetry> = {}
): IVehicleTelemetry => ({
    vehicle_id: 'v123',
    trip_id: 't456',
    route_id: 'r789',
    location: { 
        type: 'Point', 
        coordinates: [-71.0, 42.0] 
    },
    timestamp: new Date('2026-08-07T00:00:00.000Z'),
    ...overrides,
});

describe('publishTelemetries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSend.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('returns 0 when given an empty array', async () => {
        const result = await publishTelemetries([]);
        expect(result).toEqual({ published: 0 });
        expect(mockSend).not.toHaveBeenCalled();
    });

    test('adds the agency id without modifying the input object', async () => {
        const input = telemetry();
        const original = structuredClone(input);

        await publishTelemetries([input]);

        expect(input).toEqual(original);
        const [sendArgs] = mockSend.mock.calls[0]!;
        const parsed = JSON.parse(sendArgs.messages[0].value);
        expect(parsed.agency_id).toBe('mbta');
    });

    test('uses each vehicle id as the message key', async () => {
        const records = [
            telemetry({ vehicle_id: 'vehicle-test-001' }),
            telemetry({ vehicle_id: 'vehicle-test-002' }),
        ];

        await publishTelemetries(records);
        const [sendArgs] = mockSend.mock.calls[0]!;
        expect(sendArgs.messages.map((message: { key: string }) => message.key))
            .toEqual(['vehicle-test-001', 'vehicle-test-002']);
    });

    test('publishes a single telemetry using the vehicle id as kafka key', async () => {
        const result = await publishTelemetries([telemetry({ vehicle_id: 'vehicle-test-001' })]);
        expect(result).toEqual({ published: 1 });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const [sendArgs] = mockSend.mock.calls[0]!;
        expect(sendArgs.topic).toBe('raw.vehicle-positions');
        expect(sendArgs.messages).toHaveLength(1);
        expect(sendArgs.messages[0].key).toBe('vehicle-test-001');

        const parsedMessage = JSON.parse(sendArgs.messages[0].value);
        expect(parsedMessage).toHaveProperty('trip_id', 't456');
        expect(parsedMessage).toHaveProperty('location.type', 'Point');
    });

    test('publishes tree telemetry records in one kafka call and verify the keys', 
        async () =>{
        const records = [
            telemetry({ vehicle_id: 'vehicle-test-001' }),
            telemetry({ vehicle_id: 'vehicle-test-002' }),
            telemetry({ vehicle_id: 'vehicle-test-003' }),
        ];
        const result = await publishTelemetries(records);

        expect(result).toEqual({ published: 3 });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const [sendArgs] = mockSend.mock.calls[0]!;
        expect(sendArgs.messages).toHaveLength(3);

        expect(
            sendArgs.messages.map((message: { key: string }) => message.key),
        ).toEqual(['vehicle-test-001', 'vehicle-test-002', 'vehicle-test-003'])
    });

    test('preserves vehicle, trip, route, and location data when sending to kafka', 
        async () => {
        const input = telemetry({
            vehicle_id: 'G-10093',
            trip_id: 'ADDED-123',
            route_id: 'Green-D',
            location: { 
                type: 'Point', 
                coordinates: [-71.0629, 42.3660] 
            },
        });

        await publishTelemetries([input]);
        const [sendArgs] = mockSend.mock.calls[0]!;
        const parsed = JSON.parse(sendArgs.messages[0].value);

        expect(parsed.vehicle_id).toBe('G-10093');
        expect(parsed.trip_id).toBe('ADDED-123');
        expect(parsed.route_id).toBe('Green-D');
        expect(parsed.location.coordinates).toEqual([-71.0629, 42.3660]);
        expect(parsed.location).toEqual({
            type: 'Point',
            coordinates: [-71.0629, 42.3660],
        });
    });

    test('verify that eventTime and ingestedAt timestamps are stored as ISO strings', 
        async () => {
        const eventTime = new Date('2026-08-07T12:34:56.789Z');

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-07T12:35:00.123Z'));

        await publishTelemetries([telemetry({ timestamp: eventTime })]);
        
        const [sendArgs] = mockSend.mock.calls[0]!;
        const parsed = JSON.parse(sendArgs.messages[0].value);

        expect(parsed.timestamp).toBe('2026-08-07T12:34:56.789Z');
        expect(parsed.ingested_at).toBe('2026-08-07T12:35:00.123Z');
    });

        // Errors
    test('propagate Kafka errors', async () => {
        const kafkaError = new Error('Kafka unavailable by the moment: connection rejected');

        mockSend.mockRejectedValue(kafkaError);

        await expect(
            publishTelemetries([telemetry()]),
        ).rejects.toThrow('Kafka unavailable by the moment: connection rejected');
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('does not report messages as published when Kafka send fails', async () => {
        mockSend.mockRejectedValueOnce(
            new Error('Broker unavailable'),
        );

        await expect(
            publishTelemetries([
                telemetry(),
                telemetry(),
            ]),
        ).rejects.toThrow('Broker unavailable');
    });

    test('every message in a single publish call shares the exact same ingested_at', async () => {
    const telemetries = [
        { vehicle_id: 'v1', trip_id: null, route_id: null, timestamp: new Date(),
          location: { type: 'Point' as 'Point', coordinates: [0, 0] }, bearing: null, speed: null,
          current_stop_sequence: null, stop_id: null, current_status: null },

        { vehicle_id: 'v2', trip_id: null, route_id: null, timestamp: new Date(),
          location: { type: 'Point' as 'Point', coordinates: [0, 0] }, bearing: null, speed: null,
          current_stop_sequence: null, stop_id: null, current_status: null },
    ];

    await publishTelemetries(telemetries);

    const sentMessages = mockSend.mock.calls[0]![0].messages;
    const ingestedAtValues = sentMessages.map((m: any) => JSON.parse(m.value).ingested_at);

    expect(new Set(ingestedAtValues).size).toBe(1);
});
});
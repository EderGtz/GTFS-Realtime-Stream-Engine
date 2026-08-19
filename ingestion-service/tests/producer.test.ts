import { 
    describe, 
    test, 
    expect, 
    vi, 
    beforeEach,
    afterEach,
} from 'vitest';
import { 
    publishTelemetries,
    setupTopics,
    setupKafka,
    disconnectKafka, 
} from '../src/ingestion/producer.js';
import type { IVehicleTelemetry } from '../src/config.js';

const { 
    mockSend, 
    mockConnect,
    mockProducerDisconnect,
    mockAdminConnect,
    mockAdminListTopics,
    mockAdminCreateTopics,
    mockAdminDisconnect,
} = vi.hoisted(() => ({
    mockSend: vi.fn(),
    mockConnect: vi.fn(),
    mockProducerDisconnect: vi.fn(),
    mockAdminConnect: vi.fn(),
    mockAdminListTopics: vi.fn(),
    mockAdminCreateTopics: vi.fn(),
    mockAdminDisconnect: vi.fn(),
}));

const { 
    mockLogger 
} = vi.hoisted(() => ({
    mockLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
    }
}));

vi.mock('kafkajs', () => {
    return {
        Kafka: class {
            producer() {
                return {
                    connect: mockConnect,
                    send: mockSend,
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

        Partitioners: {
            DefaultPartitioner: vi.fn()
        }
    };
});

vi.mock('../src/config.js', () => ({
    config: {
        mbta: { 
            vehiclePositionsUrl: 'https://fake.test/VehiclePositions.pb',
        },
        kafka: { 
            brokers: ['fake-broker:9092'], 
            topic: 'raw.vehicle-positions', 
            numPartitions: 4,
        },
    },
}));

vi.mock('../src/utils/logger.js', () => ({
    logger: mockLogger,
}));

const telemetry = (
    overrides: Partial<IVehicleTelemetry> = {}
): IVehicleTelemetry => ({
    vehicle_id: 'v123',
    trip_id: 't456',
    route_id: 'r789',
    location: {
        type: 'Point',
        coordinates: [-71.0, 42.0],
    },
    timestamp: new Date('2026-08-07T00:00:00.000Z'),
    ...overrides,
});

describe('producer tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        mockSend.mockResolvedValue(undefined);
        mockConnect.mockResolvedValue(undefined);
        mockProducerDisconnect.mockResolvedValue(undefined);

        mockAdminConnect.mockResolvedValue(undefined);
        mockAdminListTopics.mockResolvedValue([]);
        mockAdminCreateTopics.mockResolvedValue(undefined);
        mockAdminDisconnect.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('publishTelemetries', () => {

        test('returns 0 when given an empty array', 
            async () => {
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
            ]

            await publishTelemetries(records);
            const [sendArgs] = mockSend.mock.calls[0]!;

            expect(
                sendArgs.messages.map( (message: { key: string }) => message.key)
            ).toEqual(['vehicle-test-001', 'vehicle-test-002']);
        });

        test('publishes a single telemetry using the vehicle id as kafka key', 
            async () =>{
            const result = await publishTelemetries([
                telemetry({
                    vehicle_id: 'vehicle-test-001',
                }),
            ]);

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
                    coordinates: [-71.06298065185547, 42.3660888671875],
                },
            });

            await publishTelemetries([input]);

            const [sendArgs] = mockSend.mock.calls[0]!;
            const parsed = JSON.parse(sendArgs.messages[0].value);

            expect(parsed.agency_id).toBe('mbta');
            expect(parsed.vehicle_id).toBe('G-10093');
            expect(parsed.trip_id).toBe('ADDED-123');
            expect(parsed.route_id).toBe('Green-D');

            expect(parsed.location).toEqual({
                type: 'Point',
                coordinates: [-71.06298065185547, 42.3660888671875],
            });
        });

        test('verify that eventTime and ingestedAt timestamps are stored as expected, and as ISO strings', 
            async () => {
            const eventTime = new Date('2026-08-07T12:34:56.789Z');

            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-08-07T12:35:00.123Z'));

            await publishTelemetries([
                telemetry({
                    timestamp: eventTime,
                }),
            ]);

            const [sendArgs] = mockSend.mock.calls[0]!;
            const parsed = JSON.parse(sendArgs.messages[0].value);

            expect(parsed.timestamp).toBe('2026-08-07T12:34:56.789Z');
            expect(parsed.ingested_at).toBe(
                '2026-08-07T12:35:00.123Z',
            );
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
                    telemetry({ vehicle_id: 'v001' }),
                    telemetry({ vehicle_id: 'v002' }),
                ]),
            ).rejects.toThrow('Broker unavailable');
        });
    });

    describe('setupTopics', () => {
        const admin = {
                listTopics: mockAdminListTopics,
                createTopics: mockAdminCreateTopics,
            } as any;

        test('creates the topic when it does not exist', async () => {

            mockAdminListTopics.mockResolvedValue([]);
            await setupTopics(admin);

            expect(mockAdminListTopics).toHaveBeenCalledTimes(1);
            expect(mockAdminCreateTopics).toHaveBeenCalledWith({
                topics: [
                        {
                        topic: 'raw.vehicle-positions',
                        numPartitions: 4,
                        replicationFactor: 1,
                    },
                ],
            });
            expect(mockLogger.info).toHaveBeenCalledWith(
                "Topic 'raw.vehicle-positions' created."
            );
        });

        test('does not create the topic when it already exists', async () => {

            mockAdminListTopics.mockResolvedValue([
                'raw.vehicle-positions',
            ]);
            await setupTopics(admin);

            expect(mockAdminCreateTopics).not.toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith(
                "Topic 'raw.vehicle-positions' already exists.",
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
        test('connects the admin, sets up topics, disconnects admin, then connects producer', async () => {
            mockAdminListTopics.mockResolvedValue([
                'raw.vehicle-positions',
            ]);

            await setupKafka();

            expect(mockAdminConnect).toHaveBeenCalledTimes(1);
            expect(mockAdminListTopics).toHaveBeenCalledTimes(1);
            expect(mockAdminDisconnect).toHaveBeenCalledTimes(1);
            expect(mockConnect).toHaveBeenCalledTimes(1);

            expect(
                mockAdminDisconnect.mock.invocationCallOrder[0],
            ).toBeLessThan(mockConnect.mock.invocationCallOrder[0]!);
        });
    });

    describe('disconnectKafka', () => {
        test('disconnects the producer after it has been connected', async () => {
            await setupKafka();

            await disconnectKafka();

            expect(mockProducerDisconnect).toHaveBeenCalledTimes(1);
        });

        test('does nothing when the producer is not connected', async () => {
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

});
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Kafka } from 'kafkajs';
import { publishTelemetries, setupKafka, disconnectKafka } from '../../src/ingestion/producer.js';
import { config } from '../../src/config.js';

const TEST_TOPIC = 'test.raw.vehicle-positions';
config.kafka.topic = TEST_TOPIC;

describe('Kafka Integration: Roundtrip', () => {
    let testConsumer: any;
    let kafka: Kafka;

    beforeAll(async () => {
        await setupKafka();

        kafka = new Kafka({ 
            clientId: 'ci-verify-consumer', 
            brokers: config.kafka.brokers 
        });

        testConsumer = kafka.consumer({ 
            groupId: 'test-group-' + Date.now() 
        });
        await testConsumer.connect();
        await testConsumer.subscribe({ 
            topic: TEST_TOPIC, 
            fromBeginning: true 
        });
    });

    afterAll(async () => {
        await testConsumer.disconnect();
        await disconnectKafka();
    });

    test('successfully publishes and consumes a telemetry message', 
        async () => {
        const testVehicleId = `ci-verify-${Date.now()}`;
        
        const mockTelemetry = {
            vehicle_id: testVehicleId,
            trip_id: 'trip-ci-test',
            route_id: 'route-ci-test',
            location: { 
                type: "Point" as "Point", 
                coordinates: [-71.0, 42.0] 
            },
            timestamp: new Date(),
            bearing: null,
            speed: null,
            current_stop_sequence: null,
            stop_id: null,
            current_status: null
        };

        await publishTelemetries([mockTelemetry]);

        const receivedMessagePromise = await new Promise<any>((resolve, reject) => {
            testConsumer.run({
                eachMessage: async ({ message }: { message: any }) => {

                    try {
                        const key = message.key?.toString();
                        const value = JSON.parse(message.value?.toString() || '{}');
                        
                        if (key === testVehicleId) {
                            resolve({ key, value });
                        }
                    } catch (err) {
                        reject(err);
                    }
                },
            });
        });

        await publishTelemetries([mockTelemetry]);
        const receivedMessage = await receivedMessagePromise;

        expect(receivedMessage.key).toBe(testVehicleId);
        expect(receivedMessage.value.agency_id).toBe('mbta');
        expect(receivedMessage.value.trip_id).toBe('trip-ci-test');
        expect(receivedMessage.value.location.coordinates).toEqual([-71.0, 42.0]);
        
        await testConsumer.stop();
    }, 15000);
});
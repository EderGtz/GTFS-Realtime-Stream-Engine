import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { Kafka } from 'kafkajs';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { IVehicleTelemetry } from '../../src/config.js';

// Skip when Docker is not available
const dockerSock = await import('node:fs')
    .then(fs => fs.existsSync('/var/run/docker.sock'))
    .catch(() => false);
const describeIfDocker = dockerSock ? describe : describe.skip;

// Mutable — set in beforeAll so the mocked config returns the container's address
const testBroker: string[] = [];
const TEST_TOPIC = 'test.raw.vehicle-positions';

vi.mock('../../src/config.js', () => ({
    config: {
        kafka: {
            get brokers() { return testBroker; },
            topic: TEST_TOPIC,
            numPartitions: 1,
        },
    },
}));

let publishTelemetries: typeof import('../../src/ingestion/producer.js').publishTelemetries;
let setupKafka: typeof import('../../src/ingestion/producer.js').setupKafka;
let disconnectKafka: typeof import('../../src/ingestion/producer.js').disconnectKafka;

/**
 * Kafka Integration Tests using Testcontainers.
 * 
 * @remarks
 * This suite executes an end-to-end telemetry roundtrip against a real, isolated Kafka broker.
 * Due to dynamic port mapping constraints with Confluent Kafka images, a custom 
 * Readiness Gate / Unfreezing lifecycle is applied before the broker officially boots.
 * 
 * @see {@link docs/kafkaIntegrationTestExplanation.md} for a detailed step-by-step 
 * architectural breakdown and execution sequence Mermaid diagram.
 */
describeIfDocker('Kafka Integration: Roundtrip (testcontainers)', () => {
    let container: StartedTestContainer;
    let testConsumer: ReturnType<Kafka['consumer']>;
    let kafka: Kafka;

    beforeAll(async () => {
        // 1. Start Confluent Kafka with a readiness-file gate.
        //    The entrypoint prints "waiting-for-config" so testcontainers
        //    considers the container ready.  Kafka has NOT started yet.
        container = await new GenericContainer('confluentinc/cp-kafka:7.6.0')
            .withExposedPorts(9092)
            .withEnvironment({
                KAFKA_NODE_ID: '1',
                KAFKA_PROCESS_ROLES: 'broker,controller',
                KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
                KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
                KAFKA_LISTENERS: 'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
                KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://localhost:9092',
                KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
                KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
                KAFKA_NUM_PARTITIONS: '1',
                KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
                KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
                KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
                KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
                CLUSTER_ID: 'X6usq6R5hRCVdeDrtTtSoQ',
            })
            .withEntrypoint(['bash'])
            .withCommand([
                '-c',
                'echo "waiting-for-config" && ' +
                'while [ ! -f /tmp/testcontainers-ready ]; do sleep 0.1; done && ' +
                '/etc/confluent/docker/run',
            ])
            .withWaitStrategy(Wait.forLogMessage('waiting-for-config'))
            .withStartupTimeout(60_000)
            .start();

        // 2. Now we know the mapped port — override KAFKA_ADVERTISED_LISTENERS
        //    via /etc/confluent/docker/bash-config (sourced by the run script).
        const host = container.getHost();
        const port = container.getMappedPort(9092);
        const bootstrapServer = `${host}:${port}`;
        testBroker.push(bootstrapServer);

        await container.exec([
            'bash', '-c',
            `echo 'export KAFKA_ADVERTISED_LISTENERS="PLAINTEXT://${bootstrapServer}"' > /etc/confluent/docker/bash-config`,
        ]);

        // 3. Release the readiness gate → /etc/confluent/docker/run starts Kafka
        await container.exec(['touch', '/tmp/testcontainers-ready']);

        // 4. Wait until Kafka is reachable from the host
        const probe = new Kafka({ clientId: 'probe', brokers: [bootstrapServer] });
        const admin = probe.admin();
        const deadline = Date.now() + 30_000;
        let connected = false;
        while (Date.now() < deadline) {
            try {
                await admin.connect();
                await admin.listTopics();
                connected = true;
                await admin.disconnect();
                break;
            } catch {
                await new Promise(r => setTimeout(r, 500));
            }
        }
        if (!connected) throw new Error('Kafka not reachable from host within 30 s');

        // 4b. Kafka broker is up but the group coordinator needs a few more
        //     seconds to finish loading.  Wait for it before wiring up the consumer.
        await new Promise(r => setTimeout(r, 5_000));

        // 5. Dynamically import producer
        const producer = await import('../../src/ingestion/producer.js');
        publishTelemetries = producer.publishTelemetries;
        setupKafka = producer.setupKafka;
        disconnectKafka = producer.disconnectKafka;

        await setupKafka();

        // 6. Set up a test consumer
        kafka = new Kafka({ clientId: 'ci-verify', brokers: [bootstrapServer] });
        testConsumer = kafka.consumer({ groupId: 'test-group-' + Date.now() });
        await testConsumer.connect();
        await testConsumer.subscribe({ topic: TEST_TOPIC, fromBeginning: true });
    }, 90_000);

    afterAll(async () => {
        await testConsumer?.disconnect();
        await disconnectKafka();
        await container?.stop();
    });

    test('publishTelemetries roundtrips through a real Kafka broker', async () => {
        const testVehicleId = `ci-verify-${Date.now()}`;

        const mockTelemetry: IVehicleTelemetry = {
            vehicle_id: testVehicleId,
            trip_id: 'trip-ci-test',
            route_id: 'route-ci-test',
            direction_id: 0,
            location: { type: 'Point', coordinates: [-71.0, 42.0] },
            timestamp: new Date(),
            bearing: null,
            speed: null,
            current_stop_sequence: null,
            stop_id: null,
            current_status: null,
        };

        const received = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for message')), 15_000);
            testConsumer.run({
                eachMessage: async ({ message }) => {
                    const key = message.key?.toString();
                    if (key === testVehicleId) {
                        clearTimeout(timeout);
                        resolve({ key, value: JSON.parse(message.value?.toString() || '{}') });
                    }
                },
            }).catch(reject);
        });

        await publishTelemetries([mockTelemetry]);

        const receivedMessage = await received;

        expect(receivedMessage.key).toBe(testVehicleId);
        expect(receivedMessage.value.agency_id).toBe('mbta');
        expect(receivedMessage.value.trip_id).toBe('trip-ci-test');
        expect(receivedMessage.value.location.coordinates).toEqual([-71.0, 42.0]);

        await testConsumer.stop();
    }, 20_000);
});

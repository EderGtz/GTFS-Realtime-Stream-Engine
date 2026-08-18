/* scripts/verify-kafka-roundtrip.ts
 *
 * CI-only integration script (not part of the shipped service).
 * Proves that a message published through the REAL producer.ts pipeline
 * can be read back and correctly parsed by a basic Kafka consumer —
 * fulfilling Phase 2's "a basic consumer can read and correctly parse
 * messages off the topic" acceptance criterion against a real broker
 *
 * Deliberately does NOT poll the live MBTA feed: only validates the
 * Kafka round-trip itself, not feed availability. Live-feed proof is
 * covered separately (manual kafbat-ui checks, Phase 5's sustained run).
*/

import { Kafka } from 'kafkajs';
import { config, type IVehicleTelemetry } from '../src/config.js';
import { setupKafka, publishTelemetries, disconnectKafka } from '../src/ingestion/producer.js';

const TIMEOUT_MS = 20_000;

const testTelemetry: IVehicleTelemetry = {
    vehicle_id: `ci-verify-${Date.now()}`, // unique per run — never matches a stale/leftover message
    trip_id: 'trip-ci-test',
    route_id: 'route-ci-test',
    location: { 
        type: 'Point', 
        coordinates: [-71.05, 42.35] 
    },
    timestamp: new Date(),
};

async function main() {
    console.log('Connecting producer and ensuring topic exists...');
    await setupKafka();

    console.log(`Publishing test message for vehicle_id=${testTelemetry.vehicle_id}...`);
    await publishTelemetries([testTelemetry]);
    await disconnectKafka();

    console.log('Starting a consumer...');
    const kafka = new Kafka({ clientId: 'ci-verify-consumer', brokers: config.kafka.brokers });
    const consumer = kafka.consumer({ groupId: `ci-verify-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: true });

    const found = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), TIMEOUT_MS);

        consumer.run({
            eachMessage: async ({ message }) => {
                if (!message.value) return;

                let parsed: any;
                try {
                    parsed = JSON.parse(message.value.toString());
                } catch {
                    return; // not our message or malformed message
                }

                // this would not be the message we just published this run.
                if (parsed.vehicle_id !== testTelemetry.vehicle_id) return;

                const validShape =
                    parsed.trip_id === testTelemetry.trip_id &&
                    parsed.route_id === testTelemetry.route_id &&
                    parsed.location?.type === 'Point' &&
                    Array.isArray(parsed.location?.coordinates) &&
                    parsed.location.coordinates.length === 2 &&
                    typeof parsed.timestamp === 'string';

                clearTimeout(timeout);

                if (!validShape) {
                    console.error('Message found but schema mismatch:', parsed);
                    resolve(false);
                    return;
                }

                console.log('Consumer correctly parsed the published message. Schema OK.');
                resolve(true);
            },
        });
    });

    await consumer.disconnect();

    if (!found) {
        console.error(`Did not receive a valid matching message within ${TIMEOUT_MS}ms.`);
        process.exit(1);
    }

    console.log('Kafka round-trip verified successfully.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal error during Kafka round-trip verification:', err);
    process.exit(1);
});
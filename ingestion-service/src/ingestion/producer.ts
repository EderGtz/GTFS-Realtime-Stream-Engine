import { Kafka, Partitioners, type Admin, type Producer } from 'kafkajs';
import { config, type IVehicleTelemetry } from '../config.js';
import { logger } from '../utils/logger.js';

const kafka = new Kafka({
    clientId: 'ingestion-service',
    brokers: config.kafka.brokers,
});

const producer: Producer = kafka.producer({ 
    idempotent: true,
    createPartitioner: Partitioners.DefaultPartitioner,
});
let producerConnected = false;

async function connectWithRetry(
    connectFn: () => Promise<void>, 
    label: string,
    attempts = 5, 
    delayMs = 3000
): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await connectFn();
            return;
        } catch (err) {
            if (attempt === attempts) throw err;
            logger.warn(
                `${label} connect failed (attempt ${attempt}/${attempts}), retrying...`
            );
            await new Promise(res => setTimeout(res, delayMs));
        }
    }
}

export async function setupTopics(admin: Admin) {
    const topics = await admin.listTopics();

    if(!topics.includes(config.kafka.topic)) {
        await admin.createTopics({
            topics: [{
                topic: config.kafka.topic,
                numPartitions: config.kafka.numPartitions,
                replicationFactor: 1,
            }],
        });
        logger.info(`Topic '${config.kafka.topic}' created.`);
    } else {
        logger.info(`Topic '${config.kafka.topic}' already exists.`);
    }
}

export async function setupKafka() {
    const admin = kafka.admin();
    await connectWithRetry(() => admin.connect(), "Kafka admin");

    try {
        await setupTopics(admin);
    } finally {
        await admin.disconnect();
    }
    await connectWithRetry(() => producer.connect(), "Kafka producer");
    producerConnected = true;
}

/**
 * - ingested_at tells feed freshness, transport latency, and processing lag.
 * - agency_id avoids a future migration when adding providers.
 */
export async function publishTelemetries(
    validTelemetries: Array<IVehicleTelemetry>
): Promise<{ published: number }> {

    if (validTelemetries.length === 0) return { published: 0 };

    // agency_id is currently fixed to mbta; multi-agency support is future work.
    await producer.send({
        topic: config.kafka.topic,
        messages: validTelemetries.map(t => ({
            key: t.vehicle_id, // partitions by vehicle
            value: JSON.stringify({
                agency_id: "mbta",
                ...t,
                ingested_at: new Date().toISOString()
            }),
        })),
    });
    return { published: validTelemetries.length }
}

export async function disconnectKafka() {
    if (producerConnected) {
        await producer.disconnect();
        producerConnected = false;
    }
}
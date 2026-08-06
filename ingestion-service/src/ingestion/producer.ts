import { Kafka, type Admin } from 'kafkajs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const kafka = new Kafka({
    clientId: 'ingestion-service',
    brokers: config.kafka.brokers,
});

async function connectWithRetry(admin: Admin, attempts = 5, delayMs = 3000) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await admin.connect();
            return;
        } catch (err) {
            if (attempt === attempts) throw err;
            logger.warn(`Kafka admin connect failed (attempt ${attempt}/${attempts}), retrying...`);
            await new Promise(res => setTimeout(res, delayMs));
        }
    }
}

export async function setupKafka() {
    const admin = kafka.admin();
    await connectWithRetry(admin);

    try {
        const created = await admin.createTopics({
            topics: [{
                topic: config.kafka.topic,
                numPartitions: config.kafka.numPartitions,
                replicationFactor: 1
            }]
        });
        logger.info(created
            ? `Topic '${config.kafka.topic}' created.`
            : `Topic '${config.kafka.topic}' already exists.`);
    } finally {
        await admin.disconnect();
    }
}

export { kafka };
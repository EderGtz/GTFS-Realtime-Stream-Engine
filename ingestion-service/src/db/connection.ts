import { MongoClient, type Collection, type Document } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const BUNCHING_COLLECTION = 'bunching_events';
const DEVIATION_COLLECTION = 'schedule_deviations';

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3_000;
const SERVER_SELECTION_TIMEOUT_MS = 5_000;

/**
 * Connect to MongoDB with retry, matching the analytics-engine's
 */
export async function connectDbWithRetry(
    uri: string,
    maxAttempts: number = MAX_ATTEMPTS,
    delayMs: number = RETRY_DELAY_MS,
): Promise<MongoClient> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const client = new MongoClient(uri, {
                serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
            });
            await client.connect();
            await client.db('admin').command({ ping: 1 });
            logger.info('Connected to MongoDB (attempt %d)', attempt);
            return client;
        } catch (err) {
            lastError = err as Error;
            if (attempt === maxAttempts) break;
            logger.warn(
                { err, attempt, maxAttempts },
                'Mongo connect failed, retrying...',
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    throw new Error(
        `Could not connect to MongoDB after ${maxAttempts} attempts`,
        { cause: lastError },
    );
}

export interface ApiCollections {
    bunching: Collection<Document>;
    deviations: Collection<Document>;
}

/**
 * Open a read-only connection to the analytics database and return
 * the two collections the /v1/delays/live endpoint needs.
 */
export async function openApiCollections(): Promise<ApiCollections> {
    const client = await connectDbWithRetry(config.mongo.uri);
    const db = client.db(config.mongo.database);

    return {
        bunching: db.collection(BUNCHING_COLLECTION),
        deviations: db.collection(DEVIATION_COLLECTION),
    };
}

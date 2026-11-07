import { MongoClient, type Collection, type Document } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const BUNCHING_COLLECTION = 'bunching_events';
const DEVIATION_COLLECTION = 'schedule_deviations';
const PIPELINE_STATUS_COLLECTION = 'pipeline_status';

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

/**
 * The single pipeline_status document upserted per window by the analytics
 * engine (db/writer.py `build_pipeline_status_document`). Uses a fixed STRING
 * _id — not an ObjectId — which is why it gets its own interface: without it
 * the mongodb typings reject `{ _id: 'pipeline_status' }` as a filter.
 * Fields are optional because the writer omits sections when a window carries
 * no matching/pipeline snapshot.
 */
export interface PipelineStatusDocument extends Document {
    _id: string;
    reported_at: Date;
    last_message_at?: Date | null;
    consumer_lag_messages?: number | null;
    last_static_reload_at?: Date | null;
    static_bundle_version?: string | null;
    window_total_records?: number;
    matching?: Record<string, unknown> | null;
    alerts?: string[];
}

export interface ApiCollections {
    client: MongoClient;
    bunching: Collection<Document>;
    deviations: Collection<Document>;
    pipelineStatus: Collection<PipelineStatusDocument>;
}

/**
 * Open a read-only connection to the analytics database and return
 * the two collections the /v1/delays/live endpoint needs.
 * The client is included so the caller can close it on shutdown.
 */
export async function openApiCollections(): Promise<ApiCollections> {
    const client = await connectDbWithRetry(config.mongo.uri);
    const db = client.db(config.mongo.database);

    return {
        client,
        bunching: db.collection(BUNCHING_COLLECTION),
        deviations: db.collection(DEVIATION_COLLECTION),
        pipelineStatus: db.collection(PIPELINE_STATUS_COLLECTION),
    };
}

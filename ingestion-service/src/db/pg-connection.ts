import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3_000;

export async function connectPgWithRetry(
    connectionString: string,
    maxAttempts: number = MAX_ATTEMPTS,
    delayMs: number = RETRY_DELAY_MS,
): Promise<pg.Pool> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const pool = new pg.Pool({
                connectionString,
                connectionTimeoutMillis: 5_000,
                idleTimeoutMillis: 30_000,
                max: 5,
            });

            const client = await pool.connect();
            client.release();

            logger.info('Connected to PostgreSQL (attempt %d)', attempt);
            return pool;
        } catch (err) {
            lastError = err as Error;
            if (attempt === maxAttempts) break;
            logger.warn(
                { err, attempt, maxAttempts },
                'PostgreSQL connect failed, retrying...',
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    throw new Error(
        `Could not connect to PostgreSQL after ${maxAttempts} attempts`,
        { cause: lastError },
    );
}

/**
 * Open a read-only connection to the PostgreSQL database.
 * Returns the pool so the caller can close it on shutdown.
 */
export async function openPgPool(): Promise<pg.Pool> {
    return connectPgWithRetry(config.pg.dsn);
}
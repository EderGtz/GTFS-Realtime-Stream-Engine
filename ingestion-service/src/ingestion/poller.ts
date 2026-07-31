import { config } from '../config.js';
import { VehicleTelemetry } from '../db/vehicle-telemetry.model.js';
import { requestWithRetry } from '../utils/requestWithRetry.js';
import { decodeVehiclePositions } from './decoder.js';
import { vehiclesWithValidTelemetries } from './validator.js';
import { wait } from '../utils/requestWithRetry.js'
import type { IVehicleTelemetry } from '../db/vehicle-telemetry.interface.js';
import { logger } from '../utils/logger.js';

async function fetchFeedBuffer(): Promise<ArrayBuffer> {
    const buffer = await requestWithRetry<ArrayBuffer>({
        url: config.mbta.vehiclePositionsUrl,
        responseType: 'arraybuffer'
    });
    if (!buffer || buffer.byteLength === 0 ) { 
        throw new Error("Received empty response from MBTA");
    }
    return buffer;
}

function decodeFeed(buffer: ArrayBuffer) {
    const vehiclesJson = decodeVehiclePositions(new Uint8Array(buffer));
    return vehiclesJson.entity ?? [];
}

async function storeTelemetries( 
    validTelemetries:Array<IVehicleTelemetry> 
): Promise<{ inserted: number; duplicated: number }> {
    
    if (validTelemetries.length === 0) return { inserted: 0, duplicated: 0 };

    const operations = validTelemetries.map(doc => ({ insertOne: { document: doc } }));
    try {
        await VehicleTelemetry.bulkWrite(operations, { ordered: false });
        return { inserted: validTelemetries.length, duplicated: 0 };
    } catch (error: any) {
        if (error.code === 11000) {
            const duplicated = error.writeErrors?.length ?? 0;
            return { inserted: validTelemetries.length - duplicated, duplicated };
        }
        throw error;
    }
}

async function pollCycle(): Promise<void> {
    const buffer = await fetchFeedBuffer();
    const entities = decodeFeed(buffer);
    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries(entities);
    const { inserted, duplicated } = await storeTelemetries(validTelemetries);

    logger.info( `${inserted} new records, ${duplicated} duplicates skipped, ${skippedVehicles} malformed vehicles omitted.` );
}

const MAX_BACKOFF_MS = 5 * 60_000;
const BASE_INTERVAL_MS = 15_000;
const ALERT_THRESHOLD = 5;

/**
 * tTransient failures (timeouts, 5xx, network blips) have been already cover at this point. 
 * By the time pollCycle() throws all the way out to this loop, it would have already survived 
 * several retries and still failed. Hitting that 5 times in a row (each with its own internal retries) 
 * would means something more sustained is wrong: MBTA's feed is down, your network is down, 
 * or Mongo is unreachable. That is why I approached that problem this way: 
 * 
 * - Alert once when the threshold is hit
 * 
 * - Keep the process alive but back off the polling interval in order to avoid hammering a dead feed 
 * every 15s while still trying periodically and recovering automatically the moment MBTA comes back.
 * 
 * This ensures: 
 * - Normal 15s cadence while things are healthy and the CDN is alive.
 * - Once it is crosses 5 consecutive full-cycle failures, the wait interval starts doubling (15s → 30s → 60s... capped at 5 min), 
 * so a dead feed doesn't get hammered, but the cycle also never stop trying in order to make the recovery automatic.
 * - The fatal alert fires exactly once at the threshold, so the alerting system (loggin at this point)
 * doesn't get spammed every cycle while the outage continues. This could be even wired so that
 * logger.fatal call to someone or hit a webhook later.
 * - On success, if you were in a degraded state, a recovery message is logged, which could be useful for 
 * reconstructing incident timelines later.
 */
export async function pollVehiclePositions() {
    logger.info("Starting vehicles polling");
    let consecutiveFailures = 0;

    while (true) {
        try {
            await pollCycle();

            if (consecutiveFailures >= ALERT_THRESHOLD) {
                logger.warn("MBTA feed recovered after sustained failure.");
            }
            consecutiveFailures = 0;

        } catch (error) {
            consecutiveFailures++;
            logger.error(
                { err: error, attempt: consecutiveFailures }, 
                "Failure during polling cycle."
            );
            
            if (consecutiveFailures >= ALERT_THRESHOLD) {
                logger.fatal(
                    "ALERT: MBTA feed has failed 5 consecutive times. Manual intervention may be required."
                );
            }
        }
        const waitMs = consecutiveFailures >= ALERT_THRESHOLD
            ? Math.min(BASE_INTERVAL_MS * 2 ** (consecutiveFailures - ALERT_THRESHOLD), MAX_BACKOFF_MS) 
            : BASE_INTERVAL_MS;

        await wait(waitMs);
    }
}
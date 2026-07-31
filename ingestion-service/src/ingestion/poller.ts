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

// wait interval starts doubling until reach 5 min between attempts
const MAX_BACKOFF_MS = 5 * 60_000;
const BASE_INTERVAL_MS = 15_000;
const ALERT_THRESHOLD = 5;

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
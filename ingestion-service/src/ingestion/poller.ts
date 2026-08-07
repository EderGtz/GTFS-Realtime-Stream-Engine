import { config } from '../config.js';
import { requestWithRetry } from '../utils/requestWithRetry.js';
import { decodeVehiclePositions } from './decoder.js';
import { vehiclesWithValidTelemetries } from './validator.js';
import { wait } from '../utils/requestWithRetry.js'
import { logger } from '../utils/logger.js';
import { setupKafka, publishTelemetries } from './producer.js';

export async function fetchFeedBuffer(): Promise<ArrayBuffer> {
    const buffer = await requestWithRetry<ArrayBuffer>({
        url: config.mbta.vehiclePositionsUrl,
        responseType: 'arraybuffer'
    });
    if (!buffer || buffer.byteLength === 0 ) { 
        throw new Error("Received empty response from MBTA");
    }
    return buffer;
}

export function decodeFeed(buffer: ArrayBuffer) {
    const vehiclesJson = decodeVehiclePositions(new Uint8Array(buffer));
    return vehiclesJson.entity ?? [];
}

export async function pollCycle(): Promise<void> {
    const buffer = await fetchFeedBuffer();
    const entities = decodeFeed(buffer);
    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries(entities);
    const { published } = await publishTelemetries(validTelemetries);

    logger.info( `${published} records published to Kafka, ${skippedVehicles} malformed vehicles omitted.` );
}

const MAX_BACKOFF_MS = 5 * 60_000;
const BASE_INTERVAL_MS = 15_000;
const ALERT_THRESHOLD = 5;

export function computeWaitMs(consecutiveFailures: number): number {
    return consecutiveFailures >= ALERT_THRESHOLD
        ? Math.min(BASE_INTERVAL_MS * 2 ** (consecutiveFailures - ALERT_THRESHOLD), MAX_BACKOFF_MS) 
        : BASE_INTERVAL_MS;
}

export async function pollVehiclePositions(
    poll: () => Promise<void> = pollCycle
) {
    logger.info("Starting vehicles polling");
    await setupKafka(); // connects producer + ensures topic exists, once, before the loop
    let consecutiveFailures = 0;

    while (true) {
        try {
            await poll();

            if (consecutiveFailures === ALERT_THRESHOLD) {
                logger.warn("MBTA feed recovered after sustained failure.");
            }
            consecutiveFailures = 0;

        } catch (error) {
            consecutiveFailures++;
            logger.error(
                { err: error, attempt: consecutiveFailures }, 
                "Failure during polling cycle."
            );
            
            if (consecutiveFailures === ALERT_THRESHOLD) {
                logger.fatal(
                    "ALERT: MBTA feed has failed 5 consecutive times. Manual intervention may be required."
                );
            }
        }
        await wait(computeWaitMs(consecutiveFailures));
    }
}
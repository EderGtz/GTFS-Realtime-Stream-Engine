import { config } from '../config.js';
import { VehicleTelemetry } from '../db/vehicle-telemetry.model.js';
import { requestWithRetry } from '../utils/requestWithRetry.js';
import { decodeVehiclePositions } from './decoder.js';
import { vehiclesWithValidTelemetries } from './validator.js';
import { wait } from '../utils/requestWithRetry.js'
import type { IVehicleTelemetry } from '../db/vehicle-telemetry.interface.js';

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

    console.log(
        `${inserted} new records, ${duplicated} duplicates skipped, ${skippedVehicles} malformed vehicles omitted.`
    );
}


export async function pollVehiclePositions() {
    console.log("Starting vehicles polling");

    while (true) {
        try {
            await pollCycle();
        } catch (error) {
            console.error("Critical failure during polling cycle: ", error);
        }
        await wait(15_000);
    }
}
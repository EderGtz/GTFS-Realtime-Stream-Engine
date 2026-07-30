import { config } from '../config.js';
import { VehicleTelemetry } from '../db/vehicle-telemetry.model.js';
import { requestWithRetry } from '../utils/requestWithRetry.js';
import { decodeVehiclePositions } from './decoder.js';
import { vehiclesWithValidTelemetries } from './validator.js';
import { wait } from '../utils/requestWithRetry.js'

export async function pollVehiclePositions() {
    console.log("Starting vehicles polling");

    while (true) {
        try {
            const bufferResponse = await requestWithRetry<ArrayBuffer>({ 
                url: config.mbta.vehiclePositionsUrl,
                responseType: 'arraybuffer'
            });
            if (!bufferResponse || bufferResponse.byteLength === 0 ) { 
                throw new Error("Received empty response from MBTA");
            }
            const vehiclesJson = decodeVehiclePositions(new Uint8Array(bufferResponse));
            const entities = vehiclesJson.entity || [];

            const telemetries = vehiclesWithValidTelemetries(entities);
            const validTelemetries = telemetries.validTelemetries;
            const omitted = telemetries.skippedVehicles;
            
            if (validTelemetries.length > 0) {

                const operations = validTelemetries.map(doc => ({
                    insertOne: { document: doc }
                }));

                try { 
                    await VehicleTelemetry.bulkWrite(
                        operations, 
                        { 
                            ordered: false 
                        });

                } catch (error: any) {

                    if (error.code === 11000) {
                        const duplicated = error.writeErrors.lenght || 0;
                        const inserted = validTelemetries.length - duplicated;
                        console.log(`${inserted} new records. ${duplicated} duplicated records omitted`);

                    } else {
                        console.error("Fatal error while writing to MongoDB: ", error);
                    }
                }

                console.log(
                    `${validTelemetries.length} vehicle documents inserted.
                    ${omitted} documents omitted for malformed data`
                    );
            } 

        } catch (error) {
            console.error("Critical failure during polling cycle: ", error);
        }
        await wait(15_000);
    }
}
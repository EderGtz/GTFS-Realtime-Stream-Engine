import { config } from '../config.js';
import { requestWithRetry } from '../utils/requestWithRetry.js';
import { decodeVehiclePositions, type DecodedFeedMessage } from './decoder.js';


export async function pollVehiclePositions() {
    try {
        const bufferResponse = await requestWithRetry<ArrayBuffer>({ 
            url: config.mbta.vehiclePositionsUrl,
            responseType: 'arraybuffer'
        });

        if (!bufferResponse || bufferResponse.byteLength === 0 ) { 
            throw new Error("Received empty response from MBTA");
        }

        const jsonPayload = decodeVehiclePositions(new Uint8Array(bufferResponse));

        console.log(`Successfully fetched and decoded ${jsonPayload.entity?.length} vehicles.`);
        return jsonPayload;
        
    } catch (error) {
        console.error("Critical failure during polling cycle: ", error);
    } finally {
        setTimeout(pollVehiclePositions, 15_000);
    }
}

import { config } from '../config.js';
import { fetchWithBackoff } from '../utils/httpCalls.js';
import { decodeVehiclePositions } from './decoder.js';

async function pollVehiclePositions() {
    try {
        const response = await fetchWithBackoff(config.mbta.vehiclePositionsUrl, {
            responseType: 'arraybuffer'
        });

        if (!response || !response.data) throw new Error("Received empty response from MBTA");

        const buffer = new Uint8Array(response.data);
        const jsonPayload = decodeVehiclePositions(buffer);

        console.log(`Successfully fetched and decoded ${jsonPayload.entity?.length} vehicles.`);
        return jsonPayload
    } catch (error) {
        console.error("Critical failure during polling cycle: ", error);
    }
}

// Test
pollVehiclePositions().then(() => console.log("Test execution complete."));
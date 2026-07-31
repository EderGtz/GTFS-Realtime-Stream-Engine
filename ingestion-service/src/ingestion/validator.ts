import type { IVehicleTelemetry } from "../db/vehicle-telemetry.interface.js";
import type { DecodedVehiclePosition } from "./decoder.js";

/**
 * Decoder's toObject() call omits absent optional fields entirely: 
 * they come through as undefined, so if position exists, 
 * latitude/longitude should always be present numbers. 
 * Malformed entries are more likely to have position 
 * be entirely missing rather than present-but-null coordinates.
 */
type VehicleWithPosition = NonNullable<DecodedVehiclePosition["vehicle"]> & {
    position: { 
        latitude: number; 
        longitude: number;
        bearing?: number;
        speed?: number; 
    }
};

/** Number.isFinite() is false for undefined, null, and NaN */
export function hasValidPosition(
    vehicle: DecodedVehiclePosition["vehicle"]
):  vehicle is VehicleWithPosition {
    return !!vehicle 
        && !!vehicle.position 
        && Number.isFinite(vehicle.position.latitude) 
        && Number.isFinite(vehicle.position.longitude)
}

export function vehiclesWithValidTelemetries(
    entities: Array<DecodedVehiclePosition>
): { 
    validTelemetries: Array<IVehicleTelemetry>, 
    skippedVehicles: number 
} {
    const validTelemetries: Array<IVehicleTelemetry> = []; 
    let skippedVehicles = 0;

    for (const entity of entities) {
        const vehicle = entity.vehicle;

        if (!hasValidPosition(vehicle)) {
            skippedVehicles++;
            continue;
        }

        validTelemetries.push({
            vehicle_id: vehicle.vehicle?.id || "UNKNOWN",
            trip_id: vehicle.trip.tripId || "UNKNOWN",
            location: {
                type: "Point",
                coordinates: [
                    vehicle.position.longitude,
                    vehicle.position.latitude
                ]
            },
            timestamp: new Date(Number(vehicle.timestamp) *  1000)
        });
    }
    return { validTelemetries, skippedVehicles };
}
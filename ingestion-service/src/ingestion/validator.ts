import type { IVehicleTelemetry } from "../db/vehicle-telemetry.interface.js";
import type { DecodedVehiclePosition } from "./decoder.js";

export function isInvalidVehicle(vehicle: DecodedVehiclePosition["vehicle"]) {
    return !vehicle 
        || !vehicle.position 
        || vehicle.position.latitude === null 
        || vehicle.position.longitude === null;
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

        if (isInvalidVehicle(vehicle)) {
            skippedVehicles++;
            continue;
        }

        validTelemetries.push({
            vehicle_id: vehicle.vehicle?.id || "UNKOWN",
            trip_id: vehicle.trip.tripId || "UNKOWN",
            location: {
                type: "Point",
                coordinates: [
                    vehicle.position!.longitude,
                    vehicle.position!.latitude
                ]
            },
            timestamp: new Date(Number(vehicle.timestamp) *  1000)
        });
    }

    return {
        validTelemetries: validTelemetries,
        skippedVehicles: skippedVehicles
    };
}
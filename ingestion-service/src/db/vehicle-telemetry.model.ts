import mongoose, { Schema } from "mongoose";
import type { IVehicleTelemetry } from "./vehicle-telemetry.interface.js";

/**
 * vehicle_id is the only identifier for tracking one physical bus/train over time, that is why it is mandaroty  
 * to have this in every record. So a missing vehicle_id as invalid and skip the entry, same as a missing position.
 * 
 * trip_id, on the other hand, is legitimately allowed to be absent per the .proto specification: 
 * a vehicle can be reporting position without being assigned to a trip instance yet.
 * Colapsing it to "UNKNOWN" creates the same false-collision problem: every untripped vehicle across the whole 
 * fleet would appear to share one same "trip." This would not be util in Phase 3's schedule-deviation join, 
 * since a row without a real trip_id just can't participate in that particular computation, but it's still valid 
 * for other things (e.g. knowing the vehicle is alive, or future bunching work that groups by route_id instead), 
 * and Phase 3 code could simply filter on WHERE trip_id IS NOT NULL 
 * 
 * trip.routeId is stored, because "Route" is the grouping key for bunching detection (Phase 3's second metric 
 * spacing between vehicles on the same route), and it's independent of whether a trip_id exists or not.
 */
const VehicleTelemetrySchema = new Schema<IVehicleTelemetry>({
    vehicle_id: { type: String, required: true },
    trip_id: { type: String, required: false, default: null },
    route_id: { type: String, required: false, default: null },
    location: {
        type: {
            type: String,
            enum: ['Point'],
            required: true,
        },
        coordinates: {
            type: [Number], // [longitude, latitude]
            required: true,
        }
    },
    timestamp: { type: Date, required: true }
});

//  2dsphere index for spatial queries
VehicleTelemetrySchema.index({ location: "2dsphere" });

// If a vehicle reports twice with an identical timestamp (feed hiccup, etc.)
// it is not inserted twice
VehicleTelemetrySchema.index({ vehicle_id: 1, timestamp: 1 }, { unique:  true });

// For testing: deletes records 7 days after their timestamp (preventing running out of memory) 
VehicleTelemetrySchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 });

export const VehicleTelemetry = mongoose.model<IVehicleTelemetry>('VehicleTelemetry', VehicleTelemetrySchema);

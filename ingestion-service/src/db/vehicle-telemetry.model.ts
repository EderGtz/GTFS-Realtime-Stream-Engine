import mongoose, { Schema } from "mongoose";
import type { IVehicleTelemetry } from "./vehicle-telemetry.interface.js";

const VehicleTelemetrySchema = new Schema<IVehicleTelemetry>({
    vehicle_id: { type: String, required: true },
    trip_id: { type: String, required: true },
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

export const VehicleTelemetry = mongoose.model<IVehicleTelemetry>('VehicleTelemetry', VehicleTelemetrySchema);

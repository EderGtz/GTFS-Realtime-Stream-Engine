import { Document } from "mongoose";

export interface IVehicleTelemetry extends Document {
    vehicle_id: string;
    trip_id: string;
    location: { // GeoJson format
        type: string;
        coordinates: number[]; // [longitude, latitude]
    };
    timestamp: Date;
}



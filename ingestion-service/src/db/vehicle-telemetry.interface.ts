import { Document } from "mongoose";

export interface IVehicleTelemetry {
    vehicle_id: string;
    trip_id: string;
    location: { // GeoJson format
        type: 'Point';
        coordinates: number[]; // [longitude, latitude]
    };
    timestamp: Date;
}



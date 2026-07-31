
export interface IVehicleTelemetry {
    vehicle_id: string;
    trip_id: string | null;
    route_id: string | null;
    location: { // GeoJson format
        type: 'Point';
        coordinates: number[]; // [longitude, latitude]
    };
    timestamp: Date;
}

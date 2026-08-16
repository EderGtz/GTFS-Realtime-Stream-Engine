
export interface IVehicleTelemetry {
    vehicle_id: string;
    trip_id: string | null; 
    route_id: string | null;

    location: { // GeoJson format
        type: 'Point';
        coordinates: number[]; // [longitude, latitude]
    };

    timestamp: Date;

    bearing?: number | null;
    speed?: number | null;

    current_stop_sequence?: number | null;
    stop_id?: string | null;
    current_status?: string | null;
}

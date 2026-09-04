import { join } from 'node:path';

try {
    process.loadEnvFile(join(process.cwd(), '.env'));
} catch (error: any) {
    if (error.code !== 'ENOENT') throw error; 
}

function envOrThrow(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`Could not find mandatory environment variable: ${key}`);
    return value;
}

export const config = {
    mbta: {
        vehiclePositionsUrl: "https://cdn.mbta.com/realtime/VehiclePositions.pb",
    },
    kafka: {
        brokers: [envOrThrow("KAFKA_BROKER")],
        topic: "raw.vehicle-positions",
        numPartitions: 4,
    }
};

export interface IVehicleTelemetry {
    vehicle_id: string;
    trip_id: string | null; 
    route_id: string | null;
    direction_id: number | null;

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

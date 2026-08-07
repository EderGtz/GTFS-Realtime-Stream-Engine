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
    },
    mongoUri: envOrThrow("MONGO_URI"),
};
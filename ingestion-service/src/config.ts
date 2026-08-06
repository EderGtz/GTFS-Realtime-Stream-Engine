function envOrThrow(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`Could not find ${key} env variable`);
    return value;
}

type DBConfig = {
    mongoUri: string
};

export const config = {
    mbta: {
        vehiclePositionsUrl: "https://cdn.mbta.com/realtime/VehiclePositions.pb",
    },
    kafka: {
        brokers: [envOrThrow("KAFKA_BROKER") ?? "localhost:9092"],
        topic: "raw.vehicle-positions",
        numPartitions: 4
    },
    // mongoUri: envOrThrow("MONGO_URI"),
};
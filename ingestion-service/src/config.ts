function envOrThrow(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`Could not find ${key} env variable`);
    return value;
}

export const config = {
    mbta: {
        vehiclePositionsUrl: "https://cdn.mbta.com/realtime/VehiclePositions.pb",
    },
    // mongoUri: envOrThrow("MONGO_URI"),
};
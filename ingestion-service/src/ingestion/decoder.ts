import { transit_realtime } from "../generated/gtfs-realtime.js";

export function decodeVehiclePositions(buffer: Uint8Array) {
    const message = transit_realtime.FeedMessage.decode(buffer);
    const jsonPayload = transit_realtime.FeedMessage.toObject(message, {
        enums: String,
        longs: String,
    });

    return jsonPayload;
}


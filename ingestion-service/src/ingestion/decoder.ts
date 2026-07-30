import { transit_realtime } from "../generated/gtfs-realtime.js";

interface DecodedVehiclePosition {
    id: string;
    vehicle: {
        trip: { 
            tripId?: string; 
            routeId?: string;
            scheduleRelationship?: string
        };
        vehicle?: { 
            id?: string; 
            label?: string 
        };
        position?: { 
            latitude: number; 
            longitude: number; 
            bearing?: number; 
            speed?: number 
        };
        currentStatus?: string;   // enums: String -> real strings like "IN_TRANSIT_TO"
        timestamp?: string;       // longs: String -> not Long objects
    };
}

interface DecodedFeedMessage {
    entity: DecodedVehiclePosition[];
}

export function decodeVehiclePositions(buffer: Uint8Array) {
    const message = transit_realtime.FeedMessage.decode(buffer);
    const jsonPayload = transit_realtime.FeedMessage.toObject(message, {
        enums: String,
        longs: String,
    }) as DecodedFeedMessage;
    // console.log(JSON.stringify(jsonPayload.entity?.[1], null, 2));

    return jsonPayload;
}


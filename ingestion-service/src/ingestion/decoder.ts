import { transit_realtime } from "../generated/gtfs-realtime.js";

export interface DecodedVehiclePosition {
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
        currentStopSequence?: number;
        stopId?: string;
        currentStatus?: string;
        
        timestamp?: string;
    };
}

export interface DecodedFeedMessage {
    entity: DecodedVehiclePosition[];
}

export function decodeFeedMessage(buffer: Uint8Array) {
    const message = transit_realtime.FeedMessage.decode(buffer);
    const jsonPayload = transit_realtime.FeedMessage.toObject(message, {
        enums: String,
        longs: String,
    }) as DecodedFeedMessage;
    // console.log(JSON.stringify(jsonPayload.entity?.[1], null, 2));

    return jsonPayload;
}


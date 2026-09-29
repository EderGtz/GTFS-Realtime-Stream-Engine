/**
 * Response types for GET /v1/delays/live.
 * Shapes match the MongoDB documents written by analytics-engine's
 * MetricsWriter, projected into the API response contract.
 */

/** GeoJSON Point — consistent with MongoDB's 2dsphere format. */
export interface GeoJsonPoint {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
}

/** One schedule deviation entry (arrival or departure). */
export interface DelayEntry {
    vehicle_id: string;
    trip_id: string;
    route_id: string | null;
    route_long_name: string | null;
    direction_id: number | null;
    kind: 'arrival' | 'departure';
    deviation_seconds: number;
    scheduled_at: string; // ISO 8601
    actual_at: string;    // ISO 8601
    location: GeoJsonPoint | null;
}

/** One bunching event — two vehicles too close for too long. */
export interface BunchingEntry {
    route_id: string;
    direction_id: number;
    vehicle_a: string;
    vehicle_b: string;
    start_time: string; // ISO 8601
    end_time: string;   // ISO 8601
    observation_count: number;
    min_distance_meters: number;
}

/** Metadata about the response for debugging / monitoring. */
export interface LiveResponseMeta {
    generated_at: string; // ISO 8601
    delay_count: number;
    bunching_count: number;
}

/** Full response shape for GET /v1/delays/live. */
export interface LiveResponse {
    delays: DelayEntry[];
    bunching: BunchingEntry[];
    meta: LiveResponseMeta;
}

/** Deviation statistics for a single route within the live window. */
export interface RouteDeviationStats {
    count: number;
    avg_seconds: number;
    p95_seconds: number;
    max_seconds: number;
    vehicles_on_time_pct: number;
}

/** Bunching statistics for a single route within the live window. */
export interface RouteBunchingStats {
    active_events: number;
    worst_distance_meters: number | null;
}

/** Full response shape for GET /v1/routes/:id/performance. */
export interface RoutePerformanceResponse {
    route_id: string;
    route_long_name: string | null;
    period: 'current';
    deviation: RouteDeviationStats;
    bunching: RouteBunchingStats;
}

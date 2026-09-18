import { Router } from 'express';
import type { ApiCollections } from '../../db/connection.js';
import type { DelayEntry, BunchingEntry, LiveResponse } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * How far back to look for "live" data.  Set to 3× the analytics engine's
 * processing interval (WINDOW_SECONDS = 60s) to cover:
 *   - the current window buffer (~60s)
 *   - one overlap cycle (~60s)
 *   - API polling jitter + processing lag (~60s)
 *
 * Data older than this is considered stale — the vehicle has moved on,
 * the bunching pair has separated, etc.
 */
const LIVE_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Router factory — receives the MongoDB collections via dependency injection
 * so the route handler stays testable (mock collections, not the whole app).
 */
export function createStatusRouter(collections: ApiCollections): Router {
    const router = Router();

    router.get('/status/live', async (_req, res, next) => {
        const start = Date.now();
        try {
            const cutoff = new Date(Date.now() - LIVE_WINDOW_MS);

            const [deviationDocs, bunchingDocs] = await Promise.all([
                collections.deviations
                    .find({ actual_at: { $gte: cutoff } }, { projection: { _id: 0 } })
                    .toArray(),
                collections.bunching
                    .find({ end_time: { $gte: cutoff } }, { projection: { _id: 0 } })
                    .toArray(),
            ]);

            const delays: DelayEntry[] = deviationDocs.map((doc) => ({
                vehicle_id: doc['vehicle_id'] as string,
                trip_id: doc['trip_id'] as string,
                route_id: (doc['route_id'] as string | undefined) ?? null,
                route_long_name: (doc['route_long_name'] as string | undefined) ?? null,
                direction_id: (doc['direction_id'] as number | undefined) ?? null,
                kind: doc['kind'] as 'arrival' | 'departure',
                deviation_seconds: doc['deviation_seconds'] as number,
                scheduled_at: new Date(doc['scheduled_at'] as string | Date).toISOString(),
                actual_at: new Date(doc['actual_at'] as string | Date).toISOString(),
                location: (doc['location'] as DelayEntry['location']) ?? null,
            }));

            const bunching: BunchingEntry[] = bunchingDocs.map((doc) => ({
                route_id: doc['route_id'] as string,
                direction_id: doc['direction_id'] as number,
                vehicle_a: doc['vehicle_a'] as string,
                vehicle_b: doc['vehicle_b'] as string,
                start_time: new Date(doc['start_time'] as string | Date).toISOString(),
                end_time: new Date(doc['end_time'] as string | Date).toISOString(),
                observation_count: doc['observation_count'] as number,
                min_distance_meters: doc['min_distance_meters'] as number,
            }));

            const response: LiveResponse = {
                delays,
                bunching,
                meta: {
                    generated_at: new Date().toISOString(),
                    delay_count: delays.length,
                    bunching_count: bunching.length,
                },
            };

            logger.info(
                { delay_count: delays.length, bunching_count: bunching.length, duration_ms: Date.now() - start },
                'GET /v1/status/live served',
            );
            res.json(response);
        } catch (err) {
            next(err);
        }
    });

    return router;
}

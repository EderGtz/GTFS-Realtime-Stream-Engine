import { Router } from 'express';
import type { ApiCollections } from '../../db/connection.js';
import type { RoutePerformanceResponse, RouteDeviationStats, RouteBunchingStats } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Same 3-minute live window as the /v1/status/live endpoint.
 */
const LIVE_WINDOW_MS = 3 * 60 * 1000;

/**
 * APTA standard: a vehicle is "on time" when its absolute deviation
 * from schedule is ≤ 3 minutes.
 */
const ON_TIME_THRESHOLD_SECONDS = 180;

/**
 * Nearest-rank percentile (no external dependency).
 * Input must be sorted ascending.
 * Returns 0 for an empty array.
 */
export function computeP95(sorted: number[]): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0]!;

    const floatIndex = 0.95 * (sorted.length - 1);

    const lowerIndex = Math.max(0, Math.floor(floatIndex));
    const upperIndex = Math.min(sorted.length - 1, Math.ceil(floatIndex));
    const weight = floatIndex - lowerIndex;

    const lowerValue = sorted[lowerIndex] ?? 0;
    const upperValue = sorted[upperIndex] ?? 0;

    return lowerValue * (1 - weight) + upperValue * weight;
}

/**
 * Router factory that receives MongoDB collections via dependency injection
 *
 * Mounts:  GET /v1/routes/:id/performance
 *
 * Uses MongoDB aggregation pipelines on the existing schedule_deviations
 * and bunching_events collections to compute route-level statistics.
 */
export function createRoutePerformanceRouter(collections: ApiCollections): Router {
    const router = Router();

    router.get('/routes/:id/performance', async (req, res, next) => {
        const start = Date.now();
        try {
            const routeId = req.params.id;

            // only allow alphanumeric route IDs (e.g. "28", "Red", "Green-D").
            const VALID_ROUTE_ID = /^[A-Za-z0-9-]+$/;
            
            if (!routeId || !VALID_ROUTE_ID.test(routeId)) {
                res.status(400).json({ error: 'Invalid route ID format' });
                return;
            }
            const cutoff = new Date(Date.now() - LIVE_WINDOW_MS);

            const [deviationPipeline, bunchingPipeline] = await Promise.all([

                // --- Deviation aggregation ---
                // Filters to the requested route within the live window,
                // then computes: count, average absolute deviation, max
                // absolute deviation, on-time count, and collects all
                // absolute deviation values for p95 (computed in JS below
                // because $percentile's syntax varies across MongoDB versions
                // and the live window keeps the array small).
                collections.deviations.aggregate([
                    {
                        $match: {
                            route_id: routeId,
                            actual_at: { $gte: cutoff },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            count: { $sum: 1 },
                            avg_abs: { $avg: { $abs: '$deviation_seconds' } },
                            max_abs: { $max: { $abs: '$deviation_seconds' } },
                            all_abs: { $push: { $abs: '$deviation_seconds' } },
                            on_time_count: {
                                $sum: {
                                    $cond: [
                                        { $lte: [{ $abs: '$deviation_seconds' }, ON_TIME_THRESHOLD_SECONDS] },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            route_long_name: { $first: '$route_long_name' },
                        },
                    },
                ]).toArray(),

                // --- Bunching aggregation ---
                // Active events = those whose end_time is within the live
                // window (the pair is still bunched).  worst_distance =
                // the closest any active pair has been.
                collections.bunching.aggregate([
                    {
                        $match: {
                            route_id: routeId,
                            end_time: { $gte: cutoff },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            active_events: { $sum: 1 },
                            worst_distance_meters: { $min: '$min_distance_meters' },
                        },
                    },
                ]).toArray(),
            ]);

            // --- Extract deviation stats ---
            const devDoc = deviationPipeline[0] as
                | {
                      count: number;
                      avg_abs: number;
                      max_abs: number;
                      all_abs: number[];
                      on_time_count: number;
                      route_long_name: string | null;
                  }
                | undefined;

            let deviation: RouteDeviationStats;
            let routeLongName: string | null = null;

            if (devDoc && devDoc.count > 0) {
                // Sort absolute deviations for p95 computation
                const sorted = [...devDoc.all_abs].sort((a, b) => a - b);

                deviation = {
                    count: devDoc.count,
                    avg_seconds: Math.round(devDoc.avg_abs),
                    p95_seconds: Math.round(computeP95(sorted)),
                    max_seconds: Math.round(devDoc.max_abs),
                    vehicles_on_time_pct:
                        Math.round(
                            (devDoc.on_time_count / devDoc.count) * 1000,
                        ) / 10,
                };
                routeLongName = devDoc.route_long_name ?? null;
            } else {
                deviation = {
                    count: 0,
                    avg_seconds: 0,
                    p95_seconds: 0,
                    max_seconds: 0,
                    vehicles_on_time_pct: 0,
                };
            }

            // --- Extract bunching stats ---
            const bunchDoc = bunchingPipeline[0] as
                | { active_events: number; worst_distance_meters: number }
                | undefined;

            const bunching: RouteBunchingStats = {
                active_events: bunchDoc?.active_events ?? 0,
                worst_distance_meters: bunchDoc?.worst_distance_meters ?? null,
            };

            // --- Build response ---
            const response: RoutePerformanceResponse = {
                route_id: routeId,
                route_long_name: routeLongName,
                period: 'current',
                deviation,
                bunching,
            };

            logger.info(
                {
                    route_id: routeId,
                    deviation_count: deviation.count,
                    bunching_count: bunching.active_events,
                    duration_ms: Date.now() - start,
                },
                'GET /v1/routes/:id/performance served',
            );

            res.json(response);
        } catch (err) {
            next(err);
        }
    });

    return router;
}
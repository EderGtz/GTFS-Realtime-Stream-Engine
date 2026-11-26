import { Router } from 'express';
import type pg from 'pg';
import type { RouteHistoryResponse, HourlyDataPoint } from '../types.js';
import { isValidRouteId } from '../validation.js';
import {
    identityResolver,
    UNKNOWN_ROUTE_HINT,
    type RouteResolver,
} from '../routeCatalog.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

/**
 * Router factory that receives a PostgreSQL pool via dependency injection.
 *
 * Mounts:  GET /v1/routes/:id/history?days=7
 *
 * Queries the route_hourly_stats table written by the analytics engine's
 * HourlyAccumulator + PgWriter. Returns hourly punctuality trend data
 * for the requested route over the last N days.
 *
 * `resolveRoute` canonicalizes the incoming ID (case-insensitive) and
 * identifies unknown IDs so they get a 404 instead of a silently empty
 * result — see routeCatalog.ts. Defaults to identity passthrough.
 */
export function createRouteHistoryRouter(
    pgPool: pg.Pool,
    resolveRoute: RouteResolver = identityResolver,
): Router {
    const router = Router();

    router.get('/routes/:id/history', async (req, res, next) => {
        const start = Date.now();
        try {
            const routeId = req.params.id;

            if (!isValidRouteId(routeId)) {
                res.status(400).json({ error: 'Invalid route ID format' });
                return;
            }

            const canonicalId = await resolveRoute(routeId);
            if (canonicalId === null) {
                res.status(404).json({
                    error: 'No route with that ID found',
                    hint: UNKNOWN_ROUTE_HINT,
                });
                return;
            }

            // Parse and clamp the days parameter.
            let days = parseInt(req.query.days as string, 10);
            if (isNaN(days) || days < 1) days = DEFAULT_DAYS;
            if (days > MAX_DAYS) days = MAX_DAYS;

            const result = await pgPool.query(
                `SELECT hour, avg_deviation, p95_deviation,
                        vehicle_count, on_time_pct, bunching_events
                 FROM route_hourly_stats
                 WHERE route_id = $1
                   AND hour >= NOW() - ($2 || ' days')::interval
                 ORDER BY hour ASC`,
                [canonicalId, days.toString()],
            );

            const dataPoints: HourlyDataPoint[] = result.rows.map((row) => ({
                hour: new Date(row.hour).toISOString(),
                avg_deviation: Math.round(row.avg_deviation * 10) / 10,
                p95_deviation: Math.round(row.p95_deviation),
                vehicle_count: row.vehicle_count,
                on_time_pct: Math.round(row.on_time_pct * 10) / 10,
                bunching_events: row.bunching_events,
            }));

            const response: RouteHistoryResponse = {
                route_id: canonicalId,
                days,
                data_points: dataPoints,
            };

            logger.info(
                {
                    route_id: canonicalId,
                    days,
                    data_points: dataPoints.length,
                    duration_ms: Date.now() - start,
                },
                'GET /v1/routes/:id/history served',
            );

            res.json(response);
        } catch (err) {
            next(err);
        }
    });

    return router;
}
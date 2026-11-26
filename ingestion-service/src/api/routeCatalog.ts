/**
 * Case-insensitive route-ID resolution for the /v1/routes/:id/... endpoints.
 *
 * WHY: MBTA route IDs are stored exactly as published (`Orange`, `Green-B`,
 * `CR-Providence`, `34E`) and both backends match `route_id` exactly, so a
 * user typing `orange` or `green-b` got an empty result that read like data
 * loss. This module maps any casing to the canonical ID the data actually
 * uses, once, at the API edge — the hot queries stay exact-match on indexed
 * columns. It doubles as the "does this route exist at all?" oracle so the
 * endpoints can 404 unknown IDs instead of returning misleading empty data.
 *
 */

import type pg from 'pg';
import type { ApiCollections } from '../db/connection.js';
import { logger } from '../utils/logger.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

export type RouteResolver = (input: string) => Promise<string | null>;
export const identityResolver: RouteResolver = (input) => Promise.resolve(input);

export const UNKNOWN_ROUTE_HINT =
    'Try a route ID like 1, 28, Red or Green-D. This search takes route IDs, not vehicle IDs.';

export interface RouteResolverSources {
    collections?: ApiCollections | undefined;
    pgPool?: pg.Pool | undefined;
}

export function createRouteResolver(sources: RouteResolverSources): RouteResolver {
    let byLower: Map<string, string> | null = null;
    let builtAt = 0;

    async function build(): Promise<Map<string, string>> {
        const ids = new Set<string>();
        let attempted = 0;
        let failed = 0;
        let lastError: unknown;

        async function addFrom(load: () => Promise<unknown[]>): Promise<void> {
            attempted += 1;
            try {
                for (const id of await load()) {
                    if (typeof id === 'string' && id.length > 0) ids.add(id);
                }
            } catch (err) {
                failed += 1;
                lastError = err;
                logger.warn({ err }, 'route catalog source failed');
            }
        }

        if (sources.collections) {
            await addFrom(() => sources.collections!.deviations.distinct('route_id'));
            await addFrom(() => sources.collections!.bunching.distinct('route_id'));
        }
        if (sources.pgPool) {
            await addFrom(async () => {
                const result = await sources.pgPool!.query(
                    'SELECT DISTINCT route_id FROM route_hourly_stats',
                );
                return result.rows.map((row) => row.route_id);
            });
        }

        if (attempted > 0 && failed === attempted) {
            throw lastError instanceof Error
                ? lastError
                : new Error('route catalog: all sources failed');
        }

        const map = new Map<string, string>();
        for (const id of ids) {
            // First canonical wins if two IDs differ only by case (not the
            // case in real MBTA data, but the map must stay total).
            const key = id.toLowerCase();
            if (!map.has(key)) map.set(key, id);
        }
        return map;
    }

    return async function resolve(input: string): Promise<string | null> {
        const now = Date.now();
        if (byLower === null || now - builtAt > CACHE_TTL_MS) {
            byLower = await build();
            builtAt = now;
        }
        return byLower.get(input.toLowerCase()) ?? null;
    };
}

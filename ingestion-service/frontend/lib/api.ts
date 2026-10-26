/**
 * Typed fetch wrappers for the read-only public API.
 *
 * Every response is parsed as the exact interface the API itself declares in
 * src/api/types.ts, so the frontend no longer "just
 * assumes" shapes like `p.on_time_pct` or `d.avg_seconds` — when an API
 * shape changes, `npm run build:frontend` fails and points at every consumer
 * instead of us discovering the break as a rendered "undefined" in a panel.
 *
 * The endpoint paths live here so a route rename is also a
 * compile-time findable change.
 */

import type {
    LiveResponse,
    RouteHistoryResponse,
    RoutePerformanceResponse,
} from '../../src/api/types.js';

/**
 * Thrown for non-2xx responses so callers can branch on the status code
 * (the route-search panel shows a different message for HTTP 400 than for
 * other server errors). `message` keeps the s "HTTP 503" format so
 * existing error strings/tests are unchanged.
 */
export class ApiError extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`HTTP ${status}`);
        this.name = 'ApiError';
        this.status = status;
    }
}

/**
 * GET `url` and parse the JSON body as `T`.
 * Throws ApiError on non-OK responses; network failures reject with the
 * underlying fetch error (callers distinguish via `instanceof ApiError`).
 */
async function getJson<T>(url: string): Promise<T> {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new ApiError(resp.status);
    }
    return (await resp.json()) as T;
}

/**
 * GET /v1/status/live:the live map payload (delays, bunching, meta).
 * Polled every REFRESH_INTERVAL_MS by the map refresh loop.
 */
export function fetchLiveData(): Promise<LiveResponse> {
    return getJson<LiveResponse>('/v1/status/live');
}

/**
 * GET /v1/routes/:id/performance: current-window stats for one route
 */
export function fetchRoutePerformance(routeId: string): Promise<RoutePerformanceResponse> {
    return getJson<RoutePerformanceResponse>(
        `/v1/routes/${encodeURIComponent(routeId)}/performance`,
    );
}

/**
 * GET /v1/routes/:id/history?days=N: hourly trend points for the history
 * chart. `days` is clamped server-side (1..90).
 */
export function fetchRouteHistory(routeId: string, days: number): Promise<RouteHistoryResponse> {
    return getJson<RouteHistoryResponse>(
        `/v1/routes/${encodeURIComponent(routeId)}/history?days=${days}`,
    );
}

/**
 * Route-ID validation for the /v1/routes/:id/... endpoints.
 *
 * FUTURE FIX (if this API ever echoes route IDs into HTML): output-encode at
 * render time — input validation is not an XSS control.
 */

export const MAX_ROUTE_ID_LENGTH = 64;

/** True when the (already URL-decoded) route ID is safe to query with. */
export function isValidRouteId(routeId: string | undefined): boolean {
    if (typeof routeId !== 'string' || routeId.length === 0) return false;
    if (routeId.length > MAX_ROUTE_ID_LENGTH) return false;
    // Control characters never appear in GTFS IDs and would corrupt log
    // lines (log injection) if passed through.
    if (/[\x00-\x1f\x7f]/.test(routeId)) return false;
    return true;
}

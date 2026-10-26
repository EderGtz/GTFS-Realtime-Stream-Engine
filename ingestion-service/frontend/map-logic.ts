/**
 * Stateful core behind the live transit map.
 *
 * WHAT THIS FILE OWNS:
 *   - marker caches (delay markers + bunching events) and their eviction
 *   - popup HTML builders for both marker kinds
 *   - the data-age indicator and the stats panel
 *   - the route filter (dim everything except one route)
 *
 * Everything here is exercised by tests/api/map-logic.test.ts, which mocks
 * the Leaflet global (`L`) — every function that touches Leaflet receives
 * its layer objects as parameters for exactly that reason.
 */

/// <reference path="./globals.d.ts" />

// Shared contract types — the SAME interfaces the API declares. If the API
// shape changes, this module and every consumer fail to compile.
import type { BunchingEntry, DelayEntry } from '../src/api/types.js';
import { formatAge } from './lib/format.js';

// Leaflet TYPE names (values still come from the `L` CDN global declared in
// globals.d.ts). Named type imports avoid shadowing the `L` value binding.
import type { CircleMarker, LayerGroup, Polyline } from 'leaflet';

// ── Constants ────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 30_000;

// How long before the data is considered stale (matches LIVE_WINDOW_MS / 2
// on the server side. If the server filters at 3 min, we warn at 90s and
// go red at 3 min).
const STALE_WARN_MS  = 90_000;   // 1.5 min — yellow
const STALE_ERROR_MS = 180_000;  // 3 min  — red

const GRACE_REFRESHES = 2;
const STALE_OPACITY   = 0.35;

const BUNCHING_COLOR        = '#9b59b6';
const BUNCHING_BORDER_COLOR = '#6c3483';

// Boston city center. Typed as a LatLngTuple so Leaflet's strict typings
// accept it (a widened number[] would not).
const MAP_CENTER: [number, number] = [42.3601, -71.0589];
const MAP_ZOOM = 12;

// ── Types ────────────────────────────────────────────────────────────────

/** A cached delay marker plus its eviction bookkeeping. */
interface DelayMarkerEntry {
    marker: CircleMarker;
    /** Consecutive refreshes this vehicle was absent from. */
    misses: number;
    route_id: string | null;
}

/**
 * A cached bunching event. Exactly three slots: circle for vehicle A,
 * circle for vehicle B, and the connecting polyline. Any of them may be
 * null when the vehicle's position was unavailable at creation time.
 */
interface BunchingMarkerEntry {
    markers: [CircleMarker | null, CircleMarker | null, Polyline | null];
    /** Consecutive refreshes this event was absent from. */
    misses: number;
    route_id: string | null;
}

/** Leaflet position tuple ([lat, lon] — Leaflet order, not GeoJSON order). */
type LatLon = [number, number];

/**
 * Input accepted by formatBunchingPopup. The API contract (BunchingEntry)
 * has no route_long_name, but the original popup code used the
 * `route_long_name || route_id` fallback and the tests exercise it — the
 * optional enrichment keeps that behavior available if the API ever adds it.
 */
type BunchingPopupEntry = BunchingEntry & { route_long_name?: string | null };

// ── State ────────────────────────────────────────────────────────────────

// Map<vehicleId, DelayMarkerEntry>
const delayCache = new Map<string, DelayMarkerEntry>();

// Map<bunchKey, BunchingMarkerEntry>
const bunchingCache = new Map<string, BunchingMarkerEntry>();

let lastRefreshTime: Date | null = null;
let ageTimer: ReturnType<typeof setInterval> | null = null;
let activeRouteFilter: string | null = null;  // null = show all, string = route_id to highlight

// ── Helpers ──────────────────────────────────────────────────────────────

function deviationColor(seconds: number): string {
    if (seconds < -120) return '#3498db';   // early
    if (seconds <= 120)  return '#2ecc71';  // on time
    if (seconds <= 300)  return '#f1c40f';  // slightly late
    if (seconds <= 600)  return '#e67e22';  // late
    return '#e74c3c';                       // very late
}

function deviationLabel(seconds: number): string {
    const absMin = Math.abs(Math.round(seconds / 60));
    if (seconds < -120) return `${absMin} min early`;
    if (seconds <= 120)  return 'on time';
    return `${absMin} min late`;
}

// formatAge() lives in lib/format.ts (shared with other panels).

// ── Cache keys ───────────────────────────────────────────────────────────

function delayMarkerKey(entry: DelayEntry): string {
    return entry.vehicle_id;
}

function bunchingKey(entry: BunchingEntry): string {
    return `${entry.route_id}:${entry.vehicle_a}:${entry.vehicle_b}`;
}

// ── Popup formatters ─────────────────────────────────────────────────────

function formatPopup(entry: DelayEntry): string {
    const routeName = entry.route_long_name || entry.route_id || 'Unknown route';
    const dev = deviationLabel(entry.deviation_seconds);
    return `
        <div style="font-family:sans-serif; min-width:180px">
            <strong>Route ${routeName}</strong><br>
            Vehicle: ${entry.vehicle_id}<br>
            Status: ${dev} (${Math.round(entry.deviation_seconds)}s)<br>
            <small>${entry.kind} at trip ${entry.trip_id || '\u2014'}</small><br>
            <small style="color:#888">Route ID: <strong>${entry.route_id || '\u2014'}</strong> — search this in the 🔍 panel</small>
        </div>
    `;
}

function formatBunchingPopup(entry: BunchingPopupEntry): string {
    const routeName = entry.route_long_name || entry.route_id || 'Unknown route';
    const dist = Math.round(entry.min_distance_meters);
    // .getTime() is required for the subtraction to type-check; the runtime
    // value is identical to the old `new Date(a) - new Date(b)` coercion.
    const durMs = new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime();
    const durMin = Math.floor(durMs / 60000);
    const durSec = Math.floor((durMs % 60000) / 1000);
    const durLabel = durMin > 0 ? `${durMin}m ${durSec}s` : `${durSec}s`;
    return `
        <div style="font-family:sans-serif; min-width:200px">
            <strong>\u26A0 Bunching event</strong>
            <table style="margin-top:6px; font-size:13px; border-collapse:collapse">
                <tr>
                    <td style="padding:2px 8px 2px 0; color:#666">Route</td>
                    <td style="padding:2px 0">${routeName}</td>
                </tr>
                <tr>
                    <td style="padding:2px 8px 2px 0; color:#666">Vehicles</td>
                    <td style="padding:2px 0">${entry.vehicle_a} + ${entry.vehicle_b}</td>
                </tr>
                <tr>
                    <td style="padding:2px 8px 2px 0; color:#666">Minimum distance</td>
                    <td style="padding:2px 0">${dist} m</td>
                </tr>
                <tr>
                    <td style="padding:2px 8px 2px 0; color:#666">Duration</td>
                    <td style="padding:2px 0">${durLabel}</td>
                </tr>
                <tr>
                    <td style="padding:2px 8px 2px 0; color:#666">Route ID</td>
                    <td style="padding:2px 0">${entry.route_id || '\u2014'}</td>
                </tr>
            </table>
        </div>
    `;
}

// ── Vehicle position index ───────────────────────────────────────────────

/**
 * Deduplicate delays by vehicle_id (keep the most recent per vehicle),
 * then build a Map<vehicleId, [lat, lon]> from those with location data.
 *
 * Returns { uniqueDelays, positions }.
 */
function buildVehiclePositions(delays: DelayEntry[]): {
    uniqueDelays: DelayEntry[];
    positions: Map<string, LatLon>;
} {
    // Deduplicate: when a vehicle has multiple deviation documents (one per
    // stop it visited), keep only the most recent one: that's where the
    // vehicle actually is right now.
    const latestByVehicle = new Map<string, DelayEntry>();
    for (const d of delays) {
        const existing = latestByVehicle.get(d.vehicle_id);
        if (!existing || new Date(d.actual_at) > new Date(existing.actual_at)) {
            latestByVehicle.set(d.vehicle_id, d);
        }
    }

    const uniqueDelays = [...latestByVehicle.values()];

    const positions = new Map<string, LatLon>();
    for (const d of uniqueDelays) {
        if (d.location && d.location.coordinates) {
            const [lon, lat] = d.location.coordinates;
            positions.set(d.vehicle_id, [lat, lon]);
        }
    }

    return { uniqueDelays, positions };
}

// ── Delay markers ────────────────────────────────────────────────────────

function createDelayMarker(
    delay: DelayEntry,
    position: LatLon,
    color: string,
    popup: string,
    delayLayer: LayerGroup,
): DelayMarkerEntry {
    const marker = L.circleMarker(position, {
        radius: 6,
        fillColor: color,
        color: '#333',
        weight: 1,
        fillOpacity: 0.85,
    })
    .bindPopup(popup)
    .addTo(delayLayer);

    return { marker, misses: 0, route_id: delay.route_id || null };
}

function updateDelayMarker(
    cacheEntry: DelayMarkerEntry,
    position: LatLon,
    color: string,
    popup: string,
    routeId?: string | null,
): void {
    const { marker } = cacheEntry;
    marker.setLatLng(position);
    marker.setStyle({ fillColor: color });
    marker.setPopupContent(popup);
    if (routeId !== undefined) cacheEntry.route_id = routeId;
    const dimmed = Boolean(activeRouteFilter && cacheEntry.route_id !== activeRouteFilter);
    marker.setStyle({ fillOpacity: dimmed ? FILTER_DIM_OPACITY : 0.85, opacity: dimmed ? FILTER_DIM_STROKE : 1 });
    cacheEntry.misses = 0;
}

/**
 * Create / update delay markers from the current delays array.
 * Returns the Set of seen vehicle IDs.
 */
function updateDelayMarkers(delays: DelayEntry[], delayLayer: LayerGroup): Set<string> {
    const seen = new Set<string>();

    for (const d of delays) {
        if (!d.location || !d.location.coordinates) continue;

        const key = delayMarkerKey(d);
        seen.add(key);

        const [lon, lat] = d.location.coordinates;
        const position: LatLon = [lat, lon];
        const color = deviationColor(d.deviation_seconds);
        const popup = formatPopup(d);

        const cached = delayCache.get(key);
        if (cached) {
            updateDelayMarker(cached, position, color, popup, d.route_id);
        } else {
            delayCache.set(key, createDelayMarker(d, position, color, popup, delayLayer));
        }
    }

    evictStaleDelays(seen, delayLayer);
    return seen;
}

function evictStaleDelays(seenIds: Set<string>, delayLayer: LayerGroup): void {
    for (const [key, entry] of delayCache) {
        if (seenIds.has(key)) continue;

        entry.misses++;
        if (entry.misses >= GRACE_REFRESHES) {
            delayLayer.removeLayer(entry.marker);
            delayCache.delete(key);
        } else {
            // Dim the marker to show it's going stale
            entry.marker.setStyle({
                fillOpacity: STALE_OPACITY,
                opacity: 0.4,
            });
        }
    }
}

// ── Bunching markers ─────────────────────────────────────────────────────

function createBunchingEvent(
    bunching: BunchingEntry,
    positionA: LatLon | undefined,
    positionB: LatLon | undefined,
    popup: string,
    bunchingLayer: LayerGroup,
): BunchingMarkerEntry {
    const markers: [CircleMarker | null, CircleMarker | null, Polyline | null] = [null, null, null];

    const opts = {
        radius: 7,
        fillColor: BUNCHING_COLOR,
        color: BUNCHING_BORDER_COLOR,
        weight: 2,
        fillOpacity: 0.9,
    };

    if (positionA) {
        markers[0] = L.circleMarker(positionA, opts)
            .bindPopup(popup)
            .addTo(bunchingLayer);
    }
    if (positionB) {
        markers[1] = L.circleMarker(positionB, opts)
            .bindPopup(popup)
            .addTo(bunchingLayer);
    }
    if (positionA && positionB) {
        markers[2] = L.polyline([positionA, positionB], {
            color: BUNCHING_COLOR,
            weight: 3,
            opacity: 0.7,
            dashArray: '6, 8',
        })
        .bindPopup(popup)
        .addTo(bunchingLayer);
    }

    return { markers, misses: 0, route_id: bunching.route_id || null };
}

function updateBunchingEvent(
    entry: BunchingMarkerEntry,
    positionA: LatLon | undefined,
    positionB: LatLon | undefined,
    popup: string,
    routeId?: string | null,
): void {
    const [circleA, circleB, line] = entry.markers;
    if (routeId !== undefined) entry.route_id = routeId;
    const dimmed = Boolean(activeRouteFilter && entry.route_id !== activeRouteFilter);

    if (circleA && positionA) {
        circleA.setLatLng(positionA);
        circleA.setPopupContent(popup);
        circleA.setStyle({ fillOpacity: dimmed ? FILTER_DIM_OPACITY : 0.9, opacity: dimmed ? FILTER_DIM_STROKE : 1 });
    }
    if (circleB && positionB) {
        circleB.setLatLng(positionB);
        circleB.setPopupContent(popup);
        circleB.setStyle({ fillOpacity: dimmed ? FILTER_DIM_OPACITY : 0.9, opacity: dimmed ? FILTER_DIM_STROKE : 1 });
    }
    if (line && positionA && positionB) {
        line.setLatLngs([positionA, positionB]);
        line.setPopupContent(popup);
        line.setStyle({ opacity: dimmed ? FILTER_DIM_STROKE : 0.7 });
    }

    /*
     * BUG PRESERVED:
     *
     * If circleA, circleB or line was null when the bunching event was first
     * created (because one vehicle's position wasn't available yet), this
     * function does not create the missing object later when its position
     * becomes available.  This is a known limitation.
     */

    entry.misses = 0;
}

function updateBunchingMarkers(
    bunchingEvents: BunchingEntry[],
    vehiclePositions: Map<string, LatLon>,
    bunchingLayer: LayerGroup,
): Set<string> {
    const seen = new Set<string>();

    for (const b of bunchingEvents) {
        const key = bunchingKey(b);
        seen.add(key);

        const positionA = vehiclePositions.get(b.vehicle_a);
        const positionB = vehiclePositions.get(b.vehicle_b);
        const popup = formatBunchingPopup(b);

        const cached = bunchingCache.get(key);
        if (cached) {
            updateBunchingEvent(cached, positionA, positionB, popup, b.route_id);
        } else {
            bunchingCache.set(key,
                createBunchingEvent(b, positionA, positionB, popup, bunchingLayer)
            );
        }
    }

    evictStaleBunching(seen, bunchingLayer);
    return seen;
}

/**
 * Evicts or visually dims stale bunching events that were missing from the latest API update.
 * Implements a grace period (GRACE_REFRESHES) to prevent visual flickering on the map
 * caused by temporary processing lags or momentary GPS signal loss.
 *
 * If an event misses too many consecutive updates, its markers are removed from the map and cache.
 * Otherwise, its opacity is reduced to indicate that the data is becoming stale.
 *
 * @param seenKeys - A set containing the unique keys of bunching events received in the current refresh.
 * @param bunchingLayer - The Leaflet layer group containing the bunching markers and polylines.
 */
function evictStaleBunching(seenKeys: Set<string>, bunchingLayer: LayerGroup): void {
    for (const [key, entry] of bunchingCache) {
        if (seenKeys.has(key)) continue;

        entry.misses++;
        if (entry.misses >= GRACE_REFRESHES) {
            for (const m of entry.markers) {
                if (m) bunchingLayer.removeLayer(m);
            }
            bunchingCache.delete(key);
        } else {
            for (const m of entry.markers) {
                if (!m) continue;
                if (m instanceof L.Polyline && !(m instanceof L.Polygon)) {
                    m.setStyle({ opacity: 0.25 });
                } else {
                    m.setStyle({ fillOpacity: STALE_OPACITY, opacity: 0.4 });
                }
            }
        }
    }
}

// ── Data-age indicator ───────────────────────────────────────────────────

/**
 * Updates the UI data-age indicator to show how old the currently displayed map data is.
 * Acts as a visual health monitor, changing colors (fresh -> warning -> stale)
 * as the data ages past predefined thresholds to warn users of potential connection or pipeline failures.
 */
function updateAgeIndicator(): void {
    const ageEl = document.getElementById('data-age');
    if (!ageEl || !lastRefreshTime) return;

    const age = Date.now() - lastRefreshTime.getTime();

    if (age >= STALE_ERROR_MS) {
        ageEl.innerHTML = `<span class="stale">Data stale \u2014 last update ${formatAge(age)} ago</span>`;
    } else if (age >= STALE_WARN_MS) {
        ageEl.innerHTML = `<span style="color:#e67e22">Data age: ${formatAge(age)}</span>`;
    } else {
        ageEl.innerHTML = `<span class="fresh">Data age: ${formatAge(age)}</span>`;
    }
}

function startAgeTimer(): void {
    if (ageTimer) return;
    ageTimer = setInterval(updateAgeIndicator, 1000);
}

// ── Stats ────────────────────────────────────────────────────────────────

function updateStats(uniqueDelays: DelayEntry[], bunchingCount: number): void {
    lastRefreshTime = new Date();

    const statsEl = document.getElementById('stats');
    if (!statsEl) return;

    const generated = lastRefreshTime.toLocaleTimeString();
    statsEl.innerHTML = `
        <strong>MBTA Live</strong><br>
        ${uniqueDelays.length} vehicles with deviations<br>
        ${bunchingCount} bunching events<br>
        <small>Updated: ${generated}</small><br>
        <small id="data-age"></small>
    `;

    updateAgeIndicator();
}

// ── Error handling ───────────────────────────────────────────────────────

function handleRefreshError(err: unknown): void {
    console.error('Failed to refresh:', err);

    const statsEl = document.getElementById('stats');
    if (!statsEl) return;

    if (lastRefreshTime) {
        statsEl.innerHTML = `
            <span style="color:red">Connection error</span><br>
            <small id="data-age"></small>
        `;
        updateAgeIndicator();
    } else {
        statsEl.innerHTML = '<span style="color:red">Connection error</span>';
    }
}

// ── Route filter ─────────────────────────────────────────────────────────

const FILTER_DIM_OPACITY = 0.12;
const FILTER_DIM_STROKE = 0.2;

/**
 * Apply the active route filter to all delay markers.
 * Called after every refresh cycle so new markers respect the filter.
 */
function applyRouteFilter(): void {
    if (!activeRouteFilter) return;
    for (const [, entry] of delayCache) {
        if (entry.route_id === activeRouteFilter) {
            entry.marker.setStyle({ fillOpacity: 0.85, opacity: 1 });
        } else {
            entry.marker.setStyle({ fillOpacity: FILTER_DIM_OPACITY, opacity: FILTER_DIM_STROKE });
        }
    }
    for (const [, entry] of bunchingCache) {
        const match = entry.route_id === activeRouteFilter;
        for (const m of entry.markers) {
            if (!m) continue;
            if (m instanceof L.Polyline && !(m instanceof L.Polygon)) {
                m.setStyle({ opacity: match ? 0.7 : FILTER_DIM_STROKE });
            } else {
                m.setStyle({ fillOpacity: match ? 0.9 : FILTER_DIM_OPACITY, opacity: match ? 1 : FILTER_DIM_STROKE });
            }
        }
    }
}

/**
 * Filter the map to show only markers for a specific route.
 * Other markers are dimmed to near-invisible.
 */
function filterByRoute(routeId: string | null): void {
    activeRouteFilter = routeId;
    applyRouteFilter();
    updateFilterBanner();
}

/**
 * Clear the route filter — show all markers at full opacity.
 */
function clearRouteFilter(): void {
    activeRouteFilter = null;
    for (const [, entry] of delayCache) {
        entry.marker.setStyle({ fillOpacity: 0.85, opacity: 1 });
    }
    for (const [, entry] of bunchingCache) {
        for (const m of entry.markers) {
            if (!m) continue;
            if (m instanceof L.Polyline && !(m instanceof L.Polygon)) {
                m.setStyle({ opacity: 0.7 });
            } else {
                m.setStyle({ fillOpacity: 0.9, opacity: 1 });
            }
        }
    }
    updateFilterBanner();
}

function getActiveRouteFilter(): string | null { return activeRouteFilter; }

/**
 * Show/hide a small banner indicating an active route filter.
 * Uses addEventListener instead of inline onclick — CSP blocks inline handlers.
 */
function updateFilterBanner(): void {
    let banner = document.getElementById('route-filter-banner');
    if (!activeRouteFilter) {
        if (banner) banner.style.display = 'none';
        return;
    }
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'route-filter-banner';
        banner.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);' +
            'z-index:1000;background:#333;color:#fff;padding:6px 14px;border-radius:20px;' +
            'font-size:12px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(banner);
    }
    // Build content without inline handlers
    banner.textContent = '';
    const text = document.createElement('span');
    text.innerHTML = 'Showing route <strong>' + activeRouteFilter + '</strong> ';
    banner.appendChild(text);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Show all routes';
    closeBtn.style.cssText = 'background:none;border:none;color:#fff;cursor:pointer;font-size:14px;padding:0 2px;';
    closeBtn.addEventListener('click', function () { clearRouteFilter(); });
    banner.appendChild(closeBtn);
    banner.style.display = 'flex';
}

// ── Test helpers ─────────────────────────────────────────────────────────

/**
 * Reset mutable state — intended for tests between runs.
 */
function resetState(): void {
    delayCache.clear();
    bunchingCache.clear();
    lastRefreshTime = null;
    activeRouteFilter = null;
    if (ageTimer) {
        clearInterval(ageTimer);
        ageTimer = null;
    }
}

function getLastRefreshTime(): Date | null { return lastRefreshTime; }
function setLastRefreshTime(v: Date | null): void { lastRefreshTime = v; }

// ── Exports ──────────────────────────────────────────────────────────────

export {
    // Constants
    REFRESH_INTERVAL_MS,
    STALE_WARN_MS,
    STALE_ERROR_MS,
    GRACE_REFRESHES,
    STALE_OPACITY,
    BUNCHING_COLOR,
    BUNCHING_BORDER_COLOR,
    MAP_CENTER,
    MAP_ZOOM,

    // State
    delayCache,
    bunchingCache,

    // Helpers
    deviationColor,
    deviationLabel,
    delayMarkerKey,
    bunchingKey,
    formatPopup,
    formatBunchingPopup,

    // Data
    buildVehiclePositions,

    // Delay markers
    createDelayMarker,
    updateDelayMarker,
    updateDelayMarkers,
    evictStaleDelays,

    // Bunching markers
    createBunchingEvent,
    updateBunchingEvent,
    updateBunchingMarkers,
    evictStaleBunching,

    // UI
    updateAgeIndicator,
    startAgeTimer,
    updateStats,
    handleRefreshError,

    // Route filter
    applyRouteFilter,
    filterByRoute,
    clearRouteFilter,
    getActiveRouteFilter,

    // Test helper
    resetState,
    getLastRefreshTime,
    setLastRefreshTime,
};

export type { DelayMarkerEntry, BunchingMarkerEntry, LatLon };

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

// Boston city center
const MAP_CENTER = [42.3601, -71.0589];
const MAP_ZOOM = 12;

// State

// Map<vehicleId, { marker, misses }>
const delayCache = new Map();

// Map<bunchKey, { markers: [circleA, circleB, line?], misses }>
const bunchingCache = new Map();

let lastRefreshTime = null;
let ageTimer = null;

// Helpers

function deviationColor(seconds) {
    if (seconds < -120) return '#3498db';   // early
    if (seconds <= 120)  return '#2ecc71';  // on time
    if (seconds <= 300)  return '#f1c40f';  // slightly late
    if (seconds <= 600)  return '#e67e22';  // late
    return '#e74c3c';                       // very late
}

function deviationLabel(seconds) {
    const absMin = Math.abs(Math.round(seconds / 60));
    if (seconds < -120) return `${absMin} min early`;
    if (seconds <= 120)  return 'on time';
    return `${absMin} min late`;
}

function formatAge(ms) {
    if (ms < 1000) return 'just now';

    const totalSec = Math.floor(ms / 1000);
    
    if (totalSec < 60) return `${totalSec}s`;
    
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
   
    return `${min}m ${sec}s`;
}

// Cache keys

function delayMarkerKey(entry) {
    return entry.vehicle_id;
}

function bunchingKey(entry) {
    return `${entry.route_id}:${entry.vehicle_a}:${entry.vehicle_b}`;
}

// Popup formatters

function formatPopup(entry) {
    const routeName = entry.route_long_name || entry.route_id || 'Unknown route';
    const dev = deviationLabel(entry.deviation_seconds);
    return `
        <div style="font-family:sans-serif; min-width:180px">
            <strong>Route ${routeName}</strong><br>
            Vehicle: ${entry.vehicle_id}<br>
            Status: ${dev} (${Math.round(entry.deviation_seconds)}s)<br>
            <small>${entry.kind} at trip ${entry.trip_id || '\u2014'}</small>
        </div>
    `;
}

function formatBunchingPopup(entry) {
    const routeName = entry.route_long_name || entry.route_id || 'Unknown route';
    const dist = Math.round(entry.min_distance_meters);
    const durMs = new Date(entry.end_time) - new Date(entry.start_time);
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
            </table>
        </div>
    `;
}

// Data fetching

async function fetchLiveData(apiUrl) {
    const resp = await fetch(apiUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

// Vehicle position index

/**
 * Deduplicate delays by vehicle_id (keep the most recent per vehicle),
 * then build a Map<vehicleId, [lat, lon]> from those with location data.
 *
 * Returns { uniqueDelays, positions }.
 */
function buildVehiclePositions(delays) {
    // Deduplicate: when a vehicle has multiple deviation documents (one per
    // stop it visited), keep only the most recent one: that's where the
    // vehicle actually is right now.
    const latestByVehicle = new Map();
    for (const d of delays) {
        const existing = latestByVehicle.get(d.vehicle_id);
        if (!existing || new Date(d.actual_at) > new Date(existing.actual_at)) {
            latestByVehicle.set(d.vehicle_id, d);
        }
    }

    const uniqueDelays = [...latestByVehicle.values()];

    const positions = new Map();
    for (const d of uniqueDelays) {
        if (d.location && d.location.coordinates) {
            const [lon, lat] = d.location.coordinates;
            positions.set(d.vehicle_id, [lat, lon]);
        }
    }

    return { uniqueDelays, positions };
}

// Delay markers

function createDelayMarker(delay, position, color, popup, delayLayer) {
    const marker = L.circleMarker(position, {
        radius: 6,
        fillColor: color,
        color: '#333',
        weight: 1,
        fillOpacity: 0.85,
    })
    .bindPopup(popup)
    .addTo(delayLayer);

    return { marker, misses: 0 };
}

function updateDelayMarker(cacheEntry, position, color, popup) {
    const { marker } = cacheEntry;
    marker.setLatLng(position);
    marker.setStyle({ fillColor: color });
    marker.setPopupContent(popup);
    marker.setStyle({ fillOpacity: 0.85, opacity: 1 });
    cacheEntry.misses = 0;
}

/**
 * Create / update delay markers from the current delays array.
 * Returns the Set of seen vehicle IDs.
 */
function updateDelayMarkers(delays, delayLayer) {
    const seen = new Set();

    for (const d of delays) {
        if (!d.location || !d.location.coordinates) continue;

        const key = delayMarkerKey(d);
        seen.add(key);

        const [lon, lat] = d.location.coordinates;
        const position = [lat, lon];
        const color = deviationColor(d.deviation_seconds);
        const popup = formatPopup(d);

        if (delayCache.has(key)) {
            updateDelayMarker(delayCache.get(key), position, color, popup);
        } else {
            delayCache.set(key, createDelayMarker(d, position, color, popup, delayLayer));
        }
    }

    evictStaleDelays(seen, delayLayer);
    // delayLayer.refreshClusters();
    return seen;
}

function evictStaleDelays(seenIds, delayLayer) {
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

// Bunching markers

function createBunchingEvent(bunching, positionA, positionB, popup, bunchingLayer) {
    const markers = [null, null, null];

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

    return { markers, misses: 0 };
}

function updateBunchingEvent(entry, positionA, positionB, popup) {
    const [circleA, circleB, line] = entry.markers;

    if (circleA && positionA) {
        circleA.setLatLng(positionA);
        circleA.setPopupContent(popup);
        circleA.setStyle({ fillOpacity: 0.9, opacity: 1 });
    }
    if (circleB && positionB) {
        circleB.setLatLng(positionB);
        circleB.setPopupContent(popup);
        circleB.setStyle({ fillOpacity: 0.9, opacity: 1 });
    }
    if (line && positionA && positionB) {
        line.setLatLngs([positionA, positionB]);
        line.setPopupContent(popup);
        line.setStyle({ opacity: 0.7 });
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

function updateBunchingMarkers(bunchingEvents, vehiclePositions, bunchingLayer) {
    const seen = new Set();

    for (const b of bunchingEvents) {
        const key = bunchingKey(b);
        seen.add(key);

        const positionA = vehiclePositions.get(b.vehicle_a);
        const positionB = vehiclePositions.get(b.vehicle_b);
        const popup = formatBunchingPopup(b);

        if (bunchingCache.has(key)) {
            updateBunchingEvent(bunchingCache.get(key), positionA, positionB, popup);
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
 * @param {Set<string>} seenKeys - A set containing the unique keys of bunching events received in the current refresh.
 * @param {L.LayerGroup} bunchingLayer - The Leaflet layer group containing the bunching markers and polylines.
 */
function evictStaleBunching(seenKeys, bunchingLayer) {
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

// Data-age indicator

/**
 * Updates the UI data-age indicator to show how old the currently displayed map data is.
 * Acts as a visual health monitor, changing colors (fresh -> warning -> stale) 
 * as the data ages past predefined thresholds to warn users of potential connection or pipeline failures.
 */
function updateAgeIndicator() {
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

function startAgeTimer() {
    if (ageTimer) return;
    ageTimer = setInterval(updateAgeIndicator, 1000);
}

// Stats

function updateStats(uniqueDelays, bunchingCount) {
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

// Error handling

function handleRefreshError(err) {
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

// Exports

/**
 * Reset mutable state — intended for tests between runs.
 */
function resetState() {
    delayCache.clear();
    bunchingCache.clear();
    lastRefreshTime = null;
    if (ageTimer) {
        clearInterval(ageTimer);
        ageTimer = null;
    }
}

function getLastRefreshTime() { return lastRefreshTime; }
function setLastRefreshTime(v) { lastRefreshTime = v; }

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
    formatAge,
    delayMarkerKey,
    bunchingKey,
    formatPopup,
    formatBunchingPopup,

    // Data
    fetchLiveData,
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

    // Test helper
    resetState,
    getLastRefreshTime,
    setLastRefreshTime,
};

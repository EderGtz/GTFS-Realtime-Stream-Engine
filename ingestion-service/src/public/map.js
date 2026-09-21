const API_URL = '/v1/status/live';
const REFRESH_INTERVAL_MS = 30_000;

// How long before the data is considered stale (matches LIVE_WINDOW_MS / 2
// on the server side — if the server filters at 3 min, we warn at 90s and
// go red at 3 min).
const STALE_WARN_MS  = 90_000;   // 1.5 min — yellow
const STALE_ERROR_MS = 180_000;  // 3 min  — red

// Boston city center
const MAP_CENTER = [42.3601, -71.0589];
const MAP_ZOOM = 12;

// L is the global namespace for the Leaflet map library
const map = L.map('map').setView(MAP_CENTER, MAP_ZOOM);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
}).addTo(map);

// Layer groups so we can clear and redraw each refresh
const delayLayer = L.layerGroup().addTo(map);
const bunchingLayer = L.layerGroup().addTo(map);

// Track the last successful refresh timestamp for the data-age indicator
let lastRefreshTime = null;
let ageTimer = null;

// ── Color / label helpers ─────────────────────────────────────────────

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

// ── Popup formatters ──────────────────────────────────────────────────

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

// Marker cache 

// Vehicles that briefly disappear from the API response (edge of the
// server-side live window, processing lag) would flicker on/off every
// refresh if we cleared everything and redrawn from scratch.
//
// Instead, the markers are kept in cache and they are only removed after the've
// been absent for GRACE_REFRESHES consecutive polls.  While absent, the
// marker is dimmed so the user can see it's going stale.
//
// GRACE_REFRESHES=2 means a vehicle can miss up to 2 polls (60 s) before
// its marker is removed, which is enough to survive one analytics processing gap
// (the engine runs every 60 s, the map polls every 30 s).

const GRACE_REFRESHES = 2;
const STALE_OPACITY   = 0.35;

// { vehicleId: { marker, misses } }
const delayCache = {};
// { bunchKey: { markers: [circleA, circleB, line?], misses } }
const bunchingCache = {};

function delayMarkerKey(entry) {
    return entry.vehicle_id;
}

function bunchingKey(entry) {
    return `${entry.route_id}:${entry.vehicle_a}:${entry.vehicle_b}`;
}

// ── Data-age indicator ────────────────────────────────────────────────

function formatAge(ms) {
    if (ms < 1000) return 'just now';
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}m ${sec}s`;
}

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

// ── Main refresh

async function refresh() {
    try {
        const resp = await fetch(API_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        // Build a vehicle_id -> [lat, lon] index from deviations that
        // have location data.  This lets us place bunching markers at
        // the last known positions of the bunched vehicles.
        const vehiclePositions = {};
        for (const d of data.delays) {
            if (d.location && d.location.coordinates) {
                const [lon, lat] = d.location.coordinates;
                vehiclePositions[d.vehicle_id] = [lat, lon];
            }
        }

        const seenDelays = new Set();

        // Each d of the response is a vehicle experimenting an anomaly
        for (const d of data.delays) {
            if (!d.location || !d.location.coordinates) continue;
            const key = delayMarkerKey(d);
            seenDelays.add(key);

            const [lon, lat] = d.location.coordinates;
            const color = deviationColor(d.deviation_seconds);
            const popup = formatPopup(d);

            if (delayCache[key]) {
                // update existing marker's position, color, popup
                const entry = delayCache[key];
                entry.marker.setLatLng([lat, lon]);
                entry.marker.setStyle({ fillColor: color });
                entry.marker.setPopupContent(popup);
                entry.marker.setStyle({ fillOpacity: 0.85, opacity: 1 });
                entry.misses = 0;
            } else {
                // New marker
                const marker = L.circleMarker([lat, lon], {
                    radius: 6,
                    fillColor: color,
                    color: '#333',
                    weight: 1,
                    fillOpacity: 0.85,
                })
                .bindPopup(popup)
                .addTo(delayLayer);

                delayCache[key] = { marker, misses: 0 };
            }
        }

        // Mark unseen deviations; dim or evict after grace period
        for (const [key, entry] of Object.entries(delayCache)) {
            if (seenDelays.has(key)) continue;
            entry.misses++;
            if (entry.misses >= GRACE_REFRESHES) {
                delayLayer.removeLayer(entry.marker);
                delete delayCache[key];
            } else {
                // Dim the marker to show it's going stale
                entry.marker.setStyle({ fillOpacity: STALE_OPACITY, opacity: 0.4 });
            }
        }

        // Update bunching markers

        const seenBunching = new Set();
        const bunchingColor = '#9b59b6';
        const bunchingOpts = {
            radius: 8,
            fillColor: bunchingColor,
            color: '#6c3483',
            weight: 2,
            fillOpacity: 0.9,
        };

        for (const b of data.bunching) {
            const key = bunchingKey(b);
            seenBunching.add(key);

            const posA = vehiclePositions[b.vehicle_a];
            const posB = vehiclePositions[b.vehicle_b];
            const popup = formatBunchingPopup(b);

            if (bunchingCache[key]) {
                // Existing — update positions and popup, reset misses
                const entry = bunchingCache[key];
                const [circleA, circleB, line] = entry.markers;

                if (circleA && posA) {
                    circleA.setLatLng(posA);
                    circleA.setPopupContent(popup);
                    circleA.setStyle({ fillOpacity: 0.9, opacity: 1 });
                }
                if (circleB && posB) {
                    circleB.setLatLng(posB);
                    circleB.setPopupContent(popup);
                    circleB.setStyle({ fillOpacity: 0.9, opacity: 1 });
                }
                if (line && posA && posB) {
                    line.setLatLngs([posA, posB]);
                    line.setPopupContent(popup);
                    line.setStyle({ opacity: 0.7 });
                }
                entry.misses = 0;
            } else {
                // New bunching event
                const markers = [null, null, null];

                if (posA) {
                    markers[0] = L.circleMarker(posA, bunchingOpts)
                        .bindPopup(popup)
                        .addTo(bunchingLayer);
                }
                if (posB) {
                    markers[1] = L.circleMarker(posB, bunchingOpts)
                        .bindPopup(popup)
                        .addTo(bunchingLayer);
                }
                if (posA && posB) {
                    markers[2] = L.polyline([posA, posB], {
                        color: bunchingColor,
                        weight: 3,
                        opacity: 0.7,
                        dashArray: '6, 8',
                    })
                    .bindPopup(popup)
                    .addTo(bunchingLayer);
                }

                bunchingCache[key] = { markers, misses: 0 };
            }
        }

        // Mark unseen bunching events; dim or evict after grace period
        for (const [key, entry] of Object.entries(bunchingCache)) {
            if (seenBunching.has(key)) continue;
            entry.misses++;
            if (entry.misses >= GRACE_REFRESHES) {
                for (const m of entry.markers) {
                    if (m) bunchingLayer.removeLayer(m);
                }
                delete bunchingCache[key];
            } else {
                // Dim all markers in this bunching event
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

        // Update stats panel
        lastRefreshTime = new Date();
        if (ageTimer) clearInterval(ageTimer);
        ageTimer = setInterval(updateAgeIndicator, 1000);

        const statsEl = document.getElementById('stats');
        const generated = lastRefreshTime.toLocaleTimeString();
        statsEl.innerHTML = `
            <strong>MBTA Live</strong><br>
            ${data.meta.delay_count} deviations<br>
            ${data.meta.bunching_count} bunching events<br>
            <small>Updated: ${generated}</small><br>
            <small id="data-age"></small>
        `;
        updateAgeIndicator();

    } catch (err) {
        console.error('Failed to refresh:', err);
        const statsEl = document.getElementById('stats');
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
}

refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);

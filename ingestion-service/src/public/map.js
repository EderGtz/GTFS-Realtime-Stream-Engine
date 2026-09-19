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

// ── Main refresh ──────────────────────────────────────────────────────

async function refresh() {
    try {
        const resp = await fetch(API_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        delayLayer.clearLayers();
        bunchingLayer.clearLayers();

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

        // Draw deviation markers
        for (const d of data.delays) {
            if (!d.location || !d.location.coordinates) continue;
            const [lon, lat] = d.location.coordinates;
            const color = deviationColor(d.deviation_seconds);

            L.circleMarker([lat, lon], {
                radius: 8,
                fillColor: color,
                color: '#333',
                weight: 1,
                fillOpacity: 0.85,
            })
            .bindPopup(formatPopup(d))
            .addTo(delayLayer);
        }

        // Draw bunching markers — two purple markers per event connected
        // by a polyline.  Positions come from the vehicle index built
        // above; when a vehicle has no known location (e.g. its
        // deviation was outside the live window) we skip that half.
        const bunchingColor = '#9b59b6';
        const bunchingOpts = {
            radius: 10,
            fillColor: bunchingColor,
            color: '#6c3483',
            weight: 2,
            fillOpacity: 0.9,
        };

        for (const b of data.bunching) {
            const posA = vehiclePositions[b.vehicle_a];
            const posB = vehiclePositions[b.vehicle_b];

            if (posA) {
                L.circleMarker(posA, bunchingOpts)
                    .bindPopup(formatBunchingPopup(b))
                    .addTo(bunchingLayer);
            }
            if (posB) {
                L.circleMarker(posB, bunchingOpts)
                    .bindPopup(formatBunchingPopup(b))
                    .addTo(bunchingLayer);
            }
            // Connect the pair with a line when both positions are known
            if (posA && posB) {
                L.polyline([posA, posB], {
                    color: bunchingColor,
                    weight: 3,
                    opacity: 0.7,
                    dashArray: '6, 8',
                })
                .bindPopup(formatBunchingPopup(b))
                .addTo(bunchingLayer);
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
            const age = Date.now() - lastRefreshTime.getTime();
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

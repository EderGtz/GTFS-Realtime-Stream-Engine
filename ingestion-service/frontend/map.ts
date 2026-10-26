/**
 * esbuild packs this module and everything it imports into a single file
 * (src/public/dist/map.js) which map.html loads as
 * `<script type="module" src="/dist/map.js">`.
 *
 * File dynamic:
 *   - Leaflet map + tile layer + the two overlay layers
 *   - 30s refresh loop (fetch live data -> rebuild markers -> stats)
 */

// Bring the CDN global (L) into scope even when this file is type-checked
// outside frontend/tsconfig.json (editor "inferred projects", one-off tsc
// runs). Same declarations the project include provides; duplicate-safe.
/// <reference path="./globals.d.ts" />

import {
    REFRESH_INTERVAL_MS,
    MAP_CENTER,
    MAP_ZOOM,
    buildVehiclePositions,
    updateDelayMarkers,
    updateBunchingMarkers,
    updateStats,
    handleRefreshError,
    startAgeTimer,
    applyRouteFilter,
} from './map-logic.js';
import { fetchLiveData } from './lib/api.js';
import { initInfoToggle } from './panels/info-toggle.js';
import { initRouteSearch } from './panels/route-search.js';

// Map initialization

const map = L.map('map').setView(MAP_CENTER, MAP_ZOOM);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
}).addTo(map);

const delayLayer = L.layerGroup().addTo(map);
const bunchingLayer = L.layerGroup().addTo(map);

async function refresh(): Promise<void> {
    try {
        const data = await fetchLiveData();

        const { uniqueDelays, positions } =
            buildVehiclePositions(data.delays);

        updateDelayMarkers(uniqueDelays, delayLayer);

        updateBunchingMarkers(data.bunching, positions, bunchingLayer);

        applyRouteFilter();

        updateStats(uniqueDelays, data.meta.bunching_count);

    } catch (err) {
        handleRefreshError(err);
    }
}

// Wire the panels, then start the data loop
initInfoToggle();
initRouteSearch();

startAgeTimer();
void refresh();
setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);

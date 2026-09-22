import {
    REFRESH_INTERVAL_MS,
    MAP_CENTER,
    MAP_ZOOM,
    fetchLiveData,
    buildVehiclePositions,
    updateDelayMarkers,
    updateBunchingMarkers,
    updateStats,
    handleRefreshError,
    startAgeTimer,
} from './map-logic.js';

const API_URL = '/v1/status/live';

// Map initialization

const map = L.map('map').setView(MAP_CENTER, MAP_ZOOM);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
}).addTo(map);

const delayLayer = L.layerGroup().addTo(map);
const bunchingLayer = L.layerGroup().addTo(map);

async function refresh() {
    try {
        const data = await fetchLiveData(API_URL);

        const { uniqueDelays, positions } =
            buildVehiclePositions(data.delays);

        updateDelayMarkers(uniqueDelays, delayLayer);

        updateBunchingMarkers(data.bunching, positions, bunchingLayer);

        updateStats(uniqueDelays, data.meta.bunching_count);

    } catch (err) {
        handleRefreshError(err);
    }
}

startAgeTimer();
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);

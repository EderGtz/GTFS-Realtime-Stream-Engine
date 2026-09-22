// @vitest-environment jsdom
/**
 * Unit tests for map-logic.js — the pure logic layer behind the
 * MBTA live transit map.
 *
 * Leaflet (L) is mocked since we run in jsdom, not a browser.
 * Every function that touches Leaflet receives its layer objects as
 * parameters, so the mocks only need to track method calls.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

// ── Leaflet mock ──────────────────────────────────────────────────────

function createLayerMock() {
    return {
        addLayer: vi.fn(),
        removeLayer: vi.fn(),
        addTo: vi.fn().mockReturnThis(),
        refreshClusters: vi.fn(),
    };
}

function createMarkerMock() {
    const m = {
        setLatLng: vi.fn().mockReturnThis(),
        setStyle: vi.fn().mockReturnThis(),
        setPopupContent: vi.fn().mockReturnThis(),
        bindPopup: vi.fn().mockReturnThis(),
        addTo: vi.fn().mockReturnThis(),
    };
    return m;
}

let lastPolylineMock = null;

beforeEach(() => {
    // Minimal Leaflet global — just enough for the functions under test
    globalThis.L = {
        circleMarker: vi.fn(() => createMarkerMock()),
        polyline: vi.fn(() => {
            const m = createMarkerMock();
            m.setLatLng = vi.fn().mockReturnThis();
            // Give it a prototype chain so instanceof L.Polyline works
            Object.setPrototypeOf(m, L.Polyline.prototype);
            lastPolylineMock = m;
            return m;
        }),
        Polyline: class Polyline {},
        Polygon: class Polygon {},
    };
});

// ── Import after global mock is set up ────────────────────────────────

const mod = await import('../../src/public/map-logic.js');

const {
    deviationColor,
    deviationLabel,
    formatAge,
    formatPopup,
    formatBunchingPopup,
    delayMarkerKey,
    bunchingKey,
    buildVehiclePositions,
    createDelayMarker,
    updateDelayMarker,
    updateDelayMarkers,
    evictStaleDelays,
    createBunchingEvent,
    updateBunchingEvent,
    updateBunchingMarkers,
    evictStaleBunching,
    updateStats,
    handleRefreshError,
    updateAgeIndicator,
    fetchLiveData,
    resetState,
    getLastRefreshTime,
    setLastRefreshTime,
    delayCache,
    bunchingCache,
    GRACE_REFRESHES,
    STALE_OPACITY,
    BUNCHING_COLOR,
    BUNCHING_BORDER_COLOR,
    STALE_WARN_MS,
    STALE_ERROR_MS,
} = mod;

// ── Fixtures ──────────────────────────────────────────────────────────

function makeDelay(overrides = {}) {
    return {
        vehicle_id: 'bus-101',
        trip_id: 'trip-1',
        kind: 'arrival',
        deviation_seconds: 60,
        actual_at: new Date().toISOString(),
        location: { type: 'Point', coordinates: [-71.0589, 42.3601] },
        route_id: 'Red',
        route_long_name: 'Red Line',
        ...overrides,
    };
}

function makeBunching(overrides = {}) {
    return {
        route_id: 'Red',
        route_long_name: 'Red Line',
        vehicle_a: 'bus-101',
        vehicle_b: 'bus-202',
        min_distance_meters: 12.5,
        start_time: new Date(Date.now() - 180_000).toISOString(),
        end_time: new Date(Date.now() - 20_000).toISOString(),
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════
// Deviation helpers
// ═══════════════════════════════════════════════════════════════════════

describe('deviationColor', () => {
    test('returns early color for < -120s', () => {
        expect(deviationColor(-300)).toBe('#3498db');
    });

    test('returns on-time color for -120 to 120s', () => {
        expect(deviationColor(-120)).toBe('#2ecc71');
        expect(deviationColor(0)).toBe('#2ecc71');
        expect(deviationColor(120)).toBe('#2ecc71');
    });

    test('returns slightly late color for 121-300s', () => {
        expect(deviationColor(121)).toBe('#f1c40f');
        expect(deviationColor(300)).toBe('#f1c40f');
    });

    test('returns late color for 301-600s', () => {
        expect(deviationColor(301)).toBe('#e67e22');
        expect(deviationColor(600)).toBe('#e67e22');
    });

    test('returns very late color for > 600s', () => {
        expect(deviationColor(601)).toBe('#e74c3c');
        expect(deviationColor(1200)).toBe('#e74c3c');
    });
});

describe('deviationLabel', () => {
    test('on time for ±2 min', () => {
        expect(deviationLabel(0)).toBe('on time');
        expect(deviationLabel(60)).toBe('on time');
        expect(deviationLabel(-120)).toBe('on time');
    });

    test('early for < -2 min', () => {
        expect(deviationLabel(-180)).toBe('3 min early');
    });

    test('late for > 2 min', () => {
        expect(deviationLabel(300)).toBe('5 min late');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// formatAge
// ═══════════════════════════════════════════════════════════════════════

describe('formatAge', () => {
    test('< 1 second → "just now"', () => {
        expect(formatAge(500)).toBe('just now');
    });

    test('seconds only', () => {
        expect(formatAge(5000)).toBe('5s');
    });

    test('minutes and seconds', () => {
        expect(formatAge(90_000)).toBe('1m 30s');
    });

    test('exact minute', () => {
        expect(formatAge(120_000)).toBe('2m 0s');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Cache keys
// ═══════════════════════════════════════════════════════════════════════

describe('delayMarkerKey', () => {
    test('returns vehicle_id', () => {
        expect(delayMarkerKey(makeDelay())).toBe('bus-101');
    });
});

describe('bunchingKey', () => {
    test('returns route:vehicleA:vehicleB', () => {
        expect(bunchingKey(makeBunching())).toBe('Red:bus-101:bus-202');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Popup formatters
// ═══════════════════════════════════════════════════════════════════════

describe('formatPopup', () => {
    test('includes route, vehicle, status, and kind', () => {
        const html = formatPopup(makeDelay());
        expect(html).toContain('Red Line');
        expect(html).toContain('bus-101');
        expect(html).toContain('on time');
        expect(html).toContain('arrival');
        expect(html).toContain('trip-1');
    });

    test('falls back to route_id when route_long_name missing', () => {
        const html = formatPopup(makeDelay({ route_long_name: undefined }));
        expect(html).toContain('Red');
    });
});

describe('formatBunchingPopup', () => {
    test('includes route, vehicles, distance, duration', () => {
        const html = formatBunchingPopup(makeBunching());
        expect(html).toContain('Red Line');
        expect(html).toContain('bus-101');
        expect(html).toContain('bus-202');
        expect(html).toContain('13 m');  // Math.round(12.5) = 13
        expect(html).toContain('Bunching event');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// buildVehiclePositions
// ═══════════════════════════════════════════════════════════════════════

describe('buildVehiclePositions', () => {
    test('returns Map of vehicle_id → [lat, lon]', () => {
        const { positions } = buildVehiclePositions([
            makeDelay(),
            makeDelay({
                vehicle_id: 'bus-202',
                location: { type: 'Point', coordinates: [-71.065, 42.352] },
            }),
        ]);

        expect(positions).toBeInstanceOf(Map);
        expect(positions.get('bus-101')).toEqual([42.3601, -71.0589]);
        expect(positions.get('bus-202')).toEqual([42.352, -71.065]);
    });

    test('deduplicates by vehicle_id keeping the most recent', () => {
        const older = makeDelay({ actual_at: new Date(Date.now() - 60_000).toISOString() });
        const newer = makeDelay({ actual_at: new Date().toISOString() });

        const { uniqueDelays } = buildVehiclePositions([older, newer]);
        expect(uniqueDelays).toHaveLength(1);
        expect(uniqueDelays[0]).toBe(newer);
    });

    test('skips entries without location', () => {
        const { positions } = buildVehiclePositions([
            makeDelay({ location: null }),
        ]);
        expect(positions.size).toBe(0);
    });

    test('swaps GeoJSON [lon, lat] to Leaflet [lat, lon]', () => {
        const { positions } = buildVehiclePositions([
            makeDelay({
                location: { type: 'Point', coordinates: [-80.0, 40.0] },
            }),
        ]);
        expect(positions.get('bus-101')).toEqual([40.0, -80.0]);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Delay marker CRUD
// ═══════════════════════════════════════════════════════════════════════

describe('createDelayMarker', () => {
    test('creates a circle marker with correct style and adds to layer', () => {
        const layer = createLayerMock();
        const result = createDelayMarker(
            makeDelay(), [42.36, -71.05], '#2ecc71', '<b>popup</b>', layer
        );

        expect(L.circleMarker).toHaveBeenCalledWith([42.36, -71.05], {
            radius: 6,
            fillColor: '#2ecc71',
            color: '#333',
            weight: 1,
            fillOpacity: 0.85,
        });
        expect(result.marker.bindPopup).toHaveBeenCalledWith('<b>popup</b>');
        expect(result.marker.addTo).toHaveBeenCalledWith(layer);
        expect(result.misses).toBe(0);
    });
});

describe('updateDelayMarker', () => {
    test('updates position, color, popup, and resets misses', () => {
        const marker = createMarkerMock();
        const entry = { marker, misses: 3 };

        updateDelayMarker(entry, [42.36, -71.05], '#e74c3c', '<b>new</b>');

        expect(marker.setLatLng).toHaveBeenCalledWith([42.36, -71.05]);
        expect(marker.setPopupContent).toHaveBeenCalledWith('<b>new</b>');
        expect(entry.misses).toBe(0);
    });
});

describe('evictStaleDelays', () => {
    beforeEach(() => resetState());

    test('dims unseen markers on first miss', () => {
        const marker = createMarkerMock();
        delayCache.set('bus-101', { marker, misses: 0 });

        evictStaleDelays(new Set(), createLayerMock());

        expect(marker.setStyle).toHaveBeenCalledWith({
            fillOpacity: STALE_OPACITY,
            opacity: 0.4,
        });
        expect(delayCache.has('bus-101')).toBe(true);
    });

    test('removes markers after GRACE_REFRESHES misses', () => {
        const layer = createLayerMock();
        const marker = createMarkerMock();
        delayCache.set('bus-101', { marker, misses: GRACE_REFRESHES - 1 });

        evictStaleDelays(new Set(), layer);

        expect(layer.removeLayer).toHaveBeenCalledWith(marker);
        expect(delayCache.has('bus-101')).toBe(false);
    });

    test('seen markers are not affected', () => {
        const marker = createMarkerMock();
        delayCache.set('bus-101', { marker, misses: 0 });

        evictStaleDelays(new Set(['bus-101']), createLayerMock());

        expect(marker.setStyle).not.toHaveBeenCalled();
    });
});

describe('updateDelayMarkers', () => {
    beforeEach(() => resetState());

    test('creates new markers and returns seen set', () => {
        const layer = createLayerMock();
        const seen = updateDelayMarkers(
            [makeDelay(), makeDelay({ vehicle_id: 'bus-202' })],
            layer
        );

        expect(seen).toEqual(new Set(['bus-101', 'bus-202']));
        expect(delayCache.size).toBe(2);
    });

    test('updates existing markers on subsequent calls', () => {
        const layer = createLayerMock();
        updateDelayMarkers([makeDelay()], layer);

        const cached = delayCache.get('bus-101');
        const originalMarker = cached.marker;

        // Second call with different deviation → should update, not create
        updateDelayMarkers(
            [makeDelay({ deviation_seconds: 600 })],
            layer
        );

        expect(delayCache.size).toBe(1);
        expect(delayCache.get('bus-101').marker).toBe(originalMarker);
        expect(originalMarker.setLatLng).toHaveBeenCalled();
    });

    test('evicts markers that disappear', () => {
        const layer = createLayerMock();
        updateDelayMarkers([makeDelay()], layer);
        expect(delayCache.size).toBe(1);

        // Empty response — bus-101 disappears
        updateDelayMarkers([], layer);
        expect(delayCache.size).toBe(1); // still in grace period

        updateDelayMarkers([], layer);
        expect(delayCache.size).toBe(0); // evicted
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Bunching marker CRUD
// ═══════════════════════════════════════════════════════════════════════

describe('createBunchingEvent', () => {
    test('creates circle A, circle B, and line when both positions exist', () => {
        const layer = createLayerMock();
        const posA = [42.36, -71.05];
        const posB = [42.35, -71.06];

        const result = createBunchingEvent(
            makeBunching(), posA, posB, '<b>popup</b>', layer
        );

        expect(result.markers).toHaveLength(3);
        // Two circleMarkers for A and B
        expect(L.circleMarker).toHaveBeenCalledTimes(2);
        // One polyline connecting A and B
        expect(L.polyline).toHaveBeenCalledWith(
            [posA, posB],
            expect.objectContaining({
                color: BUNCHING_COLOR,
                dashArray: '6, 8',
            })
        );
        expect(result.misses).toBe(0);
    });

    test('skips line when only one position available', () => {
        const layer = createLayerMock();
        createBunchingEvent(
            makeBunching(), [42.36, -71.05], undefined, '<b>p</b>', layer
        );

        // Only one circleMarker created
        expect(L.circleMarker).toHaveBeenCalledTimes(1);
        expect(L.polyline).not.toHaveBeenCalled();
    });

    test('creates nothing when both positions undefined', () => {
        const layer = createLayerMock();
        const result = createBunchingEvent(
            makeBunching(), undefined, undefined, '<b>p</b>', layer
        );

        expect(result.markers).toEqual([null, null, null]);
        expect(L.circleMarker).not.toHaveBeenCalled();
        expect(L.polyline).not.toHaveBeenCalled();
    });
});

describe('updateBunchingEvent', () => {
    test('updates existing markers and resets misses', () => {
        const circleA = createMarkerMock();
        const circleB = createMarkerMock();
        const line = createMarkerMock();
        line.setLatLngs = vi.fn().mockReturnThis();

        const entry = { markers: [circleA, circleB, line], misses: 2 };
        const posA = [42.36, -71.05];
        const posB = [42.35, -71.06];

        updateBunchingEvent(entry, posA, posB, '<b>new</b>');

        expect(circleA.setLatLng).toHaveBeenCalledWith(posA);
        expect(circleB.setLatLng).toHaveBeenCalledWith(posB);
        expect(line.setLatLngs).toHaveBeenCalledWith([posA, posB]);
        expect(entry.misses).toBe(0);
    });

    test('skips null markers gracefully', () => {
        const entry = { markers: [null, null, null], misses: 0 };
        // Should not throw
        updateBunchingEvent(entry, [42.36, -71.05], undefined, '<b>p</b>');
        expect(entry.misses).toBe(0);
    });
});

describe('evictStaleBunching', () => {
    beforeEach(() => resetState());

    test('dims unseen events on first miss', () => {
        const circleA = createMarkerMock();
        const entry = { markers: [circleA, null, null], misses: 0 };
        bunchingCache.set('Red:A:B', entry);

        evictStaleBunching(new Set(), createLayerMock());

        expect(circleA.setStyle).toHaveBeenCalledWith({
            fillOpacity: STALE_OPACITY,
            opacity: 0.4,
        });
    });

    test('dims polyline differently (opacity only, no fill)', () => {
        // Create a polyline mock with the right prototype chain
        const line = createMarkerMock();
        Object.setPrototypeOf(line, L.Polyline.prototype);
        const entry = { markers: [null, null, line], misses: 0 };
        bunchingCache.set('Red:A:B', entry);

        evictStaleBunching(new Set(), createLayerMock());

        expect(line.setStyle).toHaveBeenCalledWith({ opacity: 0.25 });
    });

    test('removes events after GRACE_REFRESHES misses', () => {
        const layer = createLayerMock();
        const circleA = createMarkerMock();
        const circleB = createMarkerMock();
        const entry = {
            markers: [circleA, circleB, null],
            misses: GRACE_REFRESHES - 1,
        };
        bunchingCache.set('Red:A:B', entry);

        evictStaleBunching(new Set(), layer);

        expect(layer.removeLayer).toHaveBeenCalledTimes(2);
        expect(bunchingCache.has('Red:A:B')).toBe(false);
    });
});

describe('updateBunchingMarkers', () => {
    beforeEach(() => resetState());

    test('creates new bunching events and returns seen set', () => {
        const bunchingLayer = createLayerMock();
        const positions = new Map([
            ['bus-101', [42.36, -71.05]],
            ['bus-202', [42.35, -71.06]],
        ]);

        const seen = updateBunchingMarkers(
            [makeBunching()],
            positions,
            bunchingLayer
        );

        expect(seen).toEqual(new Set(['Red:bus-101:bus-202']));
        expect(bunchingCache.size).toBe(1);
    });

    test('evicts bunching events that disappear', () => {
        const bunchingLayer = createLayerMock();
        const positions = new Map([
            ['bus-101', [42.36, -71.05]],
            ['bus-202', [42.35, -71.06]],
        ]);

        updateBunchingMarkers([makeBunching()], positions, bunchingLayer);
        expect(bunchingCache.size).toBe(1);

        // Empty response
        updateBunchingMarkers([], positions, bunchingLayer);
        expect(bunchingCache.size).toBe(1); // grace period

        updateBunchingMarkers([], positions, bunchingLayer);
        expect(bunchingCache.size).toBe(0); // evicted
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Stats & age indicator
// ═══════════════════════════════════════════════════════════════════════

describe('updateStats', () => {
    beforeEach(() => resetState());

    test('renders stats to DOM and sets lastRefreshTime', () => {
        document.body.innerHTML = '<div id="stats"></div>';

        updateStats([makeDelay(), makeDelay({ vehicle_id: 'bus-202' })], 3);

        const html = document.getElementById('stats').innerHTML;
        expect(html).toContain('MBTA Live');
        expect(html).toContain('2 vehicles with deviations');
        expect(html).toContain('3 bunching events');
        expect(getLastRefreshTime()).toBeInstanceOf(Date);
    });

    test('sets data-age span class to fresh', () => {
        document.body.innerHTML = '<div id="stats"></div>';
        updateStats([makeDelay()], 0);

        const ageEl = document.getElementById('data-age');
        expect(ageEl).not.toBeNull();
        expect(ageEl.innerHTML).toContain('class="fresh"');
    });
});

describe('updateAgeIndicator', () => {
    beforeEach(() => resetState());

    test('renders fresh indicator when data is recent', () => {
        document.body.innerHTML = '<div id="data-age"></div>';
        setLastRefreshTime(new Date());

        updateAgeIndicator();
        expect(document.getElementById('data-age').innerHTML)
            .toContain('class="fresh"');
    });

    test('renders warning when data is moderately stale', () => {
        document.body.innerHTML = '<div id="data-age"></div>';
        setLastRefreshTime(new Date(Date.now() - STALE_WARN_MS - 1000));

        updateAgeIndicator();
        expect(document.getElementById('data-age').innerHTML)
            .toContain('color:#e67e22');
    });

    test('renders stale when data is very old', () => {
        document.body.innerHTML = '<div id="data-age"></div>';
        setLastRefreshTime(new Date(Date.now() - STALE_ERROR_MS - 1000));

        updateAgeIndicator();
        expect(document.getElementById('data-age').innerHTML)
            .toContain('class="stale"');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// handleRefreshError
// ═══════════════════════════════════════════════════════════════════════

describe('handleRefreshError', () => {
    beforeEach(() => {
        resetState();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    test('shows connection error', () => {
        document.body.innerHTML = '<div id="stats"></div>';

        handleRefreshError(new Error('fail'));

        expect(document.getElementById('stats').innerHTML)
            .toContain('Connection error');
    });

    test('includes data-age span when lastRefreshTime exists', () => {
        document.body.innerHTML = '<div id="stats"></div>';
        setLastRefreshTime(new Date());

        handleRefreshError(new Error('fail'));

        expect(document.getElementById('stats').innerHTML)
            .toContain('data-age');
    });

    test('no data-age span when lastRefreshTime is null', () => {
        document.body.innerHTML = '<div id="stats"></div>';

        handleRefreshError(new Error('fail'));

        expect(document.getElementById('stats').innerHTML)
            .not.toContain('data-age');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// fetchLiveData
// ═══════════════════════════════════════════════════════════════════════

describe('fetchLiveData', () => {
    test('returns parsed JSON on success', async () => {
        const body = { delays: [], bunching: [], meta: {} };
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(body),
        });

        const result = await fetchLiveData('/v1/status/live');
        expect(result).toEqual(body);
    });

    test('throws on non-OK response', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
        });

        await expect(fetchLiveData('/v1/status/live'))
            .rejects.toThrow('HTTP 503');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// resetState
// ═══════════════════════════════════════════════════════════════════════

describe('resetState', () => {
    test('clears caches and resets time', () => {
        delayCache.set('x', { marker: {}, misses: 0 });
        bunchingCache.set('y', { markers: [], misses: 0 });
        setLastRefreshTime(new Date());

        resetState();

        expect(delayCache.size).toBe(0);
        expect(bunchingCache.size).toBe(0);
        expect(getLastRefreshTime()).toBeNull();
    });
});

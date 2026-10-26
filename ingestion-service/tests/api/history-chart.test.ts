// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for charts/history-chart.ts — drawChart(canvasId, points, days) and
 * the aggregateBuckets(points, bucketHours) helper.
 *
 * Uses jsdom to verify the chart module's public API and lifecycle,
 * without requiring Chart.js to render actual pixels (which needs canvas).
 *
 * Bucket math assertions double as the "weighted math spot-check" from the
 * redesign checklist: bucket values are compared against a manual
 * sum(pct * count) / sum(count) computed from the raw API points.
 */

// Mock Chart.js globally — we're testing the module's integration, not Chart itself.
const mockDestroy = vi.fn();
const mockChartConstructor = vi.fn(function (this: any) {
    this.destroy = mockDestroy;
});

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('Chart', mockChartConstructor);
    mockDestroy.mockClear();
    mockChartConstructor.mockClear();
    // Set up a canvas element in the DOM with a mocked getContext
    document.body.innerHTML = '<canvas id="test-canvas"></canvas>';
    const canvas = document.getElementById('test-canvas') as HTMLCanvasElement;
    canvas.getContext = vi.fn().mockReturnValue({});
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

async function loadChart() {
    const mod = await import('../../frontend/charts/history-chart.ts');
    return mod.drawChart;
}

async function loadAggregator() {
    const mod = await import('../../frontend/charts/history-chart.ts');
    return mod.aggregateBuckets;
}

const samplePoints = [
    { hour: '2026-10-05T10:00:00Z', on_time_pct: 75, avg_deviation: 100,
      p95_deviation: 250, vehicle_count: 20, bunching_events: 1 },
    { hour: '2026-10-05T11:00:00Z', on_time_pct: 80, avg_deviation: 90,
      p95_deviation: 200, vehicle_count: 22, bunching_events: 0 },
];

/** ISO string for a local-time hour (TZ-safe: round-trips through new Date). */
function hourIso(y: number, mo: number, d: number, h: number): string {
    return new Date(y, mo, d, h, 0, 0).toISOString();
}

/** One hourly API point at a local-time hour, with sensible defaults. */
function point(y: number, mo: number, d: number, h: number, overrides: Record<string, unknown> = {}) {
    return {
        hour: hourIso(y, mo, d, h),
        on_time_pct: 80,
        avg_deviation: 60,
        p95_deviation: 240,
        vehicle_count: 10,
        bunching_events: 0,
        ...overrides,
    };
}

/**
 * n consecutive local days of hourly points starting at local midnight of
 * June 1 2026 (month index 5). Hours 0-4 are "no service" (the overnight
 * block that used to render as false 0% dips).
 */
function makeDays(n: number) {
    const pts: ReturnType<typeof point>[] = [];
    for (let day = 0; day < n; day++) {
        for (let h = 0; h < 24; h++) {
            pts.push(point(2026, 5, 1 + day, h, h < 5
                ? { on_time_pct: 0, vehicle_count: 0 }
                : { on_time_pct: 60 + (h % 4) * 10, vehicle_count: 5 + h }));
        }
    }
    return pts;
}

describe('drawChart', () => {
    test('is exported from the chart module', async () => {
        const drawChart = await loadChart();
        expect(typeof drawChart).toBe('function');
    });

    test('creates a Chart instance on the given canvas', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', samplePoints);
        expect(mockChartConstructor).toHaveBeenCalledTimes(1);
    });

    test('destroys previous chart before drawing a new one', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', samplePoints);
        drawChart('test-canvas', samplePoints);
        expect(mockChartConstructor).toHaveBeenCalledTimes(2);
        expect(mockDestroy).toHaveBeenCalledTimes(1); // called between the two
    });

    test('does nothing when canvas is not found', async () => {
        const drawChart = await loadChart();
        drawChart('nonexistent-canvas', samplePoints);
        expect(mockChartConstructor).not.toHaveBeenCalled();
    });

    test('does nothing when points is empty', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', []);
        expect(mockChartConstructor).not.toHaveBeenCalled();
    });

    test('does nothing when points is null/undefined', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', null);
        drawChart('test-canvas', undefined);
        expect(mockChartConstructor).not.toHaveBeenCalled();
    });

    test('passes correct data shape to Chart', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', samplePoints);
        const chartConfig = mockChartConstructor.mock.calls[0][1];
        expect(chartConfig.data.datasets[0].data).toEqual([75, 80]);
        expect(chartConfig.data.labels).toHaveLength(2);
    });
});

describe('drawChart — 1 day (hourly view, regression)', () => {
    test('keeps the single filled line with per-hour points', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', samplePoints, 1);
        const config = mockChartConstructor.mock.calls[0][1];
        expect(config.data.datasets).toHaveLength(1);
        expect(config.data.datasets[0].type).toBeUndefined();
        expect(config.data.datasets[0].data).toEqual([75, 80]);
        expect(config.data.datasets[0].pointRadius).toBe(2);
        expect(config.data.datasets[0].fill).toBe(true);
    });

    test('renders no-service hours (vehicle_count = 0) as gaps, not 0%', async () => {
        const drawChart = await loadChart();
        const pts = [
            point(2026, 5, 2, 10, { on_time_pct: 75, vehicle_count: 20 }),
            point(2026, 5, 2, 11, { on_time_pct: 0, vehicle_count: 0 }),
            point(2026, 5, 2, 12, { on_time_pct: 90, vehicle_count: 20 }),
        ];
        drawChart('test-canvas', pts, 1);
        const config = mockChartConstructor.mock.calls[0][1];
        expect(config.data.datasets[0].data).toEqual([75, null, 90]);
        expect(config.data.datasets[0].spanGaps).toBe(false);
    });

    test('keeps a genuine 0% (vehicles in service, all late)', async () => {
        const drawChart = await loadChart();
        const pts = [
            point(2026, 5, 2, 10, { on_time_pct: 0, vehicle_count: 20 }),
            point(2026, 5, 2, 11, { on_time_pct: 0, vehicle_count: 0 }),
        ];
        drawChart('test-canvas', pts, 1);
        const config = mockChartConstructor.mock.calls[0][1];
        expect(config.data.datasets[0].data).toEqual([0, null]);
    });

    test('keeps the per-hour tooltip as-is', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', samplePoints, 1);
        const config = mockChartConstructor.mock.calls[0][1];
        const lines = config.options.plugins.tooltip.callbacks.label({ dataIndex: 0 });
        expect(lines).toEqual([
            'On-time: 75%',
            'Avg dev: 1m 40s',
            'P95: 4m 10s',
            'Vehicles: 20',
            'Bunching: 1',
        ]);
    });
});

describe('aggregateBuckets — weighted math', () => {
    test('bucket on-time is sum(pct*count)/sum(count), not a plain mean', async () => {
        const aggregate = await loadAggregator();
        const pts = [
            point(2026, 5, 2, 1, { on_time_pct: 100, vehicle_count: 3 }),
            point(2026, 5, 2, 2, { on_time_pct: 70, vehicle_count: 40 }),
        ];
        const buckets = aggregate(pts, 6);
        expect(buckets).toHaveLength(4); // full day grid: 00/06/12/18
        const manual = (100 * 3 + 70 * 40) / (3 + 40);
        expect(buckets[0].weighted_on_time).toBeCloseTo(manual, 10);
        // A plain mean would give 85 — the quiet hour must not cancel the busy one.
        expect(buckets[0].weighted_on_time).not.toBeCloseTo(85, 1);
        expect(buckets[0].vehicle_total).toBe(43);
    });

    test('avg_deviation uses the same vehicle weighting', async () => {
        const aggregate = await loadAggregator();
        const pts = [
            point(2026, 5, 2, 1, { avg_deviation: 10, vehicle_count: 3 }),
            point(2026, 5, 2, 2, { avg_deviation: 100, vehicle_count: 40 }),
        ];
        const buckets = aggregate(pts, 6);
        expect(buckets[0].weighted_avg_dev).toBeCloseTo((10 * 3 + 100 * 40) / 43, 10);
    });

    test('p95_deviation is the worst hourly value (percentiles are not additive)', async () => {
        const aggregate = await loadAggregator();
        const pts = [
            point(2026, 5, 2, 1, { p95_deviation: 100 }),
            point(2026, 5, 2, 2, { p95_deviation: 300 }),
            point(2026, 5, 2, 3, { p95_deviation: 200 }),
            // no-service hour with a big stored p95 must not count
            point(2026, 5, 2, 4, { p95_deviation: 999, vehicle_count: 0 }),
        ];
        const buckets = aggregate(pts, 6);
        expect(buckets[0].p95_max).toBe(300);
    });
});

describe('aggregateBuckets — no-service handling', () => {
    test('zero-count hours are excluded from the math, counted as no_service', async () => {
        const aggregate = await loadAggregator();
        const pts = [
            point(2026, 5, 2, 1, { on_time_pct: 0, vehicle_count: 0 }),
            point(2026, 5, 2, 2, { on_time_pct: 50, vehicle_count: 10 }),
            point(2026, 5, 2, 3, { on_time_pct: 100, vehicle_count: 10 }),
        ];
        const buckets = aggregate(pts, 6);
        expect(buckets[0].weighted_on_time).toBeCloseTo(75, 10);
        expect(buckets[0].min_on_time).toBe(50); // not 0 from the no-service hour
        expect(buckets[0].max_on_time).toBe(100);
        expect(buckets[0].hours).toBe(2);
        expect(buckets[0].no_service).toBe(1);
        expect(buckets[0].vehicle_total).toBe(20);
    });

    test('an all-no-service bucket becomes a gap (null values)', async () => {
        const aggregate = await loadAggregator();
        const pts = [
            point(2026, 5, 2, 1, { on_time_pct: 0, vehicle_count: 0 }),
            point(2026, 5, 2, 2, { on_time_pct: 0, vehicle_count: 0 }),
        ];
        const buckets = aggregate(pts, 6);
        expect(buckets).toHaveLength(4); // 00/06/12/18, one day
        expect(buckets[0].weighted_on_time).toBeNull();
        expect(buckets[0].weighted_avg_dev).toBeNull();
        expect(buckets[0].min_on_time).toBeNull();
        expect(buckets[0].max_on_time).toBeNull();
        expect(buckets[0].hours).toBe(0);
        expect(buckets[0].no_service).toBe(2);
        // Empty grid buckets are gaps too, with no points at all.
        expect(buckets[1].weighted_on_time).toBeNull();
        expect(buckets[1].hours).toBe(0);
        expect(buckets[1].no_service).toBe(0);
    });

    test('a genuine 0% with vehicles in service stays in the ribbon bounds', async () => {
        const aggregate = await loadAggregator();
        const pts = [
            point(2026, 5, 2, 1, { on_time_pct: 0, vehicle_count: 5 }),
            point(2026, 5, 2, 2, { on_time_pct: 100, vehicle_count: 5 }),
        ];
        const buckets = aggregate(pts, 6);
        expect(buckets[0].min_on_time).toBe(0);
        expect(buckets[0].weighted_on_time).toBeCloseTo(50, 10);
        expect(buckets[0].no_service).toBe(0);
    });
});

describe('aggregateBuckets — bucket alignment', () => {
    test('12h buckets split at local noon and label only day boundaries', async () => {
        const aggregate = await loadAggregator();
        const pts = [
            point(2026, 5, 2, 0),   // day 2, AM block
            point(2026, 5, 2, 11),  // day 2, AM block
            point(2026, 5, 2, 12),  // day 2, PM block
            point(2026, 5, 2, 23),  // day 2, PM block
            point(2026, 5, 3, 0),   // day 3, AM block
        ];
        const buckets = aggregate(pts, 12);
        // Full grid spans day 2 and day 3, including the empty final PM block.
        expect(buckets).toHaveLength(4);
        expect(buckets.map((b: any) => b.hours)).toEqual([2, 2, 1, 0]);
        // Only midnight buckets carry the day-boundary tick label ("Mon 6").
        expect(buckets[0].label).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
        expect(buckets[1].label).toBe('');
        expect(buckets[2].label).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
        expect(buckets[3].label).toBe('');
        expect(buckets[3].weighted_on_time).toBeNull();
    });

    test('6h buckets split at 00/06/12/18', async () => {
        const aggregate = await loadAggregator();
        const pts = [
            point(2026, 5, 2, 5),
            point(2026, 5, 2, 6),
            point(2026, 5, 2, 12),
            point(2026, 5, 2, 18),
        ];
        const buckets = aggregate(pts, 6);
        expect(buckets).toHaveLength(4);
        expect(buckets.map((b: any) => b.hours)).toEqual([1, 1, 1, 1]);
    });

    test('single-hour buckets collapse min and max to the same value', async () => {
        const aggregate = await loadAggregator();
        const pts = [
            point(2026, 5, 2, 1, { on_time_pct: 42 }),
            point(2026, 5, 2, 2, { on_time_pct: 17 }),
        ];
        const buckets = aggregate(pts, 1);
        expect(buckets).toHaveLength(2);
        expect(buckets[0].min_on_time).toBe(42);
        expect(buckets[0].max_on_time).toBe(42);
        expect(buckets[0].weighted_on_time).toBe(42);
    });

    test('sparse routes still get a full grid, so day labels survive missing overnight hours', async () => {
        const aggregate = await loadAggregator();
        // Production pattern: the analytics engine writes no rows at all
        // between 22:00 and 07:00 (hours with no service are skipped).
        const pts: ReturnType<typeof point>[] = [];
        for (let day = 0; day < 3; day++) {
            for (let h = 7; h < 22; h++) pts.push(point(2026, 5, 1 + day, h));
        }
        const buckets = aggregate(pts, 6);
        expect(buckets).toHaveLength(12); // 3 days × 4 buckets, incl. empty 00-06
        expect(buckets[0].hours).toBe(0);
        expect(buckets[0].weighted_on_time).toBeNull();
        // Day labels live on the midnight bucket, even when it has no data.
        expect(buckets[0].label).toMatch(/^[A-Za-z]{3} \d{1,2}$/); // Mon 1
        expect(buckets[4].label).toMatch(/^[A-Za-z]{3} \d{1,2}$/); // Tue 2
        expect(buckets[8].label).toMatch(/^[A-Za-z]{3} \d{1,2}$/); // Wed 3
        expect(buckets[1].hours).toBe(5); // 07:00-11:59
    });

    test('72h buckets group whole days instead of one-per-day', async () => {
        const aggregate = await loadAggregator();
        const pts: ReturnType<typeof point>[] = [];
        for (let day = 0; day < 90; day++) {
            for (let h = 0; h < 24; h++) pts.push(point(2026, 0, 1 + day, h));
        }
        const buckets = aggregate(pts, 72);
        // 90 days / 3 = ~30 buckets (90 was the old within-day indexing bug).
        expect(buckets.length).toBeGreaterThanOrEqual(30);
        expect(buckets.length).toBeLessThanOrEqual(31);
        expect(buckets.some((b: any) => b.hours === 72)).toBe(true);
        expect(buckets[0].title).toContain('\u2013'); // multi-day range in tooltip
        expect(buckets[0].label).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
    });

    test('bucket count per range keeps the chart at ~24-40 points', async () => {
        const aggregate = await loadAggregator();
        // ranges: [days, bucketHours, expected points]
        const ranges: [number, number, number][] = [
            [3, 3, 24],   // 3d / 3h
            [7, 6, 28],   // 7d / 6h
            [14, 12, 28], // 14d / 12h
        ];
        for (const [days, bucketHours, expected] of ranges) {
            const buckets = aggregate(makeDays(days), bucketHours);
            expect(buckets.length).toBe(expected);
            expect(buckets.length).toBeLessThanOrEqual(40);
        }
    });
});

describe('drawChart — bucketed view (3/7/14 days)', () => {
    test('draws a min-max ribbon bar plus the weighted trend line', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', makeDays(3), 3);
        const config = mockChartConstructor.mock.calls[0][1];
        expect(config.data.datasets).toHaveLength(2);

        const ribbon = config.data.datasets[0];
        expect(ribbon.type).toBe('bar');
        expect(ribbon.barThickness).toBe(6);
        // bucket 0 = 00-03 local, all no-service -> gap; bucket 1 = 03-06
        // local, hour 3-4 no-service and hour 5 in service (60+ (5%4)*10=70, veh 10)
        expect(ribbon.data[0]).toBeNull();
        expect(ribbon.data[1]).toEqual([70, 70]);

        const line = config.data.datasets[1];
        expect(line.type).toBe('line');
        expect(line.data[0]).toBeNull();
        expect(line.data[1]).toBeCloseTo(70, 10);
        expect(line.spanGaps).toBe(false);
    });

    test('ribbon bounds are the worst and best hour of the bucket', async () => {
        const drawChart = await loadChart();
        // Bucket 06-12 local on day 1: on_time_pct = 60 + (h%4)*10 -> 80,90,60,70,80,90
        // weighted by vehicles 5+h -> h=6..11
        const pts = makeDays(1);
        drawChart('test-canvas', pts, 3);
        const config = mockChartConstructor.mock.calls[0][1];
        const ribbon = config.data.datasets[0];
        // days=3 -> 3h buckets: bucket 2 = hours 06-08 local
        expect(ribbon.data[2]).toEqual([60, 90]);
        // weighted avg over the same hours, spot-checked by hand
        const inBucket = pts.slice(6, 9);
        const manual = inBucket.reduce(
            (acc, p) => acc + (p.on_time_pct as number) * (p.vehicle_count as number), 0,
        ) / inBucket.reduce((acc, p) => acc + (p.vehicle_count as number), 0);
        expect(config.data.datasets[1].data[2]).toBeCloseTo(manual, 10);
    });

    test('x axis labels mark day boundaries only', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', makeDays(3), 3); // 24 buckets, midnight at 0, 8, 16
        const config = mockChartConstructor.mock.calls[0][1];
        const ticks = config.options.scales.x.ticks;
        expect(ticks.autoSkip).toBe(false);
        expect(ticks.callback(0, 0)).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
        expect(ticks.callback(0, 1)).toBe('');
        expect(ticks.callback(0, 8)).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
    });

    test('drawn point counts stay small in every range', async () => {
        const drawChart = await loadChart();
        for (const days of [3, 7, 14]) {
            mockChartConstructor.mockClear();
            drawChart('test-canvas', makeDays(days), days);
            const config = mockChartConstructor.mock.calls[0][1];
            expect(config.data.datasets[1].data.length).toBeLessThanOrEqual(40);
        }
        mockChartConstructor.mockClear();
        drawChart('test-canvas', makeDays(1), 1);
        expect(mockChartConstructor.mock.calls[0][1].data.datasets[0].data.length).toBeLessThanOrEqual(40);
    });

    test('tooltip summarizes the bucket (weighted avg, range, vehicles, service)', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', makeDays(3), 3);
        const config = mockChartConstructor.mock.calls[0][1];
        const { title, label } = config.options.plugins.tooltip.callbacks;

        // Bucket 1 (03-06): one service hour, two no-service -> sparse note
        const header = title([{ dataIndex: 1 }]);
        expect(header).toContain('h bucket');
        expect(header).toContain('1 of 3 hours in service');

        const lines = label({ dataIndex: 1 });
        expect(lines[0]).toMatch(/^On-time: .*\(range .*\)$/);
        expect(lines[1]).toMatch(/^Avg dev: /);
        expect(lines[1]).toContain('P95:');
        expect(lines[2]).toMatch(/^Vehicles: .*Bunching: /);

        // Fully served bucket reads "all hours in service"
        expect(title([{ dataIndex: 3 }])).toContain('all hours in service');
    });

    test('tooltip filter hides the ribbon entry, one tooltip per bucket', async () => {
        const drawChart = await loadChart();
        drawChart('test-canvas', makeDays(3), 3);
        const config = mockChartConstructor.mock.calls[0][1];
        const filter = config.options.plugins.tooltip.filter;
        expect(filter({ datasetIndex: 1 })).toBe(true);
        expect(filter({ datasetIndex: 0 })).toBe(false);
    });
});

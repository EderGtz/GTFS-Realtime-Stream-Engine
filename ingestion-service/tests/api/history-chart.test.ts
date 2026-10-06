// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for history-chart.js — drawChart(canvasId, points).
 *
 * Uses jsdom to verify the chart module's public API and lifecycle,
 * without requiring Chart.js to render actual pixels (which needs canvas).
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
    await import('../../src/public/history-chart.js');
    return (window as any).drawChart;
}

const samplePoints = [
    { hour: '2026-10-05T10:00:00Z', on_time_pct: 75, avg_deviation: 100,
      p95_deviation: 250, vehicle_count: 20, bunching_events: 1 },
    { hour: '2026-10-05T11:00:00Z', on_time_pct: 80, avg_deviation: 90,
      p95_deviation: 200, vehicle_count: 22, bunching_events: 0 },
];

describe('drawChart', () => {
    test('is exposed as window.drawChart', async () => {
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

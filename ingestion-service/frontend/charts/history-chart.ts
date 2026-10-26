/**
 * Route history trend chart (Chart.js).
 *
 * WHAT THIS FILE OWNS:
 *   - drawChart(canvasId, points, days): draws/redraws the trend chart
 *   - aggregateBuckets(points, bucketHours): the bucketing/weighted math
 *
 * Multi-day ranges are NOT drawn point-per-hour. Instead the hourly API points are
 * collapsed into local-midnight-aligned buckets whose size adapts to the
 * selected range (always ~24-40 drawn points). Each bucket renders as:
 *   - a min-max floating bar (the ribbon: worst hour .. best hour in the
 *     bucket, so spikes survive instead of being averaged away), and
 *   - a line through the vehicle-weighted bucket average
 *     (sum(pct * vehicles) / sum(vehicles)).
 * Hours with vehicle_count = 0 ("no service", typically overnight) are
 * excluded from the math and render as gaps, never as false 0% dips.
 */

/// <reference path="../globals.d.ts" />

import type { HourlyDataPoint } from '../../src/api/types.js';
import { formatPct, formatSeconds, formatSignedSeconds } from '../lib/format.js';
import type { ChartConfiguration, TooltipItem } from 'chart.js';

// ── Bucketing ────────────────────────────────────────────────────────────

// The Chart.js instance is kept here so drawChart can destroy the
// previous chart before drawing a new one (day-range switching).
// Only `.destroy()` is ever called on it, which is all we type here — the
// hourly and bucketed views produce different Chart<TType> instantiations.
let currentChart: { destroy(): void } | null = null;

// Bucket size (hours) per selectable range, sized so every range draws a
// constant ~24-40 points. 1d stays hourly ("as today"); 30d/90d entries
// are for the future range buttons (90d is the API max).
const BUCKET_HOURS_BY_DAYS: Record<number, number> = { 1: 1, 3: 3, 7: 6, 14: 12, 30: 24, 90: 72 };

function bucketHoursForDays(days: number): number {
    const preset = BUCKET_HOURS_BY_DAYS[days];
    if (preset !== undefined) return preset;
    // Unknown range: smallest known bucket size that keeps <= ~40 points.
    const ladder = [1, 3, 6, 12, 24, 72];
    for (const h of ladder) {
        if (Math.ceil((days * 24) / h) <= 40) return h;
    }
    return ladder[ladder.length - 1] ?? 72; // widest bucket (= 72h) as last resort
}

function formatHourLabel(isoString: string): string {
    const d = new Date(isoString);
    const month = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();
    const hour = d.toLocaleString('en-US', { hour: 'numeric' });
    return month + ' ' + day + ', ' + hour;
}

// Day-boundary tick label ("Mon 6") — the only label shown on bucketed
// x-axes, so each day reads as its own column.
function formatDayLabel(d: Date): string {
    const weekday = d.toLocaleString('en-US', { weekday: 'short' });
    return weekday + ' ' + d.getDate();
}

// Local-day arithmetic. Bucketing uses browser-local time, so a "day"
// boundary is the viewer's midnight, not UTC's.
const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_DAY = new Date(1970, 0, 1);

function startOfLocalDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function localDayIndex(d: Date): number {
    // Round: DST days are 23/25h, so the raw quotient is not an integer.
    return Math.round((startOfLocalDay(d).getTime() - EPOCH_DAY.getTime()) / DAY_MS);
}

function dayFromIndex(dayIndex: number): Date {
    return new Date(1970, 0, 1 + dayIndex);
}

// Start (local time) of the bucket containing `d`.
function bucketStart(d: Date, bucketHours: number): Date {
    if (bucketHours <= 1) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours());
    }
    if (bucketHours < 24) {
        const hour = Math.floor(d.getHours() / bucketHours) * bucketHours;
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour);
    }
    // Multi-day buckets group whole local days. Aligning the group index
    // to a fixed epoch keeps the same calendar days in the same bucket
    // across renders (floor(hour / 72) alone is always 0 for one day).
    const groupDays = Math.round(bucketHours / 24);
    const dayIndex = localDayIndex(d);
    return dayFromIndex(Math.floor(dayIndex / groupDays) * groupDays);
}

/** One entry of the always-complete bucket grid (start + day-grouping size). */
interface BucketGridEntry {
    start: Date;
    groupDays: number;
}

// Every bucket start in [firstDayIndex, lastDayIndex], including buckets
// with no data. The full grid is what keeps day labels/gridlines aligned
// when the API omits hours with no service (the usual overnight case).
function bucketGrid(firstDayIndex: number, lastDayIndex: number, bucketHours: number): BucketGridEntry[] {
    const starts: BucketGridEntry[] = [];
    if (bucketHours < 24) {
        const perDay = Math.ceil(24 / bucketHours);
        for (let day = firstDayIndex; day <= lastDayIndex; day++) {
            const base = dayFromIndex(day);
            for (let i = 0; i < perDay; i++) {
                starts.push({
                    start: new Date(
                        base.getFullYear(), base.getMonth(), base.getDate(), i * bucketHours
                    ),
                    groupDays: 1,
                });
            }
        }
    } else {
        const groupDays = Math.round(bucketHours / 24);
        const firstGroup = Math.floor(firstDayIndex / groupDays);
        const lastGroup = Math.floor(lastDayIndex / groupDays);
        for (let g = firstGroup; g <= lastGroup; g++) {
            starts.push({ start: dayFromIndex(g * groupDays), groupDays: groupDays });
        }
    }
    return starts;
}

// ── Bucket shapes ────────────────────────────────────────────────────────

/**
 * A finished bucket — the documented return shape of aggregateBuckets.
 */
interface Bucket {
    /** 'Mon 6' for the bucket starting at local midnight, '' otherwise. */
    label: string;
    /** Tooltip header ('Mon 6', 'Mon 6, 12 PM', or 'Mon 6 – Wed 8'). */
    title: string;
    /** ISO string of the bucket's local start. */
    startHour: string;
    /** sum(pct*count)/sum(count) over service hours, null = no service (gap). */
    weighted_on_time: number | null;
    /** Same weighting applied to avg_deviation. */
    weighted_avg_dev: number | null;
    /** Ribbon bounds over service hours (null when none). */
    min_on_time: number | null;
    max_on_time: number | null;
    /** Max of hourly p95_deviation (percentiles are not additive). */
    p95_max: number | null;
    vehicle_total: number;
    bunching_total: number;
    /** Service hours contributing (vehicle_count > 0). */
    hours: number;
    /** Hours present but with vehicle_count = 0. */
    no_service: number;
}

/**
 * Bucket while it is still being accumulated. The underscore fields are
 * running sums that the finalize pass folds into the weighted_* values and
 * then strips (via rest-destructuring), so callers only ever see Bucket.
 */
interface BucketAcc extends Bucket {
    _pctWeightedSum: number;
    _devWeightedSum: number;
    _weight: number;
}

function newBucket(start: Date, groupDays: number): BucketAcc {
    const isMidnight = start.getHours() === 0;
    const dayLabel = formatDayLabel(start);
    // For multi-day groups `end` is the last day of the group; for single-day
    // buckets it stays null (the ternary below is exactly the old
    // `groupDays > 1` branch, restructured so TypeScript can see it too).
    const end = groupDays > 1
        ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + groupDays - 1)
        : null;
    const title = end
        ? dayLabel + ' \u2013 ' + formatDayLabel(end)
        : (isMidnight
            ? dayLabel
            : dayLabel + ', ' + start.toLocaleString('en-US', { hour: 'numeric' }));
    return {
        label: isMidnight ? dayLabel : '',
        title,
        startHour: start.toISOString(),
        weighted_on_time: null,
        weighted_avg_dev: null,
        min_on_time: null,
        max_on_time: null,
        p95_max: null,
        vehicle_total: 0,
        bunching_total: 0,
        hours: 0,
        no_service: 0,
        _pctWeightedSum: 0,
        _devWeightedSum: 0,
        _weight: 0,
    };
}

function addPointToBucket(b: BucketAcc, p: HourlyDataPoint): void {
    b.vehicle_total += p.vehicle_count;
    b.bunching_total += p.bunching_events;

    if (p.vehicle_count > 0) {
        // Genuine data — including a real 0% with vehicles in service.
        b.hours += 1;
        b._pctWeightedSum += p.on_time_pct * p.vehicle_count;
        b._devWeightedSum += p.avg_deviation * p.vehicle_count;
        b._weight += p.vehicle_count;
        if (b.min_on_time === null || p.on_time_pct < b.min_on_time) b.min_on_time = p.on_time_pct;
        if (b.max_on_time === null || p.on_time_pct > b.max_on_time) b.max_on_time = p.on_time_pct;
        if (b.p95_max === null || p.p95_deviation > b.p95_max) b.p95_max = p.p95_deviation;
    } else {
        // "No service" hour: counted for the tooltip, excluded from the
        // math so it can't fake a 0% dip.
        b.no_service += 1;
    }
}

/**
 * Collapse hourly API points into local-midnight-aligned buckets.
 *
 * The grid spans every bucket from the first to the last observed local
 * day, not just buckets that happen to contain a point. That matters in
 * production: the analytics engine skips hours with no service, so the
 * API usually has no overnight rows. Without empty grid buckets, the
 * midnight bucket that carries the day label (and its gridline) would
 * disappear entirely on those days.
 *
 * @param points      hourly points from /v1/routes/:id/history, sorted by
 *                    `hour` ascending.
 * @param bucketHours window size in hours (1 = one bucket per observed hour,
 *                    i.e. pass-through).
 * @returns one Bucket per bucket, in chronological order. Buckets whose
 *          service hours summed to zero keep weighted_* null so the chart
 *          renders them as gaps.
 */
function aggregateBuckets(points: HourlyDataPoint[], bucketHours: number): Bucket[] {
    if (!points || points.length === 0) return [];

    const buckets: BucketAcc[] = [];
    const byKey: Record<number, BucketAcc> = Object.create(null);

    if (bucketHours <= 1) {
        // Pass-through: one bucket per observed hour. (The 1-day chart
        // uses drawHourly; this keeps the helper's documented contract.)
        for (const p of points) {
            const start = bucketStart(new Date(p.hour), 1);
            const key = start.getTime();
            let target = byKey[key];
            if (!target) {
                target = newBucket(start, 1);
                byKey[key] = target;
                buckets.push(target);
            }
            addPointToBucket(target, p);
        }
    } else {
        let firstDay: number | null = null;
        let lastDay: number | null = null;
        for (const p of points) {
            const dayIndex = localDayIndex(new Date(p.hour));
            if (firstDay === null || dayIndex < firstDay) firstDay = dayIndex;
            if (lastDay === null || dayIndex > lastDay) lastDay = dayIndex;
        }
        // Unreachable in practice (empty input returned above), but keeps
        // the narrowing explicit for the compiler.
        if (firstDay === null || lastDay === null) return [];

        const grid = bucketGrid(firstDay, lastDay, bucketHours);
        for (const g of grid) {
            const bucket = newBucket(g.start, g.groupDays);
            byKey[g.start.getTime()] = bucket;
            buckets.push(bucket);
        }

        for (const point of points) {
            const bucketKey = bucketStart(new Date(point.hour), bucketHours).getTime();
            const target = byKey[bucketKey];
            if (target) addPointToBucket(target, point);
        }
    }

    // Finalize: fold the running sums into the weighted values and strip the
    // accumulators (rest-destructuring replaces the old `delete b._x` calls —
    // the returned objects have exactly the same shape as before).
    const finished: Bucket[] = [];
    for (const { _pctWeightedSum, _devWeightedSum, _weight, ...clean } of buckets) {
        if (_weight > 0) {
            clean.weighted_on_time = _pctWeightedSum / _weight;
            clean.weighted_avg_dev = _devWeightedSum / _weight;
        }
        // else: no service -> values stay null, the bucket renders as a
        // gap (no bar, no line segment).
        finished.push(clean);
    }

    return finished;
}

// Tooltip footer of the bucket header line, making sparse buckets honest.
function serviceNote(b: Bucket, bucketHours: number): string {
    return b.hours === bucketHours
        ? 'all hours in service'
        : b.hours + ' of ' + bucketHours + ' hours in service';
}

// ── Drawing ──────────────────────────────────────────────────────────────

/**
 * 1-day view: today's chart (one point per hour, filled line) with the
 * per-hour tooltip. Only change vs the original: no-service hours (which
 * the API stores as on_time_pct = 0) render as gaps, not false dips.
 */
function drawHourly(canvas: HTMLCanvasElement, points: HourlyDataPoint[]): { destroy(): void } {
    const config: ChartConfiguration<'line'> = {
        type: 'line',
        data: {
            labels: points.map((p) => formatHourLabel(p.hour)),
            datasets: [{
                label: 'On-time %',
                data: points.map((p) => (p.vehicle_count > 0 ? p.on_time_pct : null)),
                borderColor: '#3498db',
                backgroundColor: 'rgba(52, 152, 219, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 2,
                pointHoverRadius: 5,
                pointBackgroundColor: '#3498db',
                borderWidth: 2,
                spanGaps: false,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (ctx: TooltipItem<'line'>) {
                            const p = points[ctx.dataIndex];
                            if (!p) return '';
                            return [
                                'On-time: ' + p.on_time_pct + '%',
                                'Avg dev: ' + formatSeconds(p.avg_deviation),
                                'P95: ' + formatSeconds(p.p95_deviation),
                                'Vehicles: ' + p.vehicle_count,
                                'Bunching: ' + p.bunching_events,
                            ];
                        },
                    },
                },
            },
            scales: {
                x: {
                    ticks: {
                        maxTicksLimit: 6,
                        font: { size: 10 },
                        color: '#999',
                    },
                    grid: { display: false },
                },
                y: {
                    min: 0,
                    max: 100,
                    ticks: {
                        stepSize: 25,
                        font: { size: 10 },
                        color: '#999',
                        callback: function (v: string | number) { return v + '%'; },
                    },
                    grid: { color: '#f0f0f0' },
                },
            },
        },
    };
    return new Chart(canvas.getContext('2d')!, config);
}

/**
 * 3/7/14-day view: min-max ribbon + vehicle-weighted trend line, with
 * day-boundary ticks/gridlines and per-bucket tooltips.
 */
function drawBuckets(
    canvas: HTMLCanvasElement,
    buckets: Bucket[],
    bucketHours: number,
): { destroy(): void } {
    // Mixed chart (floating bar + line) — Chart.js types a mixed config
    // under the union of the two chart types.
    const config: ChartConfiguration<'bar' | 'line'> = {
        type: 'line',
        data: {
            labels: buckets.map((b) => b.label),
            datasets: [
                {
                    // Floating bar ([min, max]) = the ribbon: the spread
                    // of the bucket's hours, so bad hours stay visible.
                    type: 'bar',
                    label: 'Range',
                    data: buckets.map((b): [number, number] | null =>
                        // hours > 0 implies min/max were set by addPointToBucket;
                        // the extra null checks just make that visible to the
                        // compiler (behavior identical).
                        (b.hours > 0 && b.min_on_time !== null && b.max_on_time !== null)
                            ? [b.min_on_time, b.max_on_time]
                            : null
                    ),
                    backgroundColor: 'rgba(52, 152, 219, 0.15)',
                    borderWidth: 0,
                    barThickness: 6,
                    order: 1, // draw behind the trend line
                },
                {
                    type: 'line',
                    label: 'On-time %',
                    data: buckets.map((b) => b.weighted_on_time),
                    borderColor: '#3498db',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: buckets.length > 40 ? 0 : 2,
                    pointHoverRadius: 5,
                    pointBackgroundColor: '#3498db',
                    spanGaps: false, // no-service buckets stay gaps
                    fill: false,
                    order: 0,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    // Ribbon entries are summarized by the line entry's
                    // tooltip; show one tooltip per bucket.
                    filter: function (item) { return item.datasetIndex === 1; },
                    callbacks: {
                        title: function (items: TooltipItem<'bar' | 'line'>[]) {
                            const first = items[0];
                            if (!first) return '';
                            const b = buckets[first.dataIndex];
                            if (!b) return '';
                            return b.title + ' \u2014 ' + bucketHours + 'h bucket (' +
                                serviceNote(b, bucketHours) + ')';
                        },
                        label: function (ctx: TooltipItem<'bar' | 'line'>) {
                            const b = buckets[ctx.dataIndex];
                            if (!b) return '';
                            return [
                                'On-time: ' + formatPct(b.weighted_on_time ?? 0) + '%   (range ' +
                                    formatPct(b.min_on_time ?? 0) + '\u2013' + formatPct(b.max_on_time ?? 0) + '%)',
                                'Avg dev: ' + formatSignedSeconds(b.weighted_avg_dev ?? 0) +
                                    '   P95: ' + formatSeconds(b.p95_max ?? 0) +
                                    (b.hours > 1 ? ' (worst hour)' : ''),
                                'Vehicles: ' + b.vehicle_total.toLocaleString() +
                                    '   Bunching: ' + b.bunching_total,
                            ];
                        },
                    },
                },
            },
            scales: {
                x: {
                    ticks: {
                        autoSkip: false,
                        maxRotation: 0,
                        // '' for mid-day buckets renders nothing, so the
                        // axis reads as one label per day.
                        callback: function (_v: string | number, i: number) {
                            const b = buckets[i];
                            return b ? b.label : '';
                        },
                        font: { size: 10 },
                        color: '#999',
                    },
                    grid: {
                        display: true,
                        // Light vertical line at each local midnight only.
                        color: function (ctx) {
                            // The fallback through ctx.tick.index is the
                            // original defensive lookup (older Chart.js
                            // contexts); v4 always provides ctx.index. The
                            // cast keeps the runtime expression identical
                            // even though v4's Tick type has no `index`.
                            const tick = ctx.tick as { index?: number } | undefined;
                            const idx = typeof ctx.index === 'number'
                                ? ctx.index
                                : (tick ? tick.index : undefined);
                            const b = typeof idx === 'number' ? buckets[idx] : undefined;
                            return (b && b.label) ? '#e8e8e8' : 'rgba(0,0,0,0)';
                        },
                    },
                },
                y: {
                    min: 0,
                    max: 100,
                    ticks: {
                        stepSize: 25,
                        font: { size: 10 },
                        color: '#999',
                        callback: function (v: string | number) { return v + '%'; },
                    },
                    grid: { color: '#f0f0f0' },
                },
            },
        },
    };
    return new Chart(canvas.getContext('2d')!, config);
}

/**
 * Draw (or redraw) the on-time % trend chart on the given canvas.
 *
 * @param canvasId — the id attribute of the <canvas> element.
 * @param points   — hourly points from /v1/routes/:id/history (the shared
 *                   HourlyDataPoint contract). Empty/absent = no draw.
 * @param days     — selected range in days; drives the bucket size (1 =
 *                   hourly, as before). Optional, so existing callers keep
 *                   the hourly view.
 */
function drawChart(canvasId: string, points?: HourlyDataPoint[] | null, days?: number): void {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    // `typeof Chart === 'undefined'` guards the CDN script not being loaded
    // yet (the original checked window.Chart the same way).
    if (!canvas || typeof Chart === 'undefined' || !points || points.length === 0) return;

    // Destroy the previous chart so the canvas can be reused.
    if (currentChart) {
        currentChart.destroy();
        currentChart = null;
    }

    const bucketHours = bucketHoursForDays(days ?? 1);
    if (bucketHours <= 1) {
        currentChart = drawHourly(canvas, points);
    } else {
        currentChart = drawBuckets(canvas, aggregateBuckets(points, bucketHours), bucketHours);
    }
}

export { drawChart, aggregateBuckets };
export type { Bucket };

/**
 * History Chart
 * Draws the route history trend chart (on-time % over time) using Chart.js.
 *
 * Chart.js is expected to be loaded from CDN before this script runs.
 *
 * Multi-day ranges are NOT drawn point-per-hour (14 days = 336 points into a
 * ~350px panel reads as a scribble). Instead the hourly API points are
 * collapsed into local-midnight-aligned buckets whose size adapts to the
 * selected range (always ~24-40 drawn points). Each bucket renders as:
 *   - a min-max floating bar (the ribbon: worst hour .. best hour in the
 *     bucket, so spikes survive instead of being averaged away), and
 *   - a line through the vehicle-weighted bucket average
 *     (sum(pct * vehicles) / sum(vehicles) — NOT a plain mean of hourly %).
 * Hours with vehicle_count = 0 ("no service", typically overnight) are
 * excluded from the math and render as gaps, never as false 0% dips.
 */

(function () {
    'use strict';

    // The Chart.js instance is kept here so drawChart can destroy the
    // previous chart before drawing a new one (day-range switching).
    var currentChart = null;

    // Bucket size (hours) per selectable range, sized so every range draws a
    // constant ~24-40 points. 1d stays hourly ("as today"); 30d/90d entries
    // are for the future range buttons (90d is the API max).
    var BUCKET_HOURS_BY_DAYS = { 1: 1, 3: 3, 7: 6, 14: 12, 30: 24, 90: 72 };

    function bucketHoursForDays(days) {
        if (BUCKET_HOURS_BY_DAYS[days]) return BUCKET_HOURS_BY_DAYS[days];
        // Unknown range: smallest known bucket size that keeps <= ~40 points.
        var ladder = [1, 3, 6, 12, 24, 72];
        for (var i = 0; i < ladder.length; i++) {
            if (Math.ceil((days * 24) / ladder[i]) <= 40) return ladder[i];
        }
        return ladder[ladder.length - 1];
    }

    function formatHourLabel(isoString) {
        var d = new Date(isoString);
        var month = d.toLocaleString('en-US', { month: 'short' });
        var day = d.getDate();
        var hour = d.toLocaleString('en-US', { hour: 'numeric' });
        return month + ' ' + day + ', ' + hour;
    }

    // Day-boundary tick label ("Mon 6") — the only label shown on bucketed
    // x-axes, so each day reads as its own column.
    function formatDayLabel(d) {
        var weekday = d.toLocaleString('en-US', { weekday: 'short' });
        return weekday + ' ' + d.getDate();
    }

    function formatSeconds(s) {
        if (s === 0) return '0s';
        var abs = Math.abs(s);
        if (abs < 60) return Math.round(abs) + 's';
        var min = Math.floor(abs / 60);
        var sec = Math.round(abs % 60);
        return sec > 0 ? min + 'm ' + sec + 's' : min + 'm';
    }

    // Deviations can be early (negative) — keep the sign visible in tooltips.
    function formatSignedSeconds(s) {
        var sign = s > 0 ? '+' : (s < 0 ? '\u2212' : '');
        return sign + formatSeconds(s);
    }

    // Trim the trailing '.0' from whole-number percentages.
    function formatPct(v) {
        return String(Math.round(v * 10) / 10);
    }

    // Local-day arithmetic. Bucketing uses browser-local time, so a "day"
    // boundary is the viewer's midnight, not UTC's.
    var DAY_MS = 24 * 60 * 60 * 1000;
    var EPOCH_DAY = new Date(1970, 0, 1);

    function startOfLocalDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function localDayIndex(d) {
        // Round: DST days are 23/25h, so the raw quotient is not an integer.
        return Math.round((startOfLocalDay(d) - EPOCH_DAY) / DAY_MS);
    }

    function dayFromIndex(dayIndex) {
        return new Date(1970, 0, 1 + dayIndex);
    }

    // Start (local time) of the bucket containing `d`.
    function bucketStart(d, bucketHours) {
        if (bucketHours <= 1) {
            return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours());
        }
        if (bucketHours < 24) {
            var hour = Math.floor(d.getHours() / bucketHours) * bucketHours;
            return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour);
        }
        // Multi-day buckets group whole local days. Aligning the group index
        // to a fixed epoch keeps the same calendar days in the same bucket
        // across renders (floor(hour / 72) alone is always 0 for one day).
        var groupDays = Math.round(bucketHours / 24);
        var dayIndex = localDayIndex(d);
        return dayFromIndex(Math.floor(dayIndex / groupDays) * groupDays);
    }

    // Every bucket start in [firstDayIndex, lastDayIndex], including buckets
    // with no data. The full grid is what keeps day labels/gridlines aligned
    // when the API omits hours with no service (the usual overnight case).
    function bucketGrid(firstDayIndex, lastDayIndex, bucketHours) {
        var starts = [];
        if (bucketHours < 24) {
            var perDay = Math.ceil(24 / bucketHours);
            for (var day = firstDayIndex; day <= lastDayIndex; day++) {
                var base = dayFromIndex(day);
                for (var i = 0; i < perDay; i++) {
                    starts.push({
                        start: new Date(
                            base.getFullYear(), base.getMonth(), base.getDate(), i * bucketHours
                        ),
                        groupDays: 1,
                    });
                }
            }
        } else {
            var groupDays = Math.round(bucketHours / 24);
            var firstGroup = Math.floor(firstDayIndex / groupDays);
            var lastGroup = Math.floor(lastDayIndex / groupDays);
            for (var g = firstGroup; g <= lastGroup; g++) {
                starts.push({ start: dayFromIndex(g * groupDays), groupDays: groupDays });
            }
        }
        return starts;
    }

    function newBucket(start, groupDays) {
        var isMidnight = start.getHours() === 0;
        var dayLabel = formatDayLabel(start);
        var end = groupDays > 1
            ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + groupDays - 1)
            : null;
        return {
            label: isMidnight ? dayLabel : '',
            title: groupDays > 1
                ? dayLabel + ' \u2013 ' + formatDayLabel(end)
                : (isMidnight
                    ? dayLabel
                    : dayLabel + ', ' + start.toLocaleString('en-US', { hour: 'numeric' })),
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

    function addPointToBucket(b, p) {
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
     * @param {Array}  points      — hourly points from /v1/routes/:id/history,
     *                               sorted by `hour` ascending.
     * @param {number} bucketHours — window size in hours (1 = one bucket per
     *                               observed hour, i.e. pass-through).
     * @returns {Array} one object per bucket, in chronological order:
     *   label            'Mon 6' for the bucket starting at local midnight,
     *                    '' for mid-day buckets (hides those x ticks)
     *   title            tooltip header ('Mon 6' at midnight, 'Mon 6, 12 PM'
     *                    for later buckets, 'Mon 6 – Wed 8' for multi-day)
     *   startHour        ISO string of the bucket's local start
     *   weighted_on_time sum(pct*count)/sum(count) over service hours, or
     *                    null when the bucket had no service (chart gap)
     *   weighted_avg_dev same weighting applied to avg_deviation
     *   min_on_time      ribbon bounds over service hours (null when none)
     *   max_on_time
     *   p95_max          max of hourly p95_deviation (percentiles are not
     *                    additive, so the bucket uses the worst hour's value)
     *   vehicle_total    sum of vehicle_count
     *   bunching_total   sum of bunching_events
     *   hours            service hours contributing (vehicle_count > 0)
     *   no_service       hours present but with vehicle_count = 0
     */
    function aggregateBuckets(points, bucketHours) {
        if (!points || points.length === 0) return [];

        var buckets = [];
        var byKey = Object.create(null);

        if (bucketHours <= 1) {
            // Pass-through: one bucket per observed hour. (The 1-day chart
            // uses drawHourly; this keeps the helper's documented contract.)
            for (var i = 0; i < points.length; i++) {
                var p = points[i];
                var start = bucketStart(new Date(p.hour), 1);
                var key = start.getTime();
                if (!byKey[key]) {
                    byKey[key] = newBucket(start, 1);
                    buckets.push(byKey[key]);
                }
                addPointToBucket(byKey[key], p);
            }
        } else {
            var firstDay = null;
            var lastDay = null;
            for (var j = 0; j < points.length; j++) {
                var dayIndex = localDayIndex(new Date(points[j].hour));
                if (firstDay === null || dayIndex < firstDay) firstDay = dayIndex;
                if (lastDay === null || dayIndex > lastDay) lastDay = dayIndex;
            }

            var grid = bucketGrid(firstDay, lastDay, bucketHours);
            for (var g = 0; g < grid.length; g++) {
                var bucket = newBucket(grid[g].start, grid[g].groupDays);
                byKey[grid[g].start.getTime()] = bucket;
                buckets.push(bucket);
            }

            for (var k = 0; k < points.length; k++) {
                var point = points[k];
                var bucketKey = bucketStart(new Date(point.hour), bucketHours).getTime();
                var target = byKey[bucketKey];
                if (target) addPointToBucket(target, point);
            }
        }

        for (var m = 0; m < buckets.length; m++) {
            var b = buckets[m];
            if (b._weight > 0) {
                b.weighted_on_time = b._pctWeightedSum / b._weight;
                b.weighted_avg_dev = b._devWeightedSum / b._weight;
            }
            // else: no service -> values stay null, the bucket renders as a
            // gap (no bar, no line segment).
            delete b._pctWeightedSum;
            delete b._devWeightedSum;
            delete b._weight;
        }

        return buckets;
    }

    // Tooltip footer of the bucket header line, making sparse buckets honest.
    function serviceNote(b, bucketHours) {
        return b.hours === bucketHours
            ? 'all hours in service'
            : b.hours + ' of ' + bucketHours + ' hours in service';
    }

    // 1-day view: today's chart (one point per hour, filled line) with the
    // per-hour tooltip. Only change vs the original: no-service hours (which
    // the API stores as on_time_pct = 0) render as gaps, not false dips.
    function drawHourly(canvas, points) {
        return new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: points.map(function (p) { return formatHourLabel(p.hour); }),
                datasets: [{
                    label: 'On-time %',
                    data: points.map(function (p) {
                        return p.vehicle_count > 0 ? p.on_time_pct : null;
                    }),
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
                            label: function (ctx) {
                                var p = points[ctx.dataIndex];
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
                            callback: function (v) { return v + '%'; },
                        },
                        grid: { color: '#f0f0f0' },
                    },
                },
            },
        });
    }

    // 3/7/14-day view: min-max ribbon + vehicle-weighted trend line, with
    // day-boundary ticks/gridlines and per-bucket tooltips.
    function drawBuckets(canvas, buckets, bucketHours) {
        return new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: buckets.map(function (b) { return b.label; }),
                datasets: [
                    {
                        // Floating bar ([min, max]) = the ribbon: the spread
                        // of the bucket's hours, so bad hours stay visible.
                        type: 'bar',
                        label: 'Range',
                        data: buckets.map(function (b) {
                            return b.hours > 0 ? [b.min_on_time, b.max_on_time] : null;
                        }),
                        backgroundColor: 'rgba(52, 152, 219, 0.15)',
                        borderWidth: 0,
                        barThickness: 6,
                        order: 1, // draw behind the trend line
                    },
                    {
                        type: 'line',
                        label: 'On-time %',
                        data: buckets.map(function (b) { return b.weighted_on_time; }),
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
                            title: function (items) {
                                if (!items.length) return '';
                                var b = buckets[items[0].dataIndex];
                                return b.title + ' \u2014 ' + bucketHours + 'h bucket (' +
                                    serviceNote(b, bucketHours) + ')';
                            },
                            label: function (ctx) {
                                var b = buckets[ctx.dataIndex];
                                return [
                                    'On-time: ' + formatPct(b.weighted_on_time) + '%   (range ' +
                                        formatPct(b.min_on_time) + '\u2013' + formatPct(b.max_on_time) + '%)',
                                    'Avg dev: ' + formatSignedSeconds(b.weighted_avg_dev) +
                                        '   P95: ' + formatSeconds(b.p95_max) +
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
                            callback: function (v, i) { return buckets[i] ? buckets[i].label : ''; },
                            font: { size: 10 },
                            color: '#999',
                        },
                        grid: {
                            display: true,
                            // Light vertical line at each local midnight only.
                            color: function (ctx) {
                                var idx = typeof ctx.index === 'number' ? ctx.index
                                    : (ctx.tick && ctx.tick.index);
                                var b = buckets[idx];
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
                            callback: function (v) { return v + '%'; },
                        },
                        grid: { color: '#f0f0f0' },
                    },
                },
            },
        });
    }

    /**
     * Draw (or redraw) the on-time % trend chart on the given canvas.
     *
     * @param {string} canvasId — the id attribute of the <canvas> element.
     * @param {Array}  points   — array of data points from /v1/routes/:id/history.
     *                            Each: { hour, on_time_pct, avg_deviation,
     *                                    p95_deviation, vehicle_count,
     *                                    bunching_events }
     * @param {number} [days]   — selected range in days; drives the bucket
     *                            size (1 = hourly, as before). Optional, so
     *                            existing callers keep the hourly view.
     */
    window.drawChart = function (canvasId, points, days) {
        var canvas = document.getElementById(canvasId);
        if (!canvas || !window.Chart || !points || points.length === 0) return;

        // Destroy the previous chart so the canvas can be reused.
        if (currentChart) {
            currentChart.destroy();
            currentChart = null;
        }

        var bucketHours = bucketHoursForDays(days == null ? 1 : days);
        if (bucketHours <= 1) {
            currentChart = drawHourly(canvas, points);
        } else {
            currentChart = drawBuckets(canvas, aggregateBuckets(points, bucketHours), bucketHours);
        }
    };

    // Exposed for tests (and console spot-checks of the weighted math).
    window.aggregateBuckets = aggregateBuckets;
})();

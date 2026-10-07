/**
 * History Chart
 * Draws the route history trend chart (on-time % over time) using Chart.js.
 *
 * Chart.js is expected to be loaded from CDN before this script runs.
 */

(function () {
    'use strict';

    // The Chart.js instance is kept here so drawChart can destroy the
    // previous chart before drawing a new one (day-range switching).
    var currentChart = null;

    function formatHourLabel(isoString) {
        var d = new Date(isoString);
        var month = d.toLocaleString('en-US', { month: 'short' });
        var day = d.getDate();
        var hour = d.toLocaleString('en-US', { hour: 'numeric' });
        return month + ' ' + day + ', ' + hour;
    }

    function formatSeconds(s) {
        if (s === 0) return '0s';
        var abs = Math.abs(s);
        if (abs < 60) return Math.round(abs) + 's';
        var min = Math.floor(abs / 60);
        var sec = Math.round(abs % 60);
        return sec > 0 ? min + 'm ' + sec + 's' : min + 'm';
    }

    /**
     * Draw (or redraw) the on-time % trend chart on the given canvas.
     *
     * @param {string} canvasId — the id attribute of the <canvas> element.
     * @param {Array}  points   — array of data points from /v1/routes/:id/history.
     *                            Each: { hour, on_time_pct, avg_deviation,
     *                                    p95_deviation, vehicle_count,
     *                                    bunching_events }
     */
    window.drawChart = function (canvasId, points) {
        var canvas = document.getElementById(canvasId);
        if (!canvas || !window.Chart || !points || points.length === 0) return;

        // Destroy the previous chart so the canvas can be reused.
        if (currentChart) {
            currentChart.destroy();
            currentChart = null;
        }

        currentChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: points.map(function (p) { return formatHourLabel(p.hour); }),
                datasets: [{
                    label: 'On-time %',
                    data: points.map(function (p) { return p.on_time_pct; }),
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2,
                    pointHoverRadius: 5,
                    pointBackgroundColor: '#3498db',
                    borderWidth: 2,
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
    };
})();

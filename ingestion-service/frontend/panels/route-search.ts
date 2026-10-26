/**
 * route performance search panel.
 *
 * WHAT THIS FILE OWNS:
 *   - panel open/close, outside-click + Escape handling
 *   - route lookup (GET /v1/routes/:id/performance) and the result card
 *   - the "show only this route on map" filter buttons
 *   - the collapsible N-day history section (chart + summary + day picker)
 */

import type { RouteHistoryResponse, RoutePerformanceResponse } from '../../src/api/types.js';
import { ApiError, fetchRouteHistory, fetchRoutePerformance } from '../lib/api.js';
import { escapeHtml, formatSeconds, pctColor } from '../lib/format.js';
import { mustGetElement } from '../lib/dom.js';
import { drawChart } from '../charts/history-chart.js';
import { clearRouteFilter, filterByRoute, getActiveRouteFilter } from '../map-logic.js';

/** Route IDs the search accepts. */
const VALID_ROUTE = /^[A-Za-z0-9-]+$/;

/** Selectable history ranges in days (90 is the API max). */
const DAY_OPTIONS = [1, 3, 7, 14];

/**
 * Wire up the search panel. Call once at startup (from the map entry
 * module). All elements are static markup in map.html.
 */
export function initRouteSearch(): void {
    const btn      = mustGetElement<HTMLButtonElement>('route-search-btn');
    const panel    = mustGetElement<HTMLElement>('route-search-panel');
    const input    = mustGetElement<HTMLInputElement>('route-search-input');
    const closeBtn = mustGetElement<HTMLButtonElement>('route-search-close');
    const results  = mustGetElement<HTMLElement>('route-search-results');
    const help     = mustGetElement<HTMLElement>('route-search-help');

    // --- Panel state -----------------------------------------------------

    /** Last successful /performance payload; re-rendered when the filter
     *  buttons change the map so the button state stays in sync. */
    let lastSearchedData: RoutePerformanceResponse | null = null;
    /** Selected history range (days). */
    let historyDays = 7;
    /** Whether the history section is expanded. */
    let historyOpen = false;

    // --- Open / Close ---------------------------------------------------

    function openPanel(): void {
        btn.style.display = 'none';
        panel.classList.add('open');
        input.value = '';
        results.innerHTML = '';
        results.classList.remove('open');
        help.style.display = 'none';
        lastSearchedData = null;
        setTimeout(function () { input.focus(); }, 50);
    }

    function closePanel(): void {
        panel.classList.remove('open');
        btn.style.display = 'flex';
        btn.classList.remove('active');
        help.style.display = 'none';
    }

    btn.addEventListener('click', function () {
        openPanel();
    });

    closeBtn.addEventListener('click', function () {
        closePanel();
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && panel.classList.contains('open')) {
            closePanel();
        }
    });

    // Close when clicking outside the panel and button
    document.addEventListener('click', function (e) {
        if (!panel.classList.contains('open')) return;
        const target = e.target as Node | null;
        if (target && (panel.contains(target) || btn.contains(target))) return;
        closePanel();
    });

    // --- Help toggle (the small ? inside the panel) -----------------------

    function toggleHelp(): void {
        help.style.display = help.style.display === 'none' ? 'block' : 'none';
    }

    // Use event delegation so the ? works even after renderResults rewrites innerHTML
    results.addEventListener('click', function (e) {
        const el = e.target instanceof HTMLElement ? e.target : null;
        if (el && el.classList.contains('perf-help-btn')) {
            toggleHelp();
        }
    });

    // --- Search -----------------------------------------------------------

    /** One table row of the result card. `value` may contain HTML (colors). */
    function row(label: string, value: string | number): string {
        return '<span class="label">' + escapeHtml(label) + '</span>' +
               '<span class="value">' + value + '</span>';
    }

    function renderResults(data: RoutePerformanceResponse): void {
        const d = data.deviation;
        const b = data.bunching;
        const name = data.route_long_name || data.route_id;

        let html = '<div class="route-perf-title">' + escapeHtml(name);

        if (d.count !== 0 || b.active_events !== 0) {
            html += ' <button class="perf-help-btn" title="What do these numbers mean?" ' +
                    'style="background:none;border:none;cursor:pointer;font-size:18px;' +
                    'color:#000;vertical-align:middle;padding: -5 0 0 15px">?</button>';
        }

        html += '</div>';

        // Deviation section
        html += '<div class="route-perf-section">';
        html += '<h5>Schedule Deviation</h5>';
        if (d.count === 0) {
            html += '<div style="color:#888">No active deviations in the last 3 minutes</div>';
        } else {
            html += '<div class="route-perf-grid">';
            html += row('Vehicles tracked', d.count);
            html += row('Avg deviation', formatSeconds(d.avg_seconds));
            html += row('P95 deviation', formatSeconds(d.p95_seconds));
            html += row('Max deviation', formatSeconds(d.max_seconds));
            html += row('On time',
                '<span style="color:' + pctColor(d.vehicles_on_time_pct) + '">' +
                d.vehicles_on_time_pct + '%</span>');
            html += '</div>';
        }
        html += '</div>';

        // Bunching section
        html += '<div class="route-perf-section">';
        html += '<h5>Bunching</h5>';
        if (b.active_events === 0) {
            html += '<div style="color:#888">No active bunching events</div>';
        } else {
            html += '<div class="route-perf-grid">';
            html += row('Active events', b.active_events);
            html += row('Closest pair',
                b.worst_distance_meters !== null
                    ? Math.round(b.worst_distance_meters) + ' m'
                    : '\u2014');
            html += '</div>';
        }
        html += '</div>';

        html += '<div style="font-size:11px;color:#aaa;margin-top:6px">' +
                'Live 3-minute window &middot; ' + data.period + '</div>';

        // Show on map button
        const isActive = getActiveRouteFilter() === data.route_id;
        html += '<div style="margin-top:10px">';
        if (isActive) {
            html += '<button class="route-filter-btn" data-action="clear" ' +
                'style="background:#e74c3c;color:#fff;border:none;padding:5px 12px;border-radius:4px;' +
                'cursor:pointer;font-size:12px">Show all routes on map</button>';
        } else {
            html += '<button class="route-filter-btn" data-action="filter" data-route="' +
                escapeHtml(data.route_id) + '" ' +
                'style="background:#3498db;color:#fff;border:none;padding:5px 12px;border-radius:4px;' +
                'cursor:pointer;font-size:12px">Show only this route on map</button>';
        }
        html += '</div>';

        // History section
        html += '<div class="route-history-section">';
        html += '<div style="display:flex;align-items:center;gap:6px">';
        html += '<button class="history-toggle-btn" data-route="' + escapeHtml(data.route_id) + '" style="flex:1">' +
            '\uD83D\uDCC8 View ' + historyDays + '-day trend</button>';
        html += '<button class="history-help-btn" title="What does this chart show?" ' +
            'style="background:none;border:1px solid #ddd;border-radius:6px;cursor:pointer;' +
            'font-size:14px;color:#888;width:30px;height:30px;flex-shrink:0">?</button>';
        html += '</div>';
        html += '<div class="history-content" style="display:none"></div>';
        html += '<div class="history-help" style="display:none;padding:8px 0;font-size:12px;line-height:1.5;color:#555;border-top:1px solid #eee;margin-top:8px">';
        html += '<div style="margin-bottom:4px"><strong>What this chart shows:</strong></div>';
        html += '<div style="margin-bottom:3px">Data is aggregated hourly by the analytics engine as it processes live pings. On 3/7/14-day ranges the hours are grouped into midnight-aligned buckets (3h/6h/12h) so the chart stays readable.</div>';
        html += '<div style="margin-bottom:3px"><span style="color:#888">Blue line</span> &mdash; on-time % per hour (1d) or the vehicle-weighted average per bucket (busy hours count more than quiet ones)</div>';
        html += '<div style="margin-bottom:3px"><span style="color:#888">Shaded band</span> &mdash; the range from the worst to the best hour in each bucket, so individual bad hours stay visible</div>';
        html += '<div style="margin-bottom:3px"><span style="color:#888">On-time %</span> &mdash; share of vehicle arrivals within &plusmn;3 minutes of schedule (APTA standard)</div>';
        html += '<div style="margin-bottom:3px"><span style="color:#888">Avg deviation</span> &mdash; average minutes off schedule across all vehicles that hour</div>';
        html += '<div style="margin-bottom:3px"><span style="color:#888">P95 deviation</span> &mdash; 95% of vehicles were this late or less (bucket view shows the worst hour)</div>';
        html += '<div style="margin-bottom:3px"><span style="color:#888">Bunching events</span> &mdash; pairs of buses detected running too close together</div>';
        html += '<div style="margin-bottom:3px">Hours with no service (typically overnight) show as gaps, not 0%.</div>';
        html += '<div>Hover over the chart to see all metrics for a specific hour or bucket.</div>';
        html += '</div>';
        html += '</div>';

        results.innerHTML = html;
        results.classList.add('open');
    }

    function showError(msg: string): void {
        results.innerHTML = '<div id="route-search-error">' + escapeHtml(msg) + '</div>';
        results.classList.add('open');
    }

    function showLoading(): void {
        results.innerHTML = '<div style="color:#888">Searching\u2026</div>';
        results.classList.add('open');
    }

    async function search(query: string): Promise<void> {
        const routeId = query.trim();
        if (!routeId) return;

        if (!VALID_ROUTE.test(routeId)) {
            showError('Invalid route format. Use only letters, numbers, and hyphens.');
            return;
        }

        showLoading();

        try {
            const data = await fetchRoutePerformance(routeId);
            lastSearchedData = data;
            renderResults(data);
        } catch (err) {
            if (err instanceof ApiError) {
                if (err.status === 400) {
                    showError('Invalid route ID.');
                } else {
                    showError('Server error (HTTP ' + err.status + ')');
                }
                return;
            }
            showError('Could not reach the server. Is the API running?');
        }
    }

    // --- Route history: fetch + render ------------------------------------

    function fetchHistory(routeId: string, days: number): void {
        historyDays = days;
        const content = results.querySelector<HTMLElement>('.history-content');
        if (!content) return;

        content.innerHTML = '<div class="history-empty">Loading history\u2026</div>';

        fetchRouteHistory(routeId, days)
            .then(function (data) {
                renderHistory(data);
            })
            .catch(function (err: unknown) {
                content.innerHTML = '<div class="history-empty">Could not load history (' +
                    escapeHtml(err instanceof Error ? err.message : String(err)) + ')</div>';
            });
    }

    function renderHistory(data: RouteHistoryResponse): void {
        const content = results.querySelector<HTMLElement>('.history-content');
        if (!content) return;

        if (!data.data_points || data.data_points.length === 0) {
            content.innerHTML = '<div class="history-empty">No historical data yet. ' +
                'The analytics engine needs to run for at least one hour to accumulate data.</div>';
            return;
        }

        const points = data.data_points;

        // Summary stats. No-service hours (vehicle_count = 0, stored as
        // on_time_pct = 0) are skipped; otherwise "Avg on-time" would read
        // lower than every point actually drawn. FUTURE FIX: make these
        // vehicle-weighted too, like the bucketed chart line.
        let sumOnTime = 0, sumAvgDev = 0, sumVehicles = 0, sumBunching = 0;
        let worstOnTime = 101, worstHour = ''; // worstHour kept for a future label; not rendered yet
        let servedHours = 0;
        for (const p of points) {
            sumVehicles += p.vehicle_count;
            sumBunching += p.bunching_events;
            if (p.vehicle_count === 0) continue;
            servedHours += 1;
            sumOnTime += p.on_time_pct;
            sumAvgDev += p.avg_deviation;
            if (p.on_time_pct < worstOnTime) {
                worstOnTime = p.on_time_pct;
                worstHour = p.hour;
            }
        }
        const n = points.length;
        const hasService = servedHours > 0;
        const avgOnTime = hasService ? (sumOnTime / servedHours).toFixed(1) : null;
        const avgDev = hasService ? Math.round(sumAvgDev / servedHours) : 0;

        let html = '';
        html += '<div class="history-chart-wrap"><canvas id="history-chart"></canvas></div>';

        html += '<div class="history-summary">';
        html += '<span class="label">Avg on-time</span><span class="value" style="color:' +
            (hasService ? pctColor(parseFloat(avgOnTime ?? '0')) : '#888') + '">' +
            (hasService ? avgOnTime + '%' : '\u2014') + '</span>';
        html += '<span class="label">Avg deviation</span><span class="value">' +
            (hasService ? formatSeconds(avgDev) : '\u2014') + '</span>';
        html += '<span class="label">Worst hour</span><span class="value">' +
            (hasService ? worstOnTime.toFixed(0) + '%' : '\u2014') + '</span>';
        html += '<span class="label">Total vehicles</span><span class="value">' +
            sumVehicles.toLocaleString() + '</span>';
        html += '<span class="label">Bunching events</span><span class="value">' +
            sumBunching + '</span>';
        html += '<span class="label">Data points</span><span class="value">' + n + '</span>';
        html += '</div>';

        // Day selector
        html += '<div class="history-days">';
        for (const dayOption of DAY_OPTIONS) {
            const active = dayOption === historyDays ? ' active' : '';
            html += '<button class="day-btn' + active + '" data-days="' + dayOption + '">' +
                dayOption + 'd</button>';
        }
        html += '</div>';

        content.innerHTML = html;

        // Draw the chart (days drives the bucket size)
        drawChart('history-chart', points, historyDays);
    }

    // --- Filter button handler --------------------------------------------

    results.addEventListener('click', function (e) {
        const el = e.target instanceof HTMLElement ? e.target : null;
        if (el && el.classList.contains('route-filter-btn')) {
            e.stopPropagation();
            const action = el.getAttribute('data-action');
            if (action === 'clear') {
                clearRouteFilter();
            } else if (action === 'filter') {
                filterByRoute(el.getAttribute('data-route'));
            }
            // Re-render to update button state
            if (lastSearchedData) renderResults(lastSearchedData);
        }
    });

    // --- History toggle + day selector handlers ----------------------------

    results.addEventListener('click', function (e) {
        const el = e.target instanceof HTMLElement ? e.target : null;
        if (!el) return;

        // History expand/collapse
        if (el.classList.contains('history-toggle-btn')) {
            e.stopPropagation();
            const routeId = el.getAttribute('data-route');
            const content = results.querySelector<HTMLElement>('.history-content');
            if (!content || !routeId) return;

            if (historyOpen) {
                content.style.display = 'none';
                el.classList.remove('active');
                historyOpen = false;
            } else {
                content.style.display = 'block';
                el.classList.add('active');
                historyOpen = true;
                fetchHistory(routeId, historyDays);
            }
            return;
        }

        // History help toggle (the small ? next to the trend button)
        if (el.classList.contains('history-help-btn')) {
            e.stopPropagation();
            const helpDiv = results.querySelector<HTMLElement>('.history-help');
            if (helpDiv) {
                helpDiv.style.display = helpDiv.style.display === 'none' ? 'block' : 'none';
            }
            return;
        }

        // Day selector buttons
        if (el.classList.contains('day-btn')) {
            e.stopPropagation();
            const days = parseInt(el.getAttribute('data-days') ?? '', 10);
            if (isNaN(days)) return;

            // Update active state
            for (const b of results.querySelectorAll('.day-btn')) {
                b.classList.remove('active');
            }
            el.classList.add('active');

            // Re-fetch with new day range
            const toggleBtn = results.querySelector<HTMLElement>('.history-toggle-btn');
            const rId = toggleBtn ? toggleBtn.getAttribute('data-route') : null;
            if (toggleBtn && rId) {
                fetchHistory(rId, days);
            }
        }
    });

    // --- Input events -----------------------------------------------------

    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            void search(input.value);
        }
    });
}

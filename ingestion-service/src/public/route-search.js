/**
 * Route Performance Search
 * Follows the same plain-JS pattern as info-toggle.js.
 */

(function () {
    'use strict';

    var btn      = document.getElementById('route-search-btn');
    var panel    = document.getElementById('route-search-panel');
    var input    = document.getElementById('route-search-input');
    var closeBtn = document.getElementById('route-search-close');
    var results  = document.getElementById('route-search-results');
    var help     = document.getElementById('route-search-help');

    var API_BASE = '/v1/routes/';
    var API_SUFFIX = '/performance';

    var VALID_ROUTE = /^[A-Za-z0-9-]+$/;

    // --- Open / Close ---------------------------------------------------

    function openPanel() {
        btn.style.display = 'none';
        panel.classList.add('open');
        input.value = '';
        results.innerHTML = '';
        results.classList.remove('open');
        help.style.display = 'none';
        lastSearchedData = null;
        setTimeout(function () { input.focus(); }, 50);
    }

    function closePanel() {
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
        if (panel.contains(e.target) || btn.contains(e.target)) return;
        closePanel();
    });

    // --- Help toggle (the small ? inside the panel) ---------------------

    function toggleHelp() {
        help.style.display = help.style.display === 'none' ? 'block' : 'none';
    }

    // Use event delegation so the ? works even after renderResults rewrites innerHTML
    results.addEventListener('click', function (e) {
        if (e.target && e.target.classList.contains('perf-help-btn')) {
            toggleHelp();
        }
    });

    // --- Search ---------------------------------------------------------

    function formatSeconds(s) {
        if (s === 0) return '0s';
        var abs = Math.abs(s);
        if (abs < 60) return Math.round(abs) + 's';
        var min = Math.floor(abs / 60);
        var sec = Math.round(abs % 60);
        return sec > 0 ? min + 'm ' + sec + 's' : min + 'm';
    }

    function pctColor(pct) {
        if (pct >= 80) return '#27ae60';
        if (pct >= 50) return '#e67e22';
        return '#e74c3c';
    }

    function renderResults(data) {
        var d = data.deviation;
        var b = data.bunching;
        var name = data.route_long_name || data.route_id;

        var html = '<div class="route-perf-title">' + escapeHtml(name) 
        var html = '<div class="route-perf-title">' + escapeHtml(name);

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
        var isActive = window.getActiveRouteFilter && window.getActiveRouteFilter() === data.route_id;
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

        results.innerHTML = html;
        results.classList.add('open');
    }

    function row(label, value) {
        return '<span class="label">' + escapeHtml(label) + '</span>' +
               '<span class="value">' + value + '</span>';
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function showError(msg) {
        results.innerHTML = '<div id="route-search-error">' + escapeHtml(msg) + '</div>';
        results.classList.add('open');
    }

    var lastSearchedData = null;

    function showLoading() {
        results.innerHTML = '<div style="color:#888">Searching\u2026</div>';
        results.classList.add('open');
    }

    async function search(query) {
        var routeId = query.trim();
        if (!routeId) return;

        if (!VALID_ROUTE.test(routeId)) {
            showError('Invalid route format. Use only letters, numbers, and hyphens.');
            return;
        }

        showLoading();

        try {
            var resp = await fetch(API_BASE + encodeURIComponent(routeId) + API_SUFFIX);
            if (!resp.ok) {
                if (resp.status === 400) {
                    showError('Invalid route ID.');
                } else {
                    showError('Server error (HTTP ' + resp.status + ')');
                }
                return;
            }
            var data = await resp.json();
            lastSearchedData = data;
            renderResults(data);
        } catch (err) {
            showError('Could not reach the server. Is the API running?');
        }
    }

    // --- Filter button handler ------------------------------------------

    results.addEventListener('click', function (e) {
        if (e.target && e.target.classList.contains('route-filter-btn')) {
            var action = e.target.getAttribute('data-action');
            if (action === 'clear' && window.clearRouteFilter) {
                window.clearRouteFilter();
            } else if (action === 'filter' && window.filterByRoute) {
                var routeId = e.target.getAttribute('data-route');
                window.filterByRoute(routeId);
            }
            // Re-render to update button state
            if (lastSearchedData) renderResults(lastSearchedData);
        }
    });

    // --- Input events ---------------------------------------------------

    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            search(input.value);
        }
    });
})();
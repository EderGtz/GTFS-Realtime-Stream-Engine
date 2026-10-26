/**
 * Display formatters shared across the frontend.
 *
 * FUTURE FIX: `escapeHtml` still uses the DOM (createTextNode/innerHTML
 * round-trip). A regex replacement table would make it usable in workers or
 * tests without jsdom, but the DOM version is battle-tested and identical in
 * behavior to what the panels shipped with, so it stays as-is.
 */

/**
 * Human-readable duration from seconds: "0s", "45s", "2m", "1m 30s".
 * Absolute value is formatted; callers that care about the sign (deviations
 * can be early) use formatSignedSeconds below.
 */
export function formatSeconds(s: number): string {
    if (s === 0) return '0s';
    const abs = Math.abs(s);
    if (abs < 60) return Math.round(abs) + 's';
    const min = Math.floor(abs / 60);
    const sec = Math.round(abs % 60);
    return sec > 0 ? min + 'm ' + sec + 's' : min + 'm';
}

/**
 * Signed variant used in chart tooltips: "+1m 30s" for late, "−1m 30s"
 * (U+2212 minus) for early.The sign must stay visible or early buses
 * look late.
 */
export function formatSignedSeconds(s: number): string {
    const sign = s > 0 ? '+' : (s < 0 ? '\u2212' : '');
    return sign + formatSeconds(s);
}

/** Trim the trailing '.0' from whole-number percentages ("82.5" / "82"). */
export function formatPct(v: number): string {
    return String(Math.round(v * 10) / 10);
}

/**
 * Age label for the data-freshness indicator: "just now", "45s", "1m 30s".
 */
export function formatAge(ms: number): string {
    if (ms < 1000) return 'just now';

    const totalSec = Math.floor(ms / 1000);

    if (totalSec < 60) return `${totalSec}s`;

    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;

    return `${min}m ${sec}s`;
}

/**
 * Escape a string for safe interpolation into HTML. Route names and error
 * messages come from the API/user and are inserted into innerHTML markup.
 *
 * NOTE: map-logic's marker popups still interpolate API values unescaped
 * (pre-existing behavior). FUTURE FIX: route every HTML builder in the
 * frontend through this function.
 */
export function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

/**
 * Traffic-light color for an on-time percentage (green ≥ 80%, orange ≥ 50%,
 * red below). Used by the route search panel and the history summary.
 */
export function pctColor(pct: number): string {
    if (pct >= 80) return '#27ae60';
    if (pct >= 50) return '#e67e22';
    return '#e74c3c';
}

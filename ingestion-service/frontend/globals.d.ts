/**
 * globals.d.ts — typings for the two libraries that map.html loads from CDN before the bundled module (`/dist/map.js`) runs.
 *
 * WHY CDN GLOBALS INSTEAD OF NPM RUNTIME: Leaflet and Chart.js already work
 * this way in production (unpkg <script> tags execute before the deferred
 * module script, so `L` and `Chart` exist when the bundle runs). This
 * migration keeps that runtime untouched and only adds TYPES for them.
 *
 * FUTURE FIX: for offline/CSP-strict hosting, import both from
 * npm and let esbuild bundle them (`import { Chart } from 'chart.js'` +
 * `chart.js/auto` for controller registration); the typings below would then
 * be deleted in favor of direct imports.
 */

// Type-only import which resolves to @types/leaflet.
import type * as Leaflet from 'leaflet';

declare global {
    /** Leaflet 1.9 global from https://unpkg.com/leaflet@1.9.4/dist/leaflet.js */
    const L: typeof Leaflet;

    /**
     * Chart.js 4 global from https://unpkg.com/chart.js@4.4.7/dist/chart.umd.js
     * The UMD global is the Chart class itself, not a namespace.
     */
    const Chart: typeof import('chart.js').Chart;
}

export {};

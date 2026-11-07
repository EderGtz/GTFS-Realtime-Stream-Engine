/**
 * Dead-man's-switch heartbeat
 *
 * Each successful poll cycle pings a Healthchecks.io-style endpoint. If the
 * pings STOP (process dead, container wedged, deploy gone wrong) the service
 * raises the alert — that is the whole point of a dead-man's switch: silence
 * is the alarm. When the poller is alive but the feed has failed for
 * ALERT_THRESHOLD consecutive cycles, `fail()` hits the `/fail` endpoint so
 * the alert arrives immediately instead of waiting for the process to die.
 *
 * Both calls are fire-and-forget and swallow every transport error: the
 * heartbeat must never be able to break the polling loop it watches.
 *
 * The data-level alerts (matched-ping ratio, deviation volume) live in the
 * analytics engine (alerting.py) — on Nov 1-2 2026 the poller stayed healthy
 * while the matching stage silently dropped nearly everything, so a
 * poller-only heartbeat would have been green the whole time. This heartbeat
 * is kept because it is cheap and it is the right tool for "the process
 * stopped pinging".
 */
import { logger } from './logger.js';

export interface Healthcheck {
    /** Report a successful poll cycle (the heartbeat itself). */
    ok(): void;
    /** Report a failure NOW instead of waiting for pings to stop. */
    fail(): void;
}

export type HealthcheckTransport = (url: string) => Promise<void>;

const PING_TIMEOUT_MS = 5_000;

async function defaultTransport(url: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
        await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Build a Healthcheck for a Healthchecks.io ping URL. Empty/absent URL
 * disables the heartbeat (local runs without a check configured) — `ok()`/
 * `fail()` become no-ops rather than errors. An injectable transport keeps
 * the class testable without real HTTP.
 */
export function createHealthcheck(
    pingUrl: string | undefined | null,
    transport: HealthcheckTransport = defaultTransport,
): Healthcheck {
    // Trailing slashes would break the `<url>/fail` construction below.
    const url = pingUrl ? pingUrl.replace(/\/+$/, '') : null;

    async function ping(path: string): Promise<void> {
        if (!url) return;
        try {
            await transport(url + path);
        } catch (err) {
            logger.warn({ err, target: url + path }, 'Healthcheck ping failed');
        }
    }

    return {
        ok(): void {
            void ping('');
        },
        fail(): void {
            void ping('/fail');
        },
    };
}

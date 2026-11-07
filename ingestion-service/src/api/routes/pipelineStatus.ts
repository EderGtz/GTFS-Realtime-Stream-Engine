import { Router } from 'express';
import type { ApiCollections } from '../../db/connection.js';
import type { PipelineStatusResponse } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * GET /v1/pipeline/status
 *
 * Answers "how would you know if it broke?" in one curl: last message age,
 * Kafka consumer lag, last GTFS-static reload, the   ping-matching counters,
 * and any data-level alerts currently firing.
 *
 * Data source: the single `pipeline_status` document the analytics engine
 * upserts every processing window (analytics-engine db/writer.py). The API
 * stays a read-only projection over MongoDB — no extra infrastructure paths.
 * Staleness is a first-class signal: `status_age_seconds` shows when the
 * analytics engine last reported, so a stopped consumer is visible as a doc
 * that stopped moving (and the analytics Healthchecks.io ping goes silent).
 *
 * 503 when no document exists yet: "the analytics engine has never reported"
 * is an unavailable pipeline, and the response says exactly that.
 */
export function createPipelineStatusRouter(collections: ApiCollections): Router {
    const router = Router();

    router.get('/pipeline/status', async (_req, res, next) => {
        try {
            const doc = await collections.pipelineStatus.findOne(
                { _id: 'pipeline_status' },
                { projection: { _id: 0 } },
            );
            if (!doc) {
                res.status(503).json({
                    error: 'No pipeline status reported yet — the analytics engine has not written the pipeline_status document.',
                });
                return;
            }

            const now = Date.now();
            const toIso = (value: unknown): string | null =>
                value ? new Date(value as string | Date).toISOString() : null;
            const ageSeconds = (value: unknown): number | null => {
                const ts = value ? new Date(value as string | Date).getTime() : NaN;
                return Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / 1000)) : null;
            };

            const response: PipelineStatusResponse = {
                generated_at: new Date(now).toISOString(),
                reported_at: new Date(doc['reported_at'] as string | Date).toISOString(),
                status_age_seconds: ageSeconds(doc['reported_at']),
                last_message_at: toIso(doc['last_message_at']),
                last_message_age_seconds: ageSeconds(doc['last_message_at']),
                consumer_lag_messages: (doc['consumer_lag_messages'] as number | null) ?? null,
                last_static_reload_at: toIso(doc['last_static_reload_at']),
                static_bundle_version: (doc['static_bundle_version'] as string | null) ?? null,
                window_total_records: (doc['window_total_records'] as number) ?? 0,
                matching: (doc['matching'] as PipelineStatusResponse['matching']) ?? null,
                alerts: (doc['alerts'] as string[]) ?? [],
            };

            logger.info(
                { status_age_seconds: response.status_age_seconds, alerts: response.alerts.length },
                'GET /v1/pipeline/status served',
            );
            res.json(response);
        } catch (err) {
            next(err);
        }
    });

    return router;
}

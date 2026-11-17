# MongoDB did not survive reboot: crash-loop cascade

**Date:** 2026-10-05 (after the 05:16 UTC reboot) · **Severity:** SEV1 · **Status:** fixed
**Components:** `docker-compose.yml` (mongodb), `gtfs_api`, `gtfs_analytics`

## Summary

After a routine server reboot the whole stack came back up except MongoDB, and
the two services that depend on it crash-looped (31 and 26 restarts in about
20 min).

## Timeline

- **05:14**: MongoDB shuts down cleanly for the reboot.
- **05:16**: the host boots; every `gtfs_*` container with
  `restart: unless-stopped` comes back except MongoDB.
- **05:20 to 05:40**: `gtfs_api` and `gtfs_analytics` retry Mongo 5 times,
  exit (`ConnectionError: Could not connect to MongoDB after 5 attempts`),
  get restarted by Docker, and repeat: 31 and 26 restarts respectively.
- **23:37**: the restart storm is reported; root cause found and fixed within
  the session.

## Evidence

- `docker ps` after boot: `gtfs_mongodb` absent, the other containers
  restarting in a loop.
- Analytics log: `ConnectionError: Could not connect to MongoDB after 5
  attempts`.
- Docker restart counts: 31 (api) and 26 (analytics) in about 20 min.

## Root cause

MongoDB was the only compose service without `restart: unless-stopped`. The
retry-then-exit connection strategy is fine if the dependency also restarts;
with Mongo down forever, the retries just paced the crash loop.

## Fix

Added `restart: unless-stopped` to the mongodb service and recreated the
container (data volume untouched). Later committed upstream.

## Alert that would have caught it

The daily ops report's container section (status/restarts vs baselines) and
any liveness check on port 3000 would have flagged the restart storm within
the morning report. In alerting terms today, the data-quality check goes
silent when analytics dies and its own dead-man mode alerts on missing pings.
A post-boot verification step ("after any boot, all 8 `gtfs_*` containers Up")
remains a manual checklist item.

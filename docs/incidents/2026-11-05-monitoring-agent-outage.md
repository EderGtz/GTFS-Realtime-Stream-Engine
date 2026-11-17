# Monitoring agent outage: daily health report failed, requests unprocessed

**Dates:** 2026-11-05 to 2026-11-07 · **Severity:** SEV2 (monitoring blind) · **Status:** fixed (agent reinstalled 2026-11-07)
**Components:** monitoring agent (Hermes), daily health-report cron

## Summary

The monitoring agent's own plumbing failed for two days: the daily server
health report did not run on Nov 5 (missing provider credential) and on Nov 6
the model service refused every message, including an incoming deploy request
that was never executed. Resolved by a clean reinstall on Nov 7.

## Timeline

- **2026-11-05 08:00**: the daily cron fails with
  `provider credential missing: No access token found for Nous Portal login`.
  No report is delivered.
- **2026-11-06**: every message fails with "could not connect to the AI model
  service"; login and heartbeat checks report inconsistent state. A queued
  deploy task (git pull + compose up + monitoring env vars) is never
  processed.
- **2026-11-07**: the agent is wiped and reinstalled (v0.23.0); state is
  restored from an off-host backup; the blocked task is executed the same
  day (pull `3314f40` to `df83387`, deploy with `--build`, `HEALTHCHECKS_*`
  env vars wired into the root and per-service `.env` files); the daily report
  cron is recreated and verified with a test run.

## Evidence

- The cron run log for 2026-11-05 shows the credential error above and no
  delivery.
- The session log for 2026-11-06 shows repeated model-service connection
  failures on every message.

## Root cause

Agent state corruption: the provider access token was lost. Environment-level,
not the GTFS stack. Two days of monitoring silence went unnoticed until the
reports themselves stopped arriving.

## Fix

Reinstall plus restore from backup, then recreate the 08:00 UTC health-report
cron. The unprocessed task was completed manually after recovery.

## Alert that would have caught it

A dead-man switch on the monitor itself: if no daily report is produced by
08:15 UTC, an external ping should go DOWN. Also, treat "daily report
missing" as an incident trigger, since it is the one system that watches
everything else.

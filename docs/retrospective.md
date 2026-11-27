# Retrospective: GTFS Realtime Stream Engine

*Closing notes, 2026-11-24. 60 days in production, 19 incident postmortems,
5 SEV1s, one €4.49/month server.*

## What this was

An event-driven pipeline that ingests raw MBTA GTFS-Realtime (binary
Protobuf), decouples ingestion from processing with Kafka, computes its own
schedule-deviation and bunching metrics in Python, persists to MongoDB +
PostgreSQL, and serves a REST API plus a Leaflet map. Six layers, all custom
code except the broker and the databases. It ran for 60 days on a single
Hetzner CX23, ingesting ~2.7M vehicle pings per day — roughly 160M over the
full run (94.2M+ preserved verbatim in the archive; the ≈ covers the weeks
before the archive tier existed, since the Kafka topic itself was rebuilt
once mid-run).

The project closed with every incident fixed and every open item resolved.
These are the things worth remembering.

## What I learned

**Silent failure is the default mode.** Every SEV1 was silent: no crash, no
stack trace, no red process — just numbers that were quietly wrong or
missing. A pipeline can be "up" and produce 10% of its output for six days.
The fix is always the same shape: alert on *data properties* (volume vs last
week, matched-ping ratio, oldest record age), not on process liveness.

**Green healthchecks lie.** A container can pass its probe while doing
nothing useful. The archive consumer passed `docker` healthchecks for four
days while writing zero lines. What actually detects a working pipeline is a
dead-man's switch on the *work* — one ping per successful cycle — so silence
itself is the alarm.

**Time is not datetimes; transit time is worse.** Storing UTC timestamps was
not enough. The killer bug was a service-day schedule anchored at midnight
via `midnight + timedelta`: on the 25-hour DST day every scheduled time
resolved an hour early, the 30-minute acceptance gate rejected real
observations, and a whole service day produced near-zero output with poisoned
survivors. Transit runs on service days in agency-local time; anything that
compares "scheduled vs actual" must anchor in that frame.

**Hardening has blast radius.** `cap_drop: [ALL]` looked like pure win and
silently broke raw-file deletion: root without `CAP_DAC_OVERRIDE` cannot
unlink files owned by another uid, and the daily prune failed with
`PermissionError` for five days while compaction kept working fine. Security
changes need the same regression coverage as feature changes — especially the
delete path, which nothing exercises in tests.

**Capacity is a policy, not a number.** Four individually "bounded"
accumulators — Docker build cache, Kafka segments, an unbounded Mongo
collection, and the Parquet archive — took a 38 GB disk to 90% twice. Each
one had a reason to grow and none had a policy to stop. Retention, TTLs and
log rotation are part of the write path, not later chores. This is the class
of problem that only shows up after weeks of uptime, which is exactly when
nobody is watching.

**Postmortem discipline pays at the end, not just at the time.** Writing one
file per incident — timeline, evidence, root cause, fix, the alert that would
have caught it — turned "is this project done?" into a checklist. Closing the
project meant closing 19 documents, and every claim in the README traces to a
query I actually ran.

## The three incidents worth retelling

### 1. Six days of silent data loss — the DST bug (SEV1)

**What happened:** from Oct 13, and worst on Nov 1 (the fall-back day),
`route_hourly_stats` under-reported roughly 59,000 vehicle-hour observations
across six damaged days. Nothing crashed. The raw telemetry stream stayed
perfectly healthy the whole time — only the *computed* layer was wrong.

**Root cause:** two independent bugs that looked like one. (a) An
active-service filter built only when the GTFS static bundle changed drifted
out of sync with the live service day, draining days down to ~10% of their
routes. (b) Schedule times were anchored at `midnight + timedelta`; on the
25-hour day, everything after the fall-back instant resolved one hour early
and the ±30-minute acceptance gate rejected the real observations. On Nov 1
both were live at once — on-time % for the surviving rows read 0–3%.

**How it surfaced:** a weekly volume comparison, not a crash — the data
looked plausible in any single glance. The fix was anchoring scheduled times
in the service-day frame and rebuilding the active-service window per window,
plus a regression test for the 25-hour day.

*Interview version: the bug that taught me "healthy" and "correct" are
different monitors. We lost a week of published statistics with every process
green; the detector that finally worked was comparing this hour's volume to
the same hour last week.*

### 2. Four days of nothing, with a green healthcheck — the zombie consumer (SEV1)

**What happened:** a Kafka `Not Coordinator For Group` error wedged the Go
archive consumer into a zombie: the container stayed "healthy" while writing
zero lines for 5,720 minutes — four days. Postgres history stopped in the
same minute. Mongo kept receiving full volume (~335K docs/day), which is
precisely why no user-visible symptom appeared.

**Root cause:** one broker failure did two things at once — wedged the
consumer's group membership and wiped/recreated the topic. The consumer's
reconnect path looped without ever re-joining; the healthcheck only proved
the process was alive, not that it was consuming. Kafka's at-least-once
redelivery saved the data: after restart + backfill, only ~17 seconds of
messages were irrecoverable.

**How it surfaced:** a "lines per minute" stat I added while debugging
something else — an operational metric that happened to read zero.

*Interview version: the outage that changed how I build monitors. A
dead-man's switch — "ping me once per successful cycle, silence is the
alarm" — would have caught it in 90 seconds. We had a heartbeat on the
process; what we needed was a heartbeat on the work.*

### 3. Hardening broke deletion — `cap_drop` vs file ownership (SEV2)

**What happened:** the security hardening release (`cap_drop: [ALL]`,
read-only rootfs) shipped on Nov 8. From Nov 9, every daily prune logged
`PermissionError` and skipped five days of raw files; the disk climbed from
80% to 90% in five days. Compaction itself kept working, so the failure was
quiet — only the delete step was wedged.

**Root cause:** the compactor ran as root and deleted archiver-owned files
( uid 10001) via `CAP_DAC_OVERRIDE`. Dropping all capabilities removed
exactly the capability that made that possible. Deleting a file needs write
permission on the *directory*; root without `DAC_OVERRIDE` is just another
user against a 755 dir it doesn't own. Nothing tested the delete path against
foreign-owned files after the change.

**Fix:** run the compactor as the same uid that writes the archive. No
capability needed — owner permissions cover deletion and writes. Verified
live: the six stalled days deleted cleanly on the next pass.

*Interview version: security work has a blast radius like any other change.
The lesson I carry is to ask "what does this change make impossible?" — and
to make sure the paths that delete things are part of the test matrix, because
deletion failures are silent until a disk fills.*

## What I'd do differently

- **Data-level alerting from day one.** The dead-man's switch on the poller
  was the first thing built; the data checks (matched-ping ratio, hourly
  volume vs last week) only arrived after the Nov 1 incident. A monitor on
  the *output* is the one that catches silent data loss; a monitor on the
  *process* catches almost nothing interesting.
- **Lifecycle policies as part of every write path.** Mongo TTL indexes,
  Parquet retention, Docker log rotation — all three were retrofitted after
  disk incidents. If a path writes data, it should ship with its own deletion
  policy in the same PR.
- **A daily ops report with projections, not just readings.** "Disk at 84%"
  is a number; "at +100 MB/day, 3.5 weeks of headroom" is a decision. The
  daily report existed but trend lines and projections came late.
- **Test against the real feed's worst calendar day.** The DST regression
  test exists now and is one of the most valuable files in the repo. Service
  days, 23/25-hour days and midnight rollovers should be fixtures from the
  start of anything transit- or schedule-shaped.
- **Budget disk like it's the scarce resource it is.** 38 GB sounded like a
  lot for "some logs and JSON". Every GB should map to a named producer with
  a named policy. (Also: `docker builder prune` is not optional when you
  deploy with `--build`.)
- **Keep the postmortem habit.** Two paragraphs and a timeline is enough.
  The compounding value shows up months later — in this case, when it was
  time to prove the project was finished.

## Numbers worth quoting

| Claim | Number | Source |
|---|---|---|
| Days in production | 60 (2026-09-25 → 2026-11-24) | deploy date + close date |
| Pings per day (sustained) | ~2.7M | compactor daily counts |
| Pings archived verbatim | 94,214,901 (2026-10-20 → close) | Parquet rows + NDJSON lines |
| Pings through Kafka since topic rebuild | 78,935,728 | broker log-end offsets (2026-10-26 → close) |
| Matched arrival observations | 570,919 over 135,583 route-hours | `route_hourly_stats` |
| Incident postmortems | 19 (5 × SEV1) | `docs/incidents/` |
| Last hands-on fix | 2026-11-13 | raw-pruning incident |
| Unattended at the end | 11 days untouched | same |
| Cost | €4.49/mo | Hetzner CX23 |

The ~160M lifetime figure is an extrapolation (~2.7M/day × 60 days) and I
label it as one: the exact count is unrecoverable because the Kafka topic was
rebuilt once (2026-10-26) and the archive tier shipped on day 26 of the run.
Knowing which numbers are exact and which are estimates is part of the story.

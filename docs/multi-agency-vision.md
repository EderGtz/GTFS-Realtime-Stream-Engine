# Multi-Agency: What It Would Take, and Why It Is Not Built

## Status and Decision

This project ingests exactly one feed: MBTA's GTFS-Realtime
`VehiclePositions`. Supporting more agencies is deliberately not being
built. This document records what I know about what multi-agency
support would require, what I know I don't know, and the specific
conditions that would make it worth building.

The short version: the *transport* layers (poll, decode, Kafka, archive)
are close to agency-agnostic. The *analytics* layer is not. It contains
single-agency assumptions about time, identity, cadence, and schedule
semantics that are invisible with one feed and become correctness bugs
with two. Those assumptions are listed below with file references, so
each claim can be checked against the code.

An earlier version of this document described the change as "add an
`agency_id` field and a connector config; analytics needs no structural
changes." That was wrong, and the sections below explain why.

---

## What Is Already Agency-Aware

Not much, on purpose, but the one cheap thing was done early:

- **Every Kafka message carries `agency_id`.**
  `ingestion-service/src/ingestion/producer.ts:84` sets it to the
  literal `"mbta"`. The archive keeps it verbatim, so the Parquet tier
  already has the column, and historical data will not need a backfill
  once a second agency exists.

Everything else that touches agency identity is implicit.

---

## Hidden Single-Agency Assumptions

Ordered by how badly each would break with a second feed.

### 1. Timezone and service day (the hard part)

- `analytics-engine/src/metrics/schedule_deviation.py:41` hardcodes
  `AGENCY_TZ = "America/New_York"`.
- A derived column named `timestamp_eastern` threads through
  `consumer.py`, `metrics/bunching.py`, and `metrics/schedule_deviation.py`.
  The name itself encodes the assumption.
- GTFS schedule times are offsets from "noon minus 12h" of the service
  day in the agency's timezone, and can exceed `24:00:00`. Resolving a
  scheduled time to an absolute instant (`resolve_scheduled_datetime`,
  nearest-anchor across previous/same/next day) is only correct if the
  anchor day is computed in the agency's own timezone.
- `gtfs_static/loader.py:217` computes "today" for the active-service
  filter as `datetime.now(tz=UTC).date()`, not in the agency's timezone.
  The ±1 day margin hides this for a single US-Eastern agency; it is
  still the wrong reference frame.

**What multi-agency requires:** timezone becomes per-agency
configuration (or is read from `agency.txt`'s `agency_timezone`) and is
passed explicitly into every function that converts between instants and
service days. `timestamp_eastern` becomes `timestamp_local`, computed
per row from that agency's zone. A Central-time agency (CTA) is the
cheapest realistic test case: one hour off is enough to shift every
past-midnight trip onto the wrong anchor day.

### 2. Identifier namespacing

GTFS identifiers are only unique **within one feed**. Route `"28"`,
trip `"1001"`, stop `"1"`, and vehicle `"1234"` exist in many cities.

Places where a collision would silently merge two agencies' data:

| Location | Current key | Effect of a collision |
|---|---|---|
| Kafka message key, `producer.ts:82` | `vehicle_id` | Two vehicles share a partition. Ordering per key still holds, so this alone is harmless |
| Analytics grouping (arrival collapsing, bunching pairs, trackers) | `vehicle_id`, `trip_id`, `route_id` | Pings from two different vehicles are treated as one vehicle's track. Corrupt deviations and phantom bunching |
| Mongo natural key `deviation_natural_key`, `db/writer.py` `_ensure_indexes` | `(vehicle_id, trip_id, stop_sequence, kind)` | Upserts from one agency overwrite the other's documents |
| Mongo natural key `bunching_natural_key`, same file | `(route_id, direction_id, vehicle_a, vehicle_b, start_time)` | Same |
| Postgres PK, `db/pg_schema.py:26` | `(route_id, hour)` | Hourly stats for route `"28"` in two cities are merged into one row |
| API route-id validation, `routePerformance.ts:55`, `routeHistory.ts:26` | `^[A-Za-z0-9-]+$` | Valid IDs from other feeds (underscores, dots, spaces) are rejected |
| GTFS-static lookups in `loader.py` | `trip_id`, `stop_id`, `route_id` dict keys | One agency's static data overwrites the other's |

**What multi-agency requires:** `agency_id` as the leading component
of every natural key, unique index, primary key, and in-memory lookup
key, not only as a filter prefix on read indexes. The Kafka key becomes
`agency_id:vehicle_id`. Schema migrations are needed for both Mongo
(drop and recreate the unique indexes) and Postgres (new PK).

### 3. Feed cadence coupling

- `metrics/bunching.py:35` sets `POLL_INTERVAL_SECONDS = 15`, with a
  comment that it must match `BASE_INTERVAL_MS` in `poller.ts`.
- Time buckets are `floor(POLL_INTERVAL_SECONDS)`, and consecutiveness
  in `detect_bunching_events` requires the bucket difference to be
  *exactly* one interval.
- `consumer.py:105` derives `OVERLAP_SECONDS` from the same constant.

MBTA's real cadence already has about 16 s median jitter against the
nominal 15 s (documented in Known Limitations). An agency that refreshes
every 30 or 60 s would produce zero bunching events with no error.

**What multi-agency requires:** cadence as per-agency configuration,
ideally *measured* from the archive (median delta between consecutive
pings of the same vehicle) rather than declared, and consecutiveness
tested with a tolerance (for example ≤ 1.5 × cadence) instead of
equality.

### 4. Empirical thresholds are MBTA-specific

`DISTANCE_THRESHOLD_METERS = 100` and `MIN_CONSECUTIVE_OBSERVATIONS = 2`
(`bunching.py:36-37`) come from notebook 04's sensitivity sweep on
MBTA data. The methodology transfers, but the numbers do not: vehicle
length, street geometry, GPS noise, and service frequency all differ by
agency.

The detector also has a known false-positive source that is
agency-independent but geometry-dependent: `find_close_pairs`
(`bunching.py:70`) pairs any two same-route, same-direction vehicles
within the threshold using straight-line distance, with no exclusion for
terminals, layover points, or depots. Vehicles staged together at a
terminal count as bunched. The fraction of events this affects depends
on each agency's terminal layout, so it has to be measured per agency.
The fix is to exclude pairs near the first/last stop of the trip or with
near-zero speed for several observations, and ideally to measure
separation along `shapes.txt` instead of straight-line distance.

Two options for thresholds, not yet decided:

- **Per-agency calibration:** turn notebooks 01–04 into one
  parameterized onboarding notebook (e.g. run with `papermill -p
  agency_id ...`) over one to two weeks of archived data, and have a
  human approve the resulting thresholds.
- **A relative definition** that needs no calibration: a pair is bunched
  when the observed headway is below a fixed fraction (commonly 25 %) of
  the scheduled headway. This requires headway computation, which the
  engine does not do today.

Thresholds should **not** be recalibrated continuously from live data:
a route that is always bunched would raise its own baseline and stop
being flagged, and historical numbers would stop being comparable.

### 5. Schedule semantics

Schedule deviation assumes:

- **timetable-based service** (exact `stop_times`), and
- feeds that populate `stop_id`, `current_stop_sequence`, and
  `current_status = STOPPED_AT`, plus a `trip_id` that matches the
  static bundle.

MBTA bus satisfies all of this. Many agencies don't. For
frequency-based service (`frequencies.txt`, typical of BRT), deviation
from a nominal timetable is not a meaningful metric. The right metric is
headway regularity (excess wait time, headway coefficient of variation).
For feeds without stop fields, arrivals would have to be inferred by
projecting positions onto `shapes.txt`, which the engine does not load
today.

### 6. Static data lifecycle

- The source URL and on-disk directory are hardcoded:
  `gtfs_static/refresh.py:18` (`MBTA_GTFS_URL`) and `refresh.py:21` /
  `loader.py:39` (`data/MBTA_GTFS`).
- Change detection relies on the server returning an `ETag`. Without
  one, the full ZIP is downloaded on every check.
- `extractall` writes over the previous bundle's directory, so a file
  removed in a new version (e.g. `calendar_dates.txt`) would survive
  and contaminate the next load.
- Lookups are Python dicts of dataclasses (about one million
  `ScheduledStopTime` instances for MBTA). Memory scales linearly per
  agency, and reload builds the new lookups while the old ones are still
  resident, so peak memory roughly doubles during a refresh. Reload also
  runs inside the consume loop and blocks consumption while it runs.

**What multi-agency requires:** one static snapshot per agency, change
detection that falls back to `Last-Modified` or a content hash,
extraction to a temp directory followed by an atomic rename, a columnar
representation (NumPy arrays, or DuckDB/Parquet queried by `trip_id`),
and reload off the hot path.

### 7. Retention

The Mongo TTL indexes added in `db/writer.py` use a single global
14-day retention, already marked `FUTURE FIX: make retention per-agency
config`. It is listed here for completeness. It is the easiest item on
this list.

---

## Known Unknowns

These cannot be answered without a real second feed, which is why the
connector interface is not designed yet.

- **Encoding.** Most agencies serve GTFS-RT protobuf. Some serve JSON,
  and some extend the protobuf (MTA New York City Transit's subway feeds
  use custom `nyct` extensions). The decoder may need per-agency
  extension registration, not only a URL.
- **Authentication.** None, a static API key in a header or query
  string, or credentials that expire and must be refreshed. Each implies
  different secret handling and failure modes.
- **Timestamp semantics.** Whether `vehicle.timestamp` is populated and
  trustworthy, whether stale vehicles are left in the feed, and whether
  only the header timestamp moves between polls.
- **Field completeness.** What fraction of entities carry a `trip_id`
  that matches the static bundle, and whether `stop_id` and
  `current_status` are present at all.
- **Service model.** Timetable versus frequency-based, which decides
  whether schedule deviation is computed at all (see 5).
- **Static publishing.** Whether the static bundle has an `ETag`, how
  often it changes, whether one agency publishes several bundles, or one
  regional bundle covers several agencies (then `agency_id` inside the
  static data and the connector's `agency_id` are not the same thing).
- **Licensing.** Whether redistribution is allowed, which decides
  whether archived raw data can ever be published.
- **Feed availability.** Some candidates may not publish GTFS-RT at
  all. CTA's bus data, for example, is primarily exposed through its own
  Bus Tracker API; whether an official GTFS-RT endpoint exists needs to
  be confirmed before CTA is used as the second agency.

---

## Connector Sketch (Illustrative, Expected to Change)

This is a current guess at what a connector would need to declare. It
exists to make the assumptions above concrete, not to define an
interface. The actual shape should come from the first real second feed.

```yaml
# connectors/<agency>.yaml (illustrative)
agency_id: example-agency
timezone: America/Chicago          # or read from agency.txt
realtime:
  vehicle_positions_url: https://...
  format: gtfs-rt-protobuf         # unknown until a real feed is tested
  poll_seconds: 30                 # declared, then checked against measured cadence
auth:
  kind: none                       # none | header | query | refreshing (unknown)
static:
  url: https://.../gtfs.zip
service_model: timetable           # timetable | frequency
metrics:
  schedule_deviation: true
  bunching:
    distance_m: 100                # MBTA value; must be recalibrated per agency
    min_observations: 2
```

Loading model: files in `connectors/*.yaml`, read at startup, one poller
loop per connector, all publishing to the existing
`raw.vehicle-positions` topic with key `agency_id:vehicle_id`. A single
topic keeps consumers unchanged when an agency is added. Topic-per-agency
is only justified if one agency dominates volume or needs different
retention.

---

## What Would Need to be Validated First

1. **Capture a fixture from the candidate feed** (20 polls) and run it
   through the existing decoder and validator. Record field completeness
   and measured cadence.
2. **Replay the fixture plus that agency's static bundle through the
   analytics engine offline**, with `AGENCY_TZ` overridden. Measure the
   `trip_id` match rate against the static bundle and whether deviations
   look plausible.
3. **Fix the timezone and service-day handling (section 1) first.** It
   is the one change that is also a correctness improvement for the
   current single-agency deployment.
4. **Namespace keys (section 2)** with schema migrations and a contract
   test that loads two fixtures with overlapping IDs and asserts no
   cross-agency merge.
5. Only then introduce the connector loader.

---

## Access Control

There is currently nothing to protect: the API is read-only, the data
is public, and configuration lives in files on the server. Access
control is introduced only when there are write operations or
non-public data, and its shape depends on which of those actually
appears:

- **Per-consumer quotas** (different limits for a public dashboard and a
  partner integration) are an API-key problem: issue keys, rate-limit by
  key.
- **Operator actions** (if connectors ever move from files to a runtime
  API with create/update/delete) need operator authentication. For a
  single operator on one VPS, the proportionate option is an
  authenticating proxy in front of an admin path (e.g. an SSO gateway)
  rather than application-managed credentials.
- **Diagnostics** (consumer lag, per-agency ingestion rates) are served
  on a port bound to `127.0.0.1` and reached over SSH, the same way
  the MongoDB and Kafka ports are today. Note that Docker-published ports
  bypass UFW, so binding to localhost, not the firewall, is the effective
  control.

JWT is one candidate for user sessions if a multi-user admin surface
ever exists. It is not a decision.

A connector API that fetches operator-supplied URLs also introduces an
SSRF surface (requests to `localhost`, private ranges, or cloud metadata
endpoints). Any such endpoint must enforce `https` only, reject private
and link-local addresses after DNS resolution and after redirects, and
cap download size, extraction size, and time.

---

## When This Becomes Worth Building

1. **There is a second real feed with a reason to exist.** Not a
   hypothetical: a working GTFS-RT endpoint, validated as described
   above, and someone who would use the combined output.
2. **The memory budget allows it.** The analytics engine's static
   lookups already take most of the 4 GB VPS. Either the columnar
   representation (section 6) lands first, or the server is resized.
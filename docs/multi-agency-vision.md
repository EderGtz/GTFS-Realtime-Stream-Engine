# Multi-Agency Vision: From MBTA to a Transit Data Platform

## The Core Idea

The current system processes one feed: MBTA's GTFS-Realtime vehicle
positions. The architecture (poll, decode, stream through Kafka,
compute metrics, serve via API) is feed-agnostic by design. The
ingestion service's poller and decoder are the only two files that know
about MBTA specifically. Everything downstream (Kafka topics, analytics
engine, MongoDB collections, API) works with a generic vehicle position
document.

The natural next step is to support multiple transit agencies. Not by
rewriting the pipeline, but by adding a **connector layer**, which would
be a configurable adapter that knows how to poll a specific agency's
GTFS-Realtime feed and normalize it into the same document shape the
pipeline already expects.

## What This Connector Would Look Like

Each connector is a configuration:

```yaml
# Example: connector config for CTA (Chicago)
agency_id: "cta"
feed_url: "https://www.transitchicago.com/track/bustracker.cta.gtfsrt"
feed_format: "gtfs-realtime"        # protobuf, same as MBTA
static_url: "https://www.transitchicago.com/files/gtfs/google_transit.zip"
poll_interval_seconds: 15
auth_header: null                    # some agencies require API keys
```

The ingestion service would load a directory of connector configs
(`connectors/*.yaml`) and run one poller per agency, all publishing to
the same `raw.vehicle-positions` Kafka topic. The `agency_id` field
becomes a first-class field in every document flowing through the
pipeline — in Kafka messages, in MongoDB documents, in API responses.

## What Changes in the Architecture

```
                    ┌── connector: MBTA ──┐
                    ├── connector: CTA ───┤
                    ├── connector: SEPTA ─┤  (ingestion-service)
                    └── connector: ... ───┘
                              │
                    Kafka: raw.vehicle-positions
                              │
                    ┌─────────┴──────────┐
                    │  analytics-engine  │  (unchanged — already
                    │  partitions by     │   works per-vehicle,
                    │  agency_id + route │   agency_id is just
                    │                    │   another field)
                    └─────────┬──────────┘
                              │
                         MongoDB
                    (documents carry agency_id)
                              │
                           API layer
                    (endpoints accept ?agency=cta filter)
```

**Ingestion service:** the poller becomes a multi-poller. One Kafka
producer, multiple poller loops (one per connector). The document shape
gains an `agency_id` field. The Protobuf decoder is shared — GTFS-RT is
a standard format, though some agencies wrap it differently (JSON vs
protobuf, custom fields). The decoder needs a thin per-agency adapter
layer, but the core decode/validate/publish path stays the same.

**Analytics engine:** no structural changes. The consumer already
processes documents one at a time. Adding `agency_id` to the group key
for deviation and bunching computation is a small change. The GTFS-static
loader needs to handle multiple agencies' schedule files (one per
connector), but the loading logic is the same.

**MongoDB:** documents gain `agency_id` as a field. Indexes add
`agency_id` as a prefix. The existing collections
(`schedule_deviations`, `bunching_events`) work for all agencies — the
`agency_id` field partitions the data logically.

**API:** endpoints gain an optional `?agency=` query parameter. Without
it, they return data across all agencies. With it, they filter to one.
The map could show a dropdown to switch between agencies or display all
at once.

## JWT

With a single agency (MBTA), there's nothing to protect. The data is
public, there are no write operations, and there's one pipeline with no
configuration to manage.

With multiple agencies, there are operations that need access control:

- **Registering a new connector** (adding a new agency) would require
  understanding the feed format, validating the config, and restarting
  the ingestion service. This is an admin operation.
- **Modifying poll intervals or thresholds** — an admin might want to
  change how often a feed is polled or adjust bunching sensitivity per
  agency.
- **Viewing operational diagnostics** — per-agency ingestion rates,
  error rates, Kafka lag. Useful for operators, not necessarily for
  public consumption.
- **Rate limiting by consumer** — different API consumers (a public
  dashboard vs an internal tool) might get different rate limits.

JWT with two roles (`reader` and `admin`) would cover this cleanly:

| Role    | Can do                                               |
|---------|------------------------------------------------------|
| reader  | All current endpoints (map, status, performance)     |
| admin   | + connector CRUD, diagnostics, config changes        |

Public users keep the current experience — no auth needed for the map
or the live status endpoints. Admins get a token that unlocks
management operations.


This connector layer will become worth building when:

1. **The current pipeline is stable and the roadmap is done.** 

2. **There's a second real agency to integrate.** Not hypothetical — an
   actual second GTFS-RT feed that works. SEPTA (Philadelphia), CTA
   (Chicago), or MTA (New York) are good candidates. MBTA was chosen
   because it's well-documented and has a clean public API. Other
   agencies are messier (missing fields, different feed formats, API
   keys required). The connector layer should be shaped by real
   problems, not anticipated ones.
# Whole-Fleet Map: Showing Every Vehicle, Not Just the Problems

## The Problem Today

The Leaflet map shows deviation markers and bunching events on a map of Boston. 
It works. But it has a visibility gap: only vehicles that produced a deviation 
(arrived/departed at a stop within the last 3 minutes) or are part of a bunching 
event appear on the map. Vehicles in transit between stops — the majority of the 
active fleet at any moment — are invisible.

This creates two concrete problems:

1. **Flickering.** Vehicles at the edge of the 3-minute live window
   disappear on one refresh and reappear on the next. The anti-flicker
   grace period (2 refreshes, client-side) mitigates this, but it's a
   patch over a deeper issue: the map only sees a subset of the fleet.

2. **Empty-looking map.** Boston's bus network runs ~500-1000 active
   vehicles at any time. The deviation-based map shows maybe 50-100
   markers. The map looks sparse — more like a problem dashboard than a
   live transit view. A visitor's first reaction is "is this thing on?"

A transit operations map should show where every vehicle is, with the
analytics layer on top for the ones that are interesting. Today it only
shows the interesting ones.

---

## The Idea

One map, one endpoint, two visual layers:

**Layer 1 — All active vehicles (grey dots).** Every vehicle reported by
the GTFS-RT feed gets a small, neutral grey circle on the map. This
answers the basic question: "where are the buses right now?"

**Layer 2 — Analytics overlay (colored markers).** Vehicles with computed
deviations get sized and colored circles that encode severity. Bunched
vehicle pairs get connected by lines. This layer is what the map already
does today — it just sits on top of the full fleet instead of being the
only thing visible.

The result: a map that looks alive (hundreds of dots moving across
Boston) with clear visual signals for the vehicles that matter (bigger,
colored markers for late/early vehicles, purple links for bunched pairs).

---

## Visual Encoding

### Layer 1: Normal vehicles (no deviation data)

| State           | Size    | Color  | Opacity |
|-----------------|---------|--------|---------|
| In transit      | 4px     | #bbb   | 0.5     |
| Stopped at stop | 5px     | #999   | 0.6     |

Small, grey, unobtrusive. They fill the map and make it feel alive
without competing with the analytics markers.

### Layer 2: Vehicles with deviation data (existing color scale)

| Deviation          | Size    | Color   | Opacity |
|--------------------|---------|---------|---------|
| Early (> 2 min)    | 8px     | #3498db | 0.85    |
| On time (±2 min)   | 8px     | #2ecc71 | 0.85    |
| Slightly late (2-5) | 10px   | #f1c40f | 0.85    |
| Late (5-10 min)    | 12px    | #e67e22 | 0.90    |
| Very late (>10)    | 14px    | #e74c3c | 0.95    |

Markers grow with severity. A very late bus is visually dominant — you
can't miss it. An on-time bus blends in with the grey fleet but is
still distinguishable by its green color.

### Bunching events (existing)

Purple markers + dashed connecting line. No change from today — these
already work well.

---

## Architecture: How to Get All Vehicle Positions

### What exists today

```
Kafka: raw.vehicle-positions
        │
        ▼
  analytics-engine (Python)
  consumer.py, WINDOW_SECONDS=60
        │
        ▼  (only vehicles at stops with deviation data)
  MongoDB: schedule_deviations, bunching_events
        │
        ▼
  GET /v1/status/live → map.js
```

The raw vehicle positions flow through Kafka in `raw.vehicle-positions`.
The analytics engine consumes them, but only the subset that produces
deviations (vehicles at stops) or bunching (close pairs) gets persisted.
Everything else is processed and discarded.

### What the whole-fleet map needs

There are two viable approaches. Both keep a single endpoint — the map
doesn't need to know where the data comes from.

#### Option A: MongoDB `live_positions` collection (simpler)

Add a lightweight consumer (or extend the existing analytics consumer)
that upserts every vehicle's latest position into a `live_positions`
collection with a TTL index:

```
Kafka: raw.vehicle-positions
        │
        ├──→ analytics-engine (existing, computes deviations/bunching)
        │
        └──→ live-position writer (new, lightweight)
              │
              ▼
        MongoDB: live_positions (TTL: 60s, one doc per vehicle_id)
```

The `live_positions` document shape:

```json
{
  "vehicle_id": "y3227",
  "route_id": "19",
  "trip_id": "39397972",
  "lat": 42.3295,
  "lon": -71.0831,
  "current_status": "IN_TRANSIT_TO",
  "timestamp": "2026-09-18T20:15:30Z"
}
```

- **Upsert on `vehicle_id`**: one document per vehicle, always current.
- **TTL index on `timestamp`**: MongoDB automatically removes vehicles
  that haven't reported in 60 seconds (they've gone off-duty or lost
  connectivity). No manual cleanup needed.
- **No GTFS-static dependency**: the live-position writer just stores
  what Kafka delivers. No pandas, no lookups, no windowing.

The API merges both sources:

```
GET /v1/status/live
  ├── read live_positions  → fleet[]     (all vehicles)
  ├── read schedule_deviations → delays[]  (existing)
  └── read bunching_events → bunching[]  (existing)

Response:
{
  "fleet": [
    { "vehicle_id": "y3227", "route_id": "19", "lat": 42.329, "lon": -71.083, "status": "IN_TRANSIT_TO" },
    ...
  ],
  "delays": [ ... ],      // existing
  "bunching": [ ... ],    // existing
  "meta": { ... }         // existing, extended with fleet_count
}
```

**Implementation effort:** 3-4 hours.
- New file: `analytics-engine/src/live_position_consumer.py` (or extend
  `consumer.py` with a second, simpler processing path)
- New file: `ingestion-service/src/api/routes/fleet.ts` (or extend
  `status.ts`)
- `types.ts`: add `FleetEntry` interface
- MongoDB index: `{ vehicle_id: 1 }` unique, `{ timestamp: 1 }` TTL
- `map.js`: draw grey dots from `fleet[]`, overlay existing markers

**Tradeoff:** Adds MongoDB write volume (~1000 upserts/minute for the
full fleet). But each upsert is tiny (one document per vehicle, same
document overwritten), and MongoDB handles this easily on the same
instance that already stores deviations and bunching.

#### Option B: In-memory state in the ingestion service (streaming)

The Phase 6 plan already proposes a `live-api-group` Kafka consumer in
the ingestion service (Step 3: Live State Consumer + SSE Endpoint). This
consumer maintains an in-memory `Map<vehicle_id, LatestState>` and
pushes updates via SSE.

The whole-fleet map could read from this in-memory state instead of
MongoDB:

```
GET /v1/status/live
  ├── read in-memory fleet state → fleet[]
  ├── read MongoDB → delays[], bunching[]
  └── merge and respond
```

**Tradeoff:** Lower latency and no extra MongoDB writes, but the
in-memory state lives only in the API server process. If the server
restarts, the fleet layer is empty until the next Kafka message arrives
for each vehicle (within ~15 seconds). For a dashboard this is
acceptable.

**Implementation effort:** 4-6 hours. This is essentially Phase 6,
Step 3 from the existing plan, which was already designed for this
purpose.

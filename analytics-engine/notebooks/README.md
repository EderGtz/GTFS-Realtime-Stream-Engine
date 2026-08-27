# Phase 3 Exploration: Data Quality, Rules, and Thresholds

This directory serves as the laboratory. The goal of these Jupyter Notebooks was to explore the real MBTA GTFS-Realtime telemetry, understand its quirks, and empirically derive the thresholds for our engine. These files were created in order to let the data dictate the rules and constants that are going to be used in the production code.

## The Notebooks

1. **`01_data_quality_and_frequency.ipynb`**: Analyzes the raw Kafka stream. Discovered the true poll cadence (~15s) and separated normal vehicle layovers from a massive 10-minute correlated infrastructure outage, establishing a mathematically sound **77-second threshold** for alerting on "silent/stale" vehicles.

2. **`02_stop_matching.ipynb`**: Validated that 99.5% of MBTA's pings include a native `stop_id`, and that the `current_stop_sequence` is >99.9% monotonic. This gave me solid information to trust the MBTA's native fields. A custom spatial-distance fallback algorithm was rejected as unnecessary overhead.

3. **`03_schedule_deviation.ipynb`**: Handled Eastern timezone conversions, solved the GTFS `25:30:00` midnight-crossing edge cases, and cleaned the data to find the true fleet delay (median: 73 seconds).

4. **`04_bunching.ipynb`**: Filtered pass-bys using `direction_id` and performed a multi-variable sensitivity sweep to find the exact spatial and temporal thresholds where vehicles are genuinely "bunched".

---

## Deep Dives & Hard-Won Lessons

During the exploration phase, several data behaviors initially seemed counter-intuitive. Documenting these challenges and their resolutions was the most valuable part of building this MVP.

### 1. The Mean Delay Paradox (Dwell-Time Spam)
In Notebook 03, the initial raw calculation showed an average fleet delay of just **58 seconds**. However, after "cleaning" the data by collapsing duplicate `STOPPED_AT` pings, the average delay actually increased to **179 seconds**, which was unexpected. 

Initially, it felt wrong that removing noise increased the delay. The breakthrough was understanding the physical reality of the telemetry: on-time vehicles spam the dataset.

* **On-time bus:** Arrives at 0s delay, rests for 2 minutes, generating **12 pings** of "0s delay".
* **Late bus:** Arrives 5 minutes late, rushes boarding in 10 seconds, generating **1 ping** of "300s delay".

The raw math was heavily biased by the on-time spam: 

$\frac{(12 \times 0\text{s}) + (1 \times 300\text{s})}{13\text{ total pings}} = 23\text{s average delay}$

By using pandas `.first()` to collapse sequential arrivals into a single event per stop, every vehicle gets exactly one vote: 

$\frac{0\text{s} + 300\text{s}}{2\text{ arrivals}} = 150\text{s average delay}$

The higher average represents the true statistical baseline of the fleet's gaps. This is actually a very low delay, especially considering that here in Merida, any given bus is usually delayed by at least 15 minutes. 

### 2. The "Islands and Gaps" Trick (Temporal Persistence)
In Notebook 04, we needed to know if two vehicles stayed bunched together for several consecutive polling cycles. Using traditional `for` loops to check chronological sequences across 13,000 pairs would be incredibly slow. 

Instead, I applied the **Islands and Gaps** technique using vectorization:
```python
# If pings are truly consecutive (every 15s), subtracting (rank * 15s) from 
# their timestamp will result in the exact same "base time" for the entire streak.
close['expected_if_consecutive'] = (
    close['time_bucket'] - pd.to_timedelta(close['bucket_rank'] * 15, unit='s')
)

```

Any gap in time mathematically shifts this "base time", instantly breaking the streak. Grouping by this base time allowed the algorithm to isolate continuous bunching events in milliseconds.

### 3. Operational Physics vs. Mathematical Volumetrics in the Sensitivity Sweep

When defining the thresholds for vehicle bunching, the sensitivity sweep matrix produced two distinct scenarios that yielded almost identical mathematical volumes:

* **Scenario A:** 100 meters for 2 consecutive pings $\rightarrow$ **71 events**
* **Scenario B:** 300 meters for 3 consecutive pings $\rightarrow$ **73 events**

If the math yields virtually the same number of alerts, which threshold is correct? The answer lies in physics and operational reality, not the spreadsheet: a standard city bus is roughly 13 meters long, and passenger perception dictates what actually constitutes "bunching":

1. **Scenario A (100 meters):** This distance is roughly equivalent to one city block. If two buses are within this range, a waiting passenger visually perceives them as arriving together (bunched). 

2. **Scenario B (300 meters):** This distance is nearly a third of a kilometer. Two buses spaced 300 meters apart on an avenue are still operating at a safe, functional distance. Alerting on Scenario B would flood the transit agency with false positives.

**Conclusion:** To ensure high data fidelity and operational relevance, the threshold was anchored to Scenario A: 100 meters and 2 consecutive pings (equivalent to a 30-second window).

### 4. Distance Calculation: Equirectangular Approximation vs. Haversine

To calculate spatial distances (e.g., verifying if a vehicle moved during a layover), the notebooks utilized a Pythagorean equirectangular approximation:

$\sqrt{\left((\text{lat}_1 - \text{lat}_2) \times 111\,320\right)^2 + \left((\text{lon}_1 - \text{lon}_2) \times 111\,320 \times \cos(\text{radians}(\text{lat}))\right)^2}$

For urban distances under a few kilometers, this flat-earth model yields virtually identical results to the formal Haversine formula:

$d = 2R \times \arcsin\left(\sqrt{\sin^2\left(\frac{\text{lat}_2 - \text{lat}_1}{2}\right) + \cos(\text{lat}_1) \times \cos(\text{lat}_2) \times \sin^2\left(\frac{\text{lon}_2 - \text{lon}_1}{2}\right)}\right)$

Since the error margin of the equirectangular method is negligible at this scale, it was selected to bypass the heavy trigonometric overhead of Haversine. Eliminating multiple sin, cos, and arcsin calls per row significantly reduces CPU cycles during large-scale spatial joins.

### 5. Schema Inference vs. Actual Data Types

Real-world data is inherently messy. During initial ingestion, DuckDB’s schema inference generated multiple Conversion Error exceptions. This occurred because DuckDB inferred identifiers like trip_id as integers based on initial rows, whereas subsequent records contained alfanumeric values.

For instance, the MBTA dataset includes custom alphanumeric trip IDs, such as `8pmChrisBrownUsher-847359-4763`, dynamically generated for special event services. To prevent these schema mismatches from breaking the ingestion pipeline, relevant GTFS identifiers were explicitly cast as VARCHAR during the load phase after a comprehensive review of the raw data.

---

## Final Production Rules

The exploratory work is complete. The Python production consumers (`analytics-engine/src/metrics/`) will implement the following strictly validated rules:

1. **Staleness:** A vehicle is officially missing/stale if no ping is received for **77 seconds**.
2. **Schedule Deviation:** `STOPPED_AT` is the golden signal. Consecutive pings must be collapsed to the first arrival to avoid dwell inflation. `stop_sequence == 1` must be ignored to prevent false early-arrival flags at origin terminals.
3. **Bunching:** Triggered exclusively when two vehicles share the same `route_id` and `direction_id`, are `<= 100 meters` apart, and persist for `>= 2` consecutive polling cycles.
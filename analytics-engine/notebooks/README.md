# Phase 3 Exploration: Data Quality, Rules, and Thresholds

This directory serves as the laboratory. The goal of these Jupyter Notebooks was to explore the real MBTA GTFS-Realtime telemetry, understand its quirks, and empirically derive the thresholds for our engine. These files were created in order to let the data dictate the rules and constants that are going to be used in the production code.

## The Notebooks

1. **`01_data_quality_and_frequency.ipynb`**: Answer "What does the telemetry actually do?". Analyzes the raw Kafka stream. Discovered the true poll cadence (~15s) and separated normal vehicle layovers from a massive 10-minute correlated infrastructure outage, establishing a mathematically sound **77-second threshold** for alerting on "silent/stale" vehicles.

2. **`02_stop_matching.ipynb`**: Answer "Can I trust the fields the agency gives me?". Validated that 99.5% of MBTA's pings include a native `stop_id`, and that the `current_stop_sequence` is >99.9% monotonic. This gave me solid information to trust the MBTA's native fields. A custom spatial-distance fallback algorithm was rejected as unnecessary overhead.

3. **`03_schedule_deviation.ipynb`**: Answer "What does the data-generation process do to my statistics?". Handled Eastern timezone conversions, solved the GTFS `25:30:00` midnight-crossing edge cases, and cleaned the data to find the true fleet delay (median: 73 seconds).

4. **`04_bunching.ipynb`**: Answer "What operational definition should my production system use?". Filtered pass-bys using `direction_id` and performed a multi-variable sensitivity sweep to find the exact spatial and temporal thresholds where vehicles are genuinely "bunched".

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
In Notebook 04, we needed to know if two vehicles stayed bunched together for several consecutive polling cycles. A naive implementation could iterate through each vehicle pair chronologically and manually check whether each observation is exactly one polling interval after the previous observation. While this would work for a dataset of this size, it introduces unnecessary Python-level iteration and makes the logic more complex.

Instead, it is used a vectorized Islands-and-Gaps approach. Within each vehicle pair, observations are ranked chronologically. For truly consecutive observations, subtracting rank × POLL_INTERVAL_SECONDS from the timestamp produces the same reference timestamp for the entire continuous run.

For example, with a 15-second polling interval:

10:00:00 - 1 × 15s = 09:59:45
10:00:15 - 2 × 15s = 09:59:45
10:00:30 - 3 × 15s = 09:59:45

All three observations therefore belong to the same continuous run.

If there is a gap:

10:00:00 - 1 × 15s = 09:59:45
10:00:30 - 2 × 15s = 10:00:00

The reference timestamp changes, which identifies a new run, which allows us to identify consecutive observations using pandas' vectorized groupby operations rather than explicitly iterating through individual records. The approach is both concise and naturally scalable as the number of vehicle pairs and observations grows.

```python
# If pings are truly consecutive (every 15s), subtracting (rank * 15s) from 
# their timestamp will result in the exact same "base time" for the entire streak.
close['expected_if_consecutive'] = (
    close['time_bucket'] - pd.to_timedelta(close['bucket_rank'] * 15, unit='s')
)

```

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

$d = \sqrt{\left((\text{lat}_1 - \text{lat}_2) \times 111\,320\right)^2 + \left((\text{lon}_1 - \text{lon}_2) \times 111\,320 \times \cos(\text{radians}(\text{lat}))\right)^2}$

For urban distances under a few kilometers, this flat-earth model yields virtually identical results to the formal Haversine formula:

$d = 2R \times \arcsin\left(\sqrt{\sin^2\left(\frac{\text{lat}_2 - \text{lat}_1}{2}\right) + \cos(\text{lat}_1) \times \cos(\text{lat}_2) \times \sin^2\left(\frac{\text{lon}_2 - \text{lon}_1}{2}\right)}\right)$

Since the error margin of the equirectangular method is negligible at this scale, it was selected to bypass the heavy trigonometric overhead of Haversine. Eliminating multiple sin, cos, and arcsin calls per row significantly reduces CPU cycles during large-scale spatial joins.

### 5. Schema Inference vs. Actual Data Types

Real-world data is inherently messy. During initial ingestion, DuckDB’s schema inference generated multiple Conversion Error exceptions. This occurred because DuckDB inferred identifiers like trip_id as integers based on initial rows, whereas subsequent records contained alfanumeric values.

For instance, the MBTA dataset includes custom alphanumeric trip IDs, such as `8pmChrisBrownUsher-847359-4763`, dynamically generated for special event services. To prevent these schema mismatches from breaking the ingestion pipeline, relevant GTFS identifiers were explicitly cast as VARCHAR during the load phase after a comprehensive review of the raw data.

¡Claro que sí! Esa historia de "El Misterio de los 13 Minutos" y cómo demostraste madurez técnica al dudar de los datos antes que del código, encaja perfectamente como el **punto número 6** en tu sección de *Deep Dives & Hard-Won Lessons*.

Como tu README está redactado en un inglés técnico impecable, te escribí esta nueva entrada en el mismo idioma y con el mismo tono analítico que ya vienes manejando. Puedes copiar y pegar esto directamente debajo del punto 5:

### 6. Data Provenance and the "13-Minute Anomaly"

During the bunching threshold analysis (exploratory/04_bunching_initial), an impossible physical pattern emerged: 99.4% of all same-route vehicle pairs across a 45-minute dataset were concentrated in a single 13-minute window. The remaining 32 minutes appeared virtually empty.

Before blaming the data, it was rigorously tested through multiple hypotheses:

* **Hypothesis 1 (Bucket-Flooring):** It was suspected that the 15-second time-bucketing was artificially splitting simultaneous pings. Replaced it with a true elapsed-time tolerance (`abs(date_diff) <= 15`). The query evaluated more pairs, but the 99% concentration remained.
* **Hypothesis 2 (Stale Pings / Feed Backlog):** It was suspected the MBTA API had stalled and later flushed a backlog of old pings. It was implemented a strict feed-latency filter (`ingested_at - timestamp_eastern <= 77s`) before the join to drop "ghost" buses. Only 152 pings were dropped. The anomaly persisted.

**The Breakthrough:** The smoking gun wasn't the mathematical logic, but the ingestion cadence. By grouping the raw pings by their `ingested_at` timestamps, It was discovered the 13-minute window contained 132 poll cycles (averaging one poll every ~5.9 seconds), while the remaining 32 minutes contained only 3 polls.

Because the `ingestion-service` is hard-coded to a strict 15-second minimum interval, a 5.9-second cadence was physically impossible for a single, steady production instance.

**The Root Cause & Decision:** Apache Kafka strictly decouples ingestion from analytics, persistently retaining all messages. Because thr Python consumer was configured with `auto.offset.reset=earliest`, it did not read a clean 45-minute slice of Boston traffic. Instead, it ingested the entire Kafka topic's development history—a Frankenstein dataset containing overlapping test scripts, frequent `npm run dev` restarts, and debugging bursts.

Instead of hacking the analytical algorithms to fit anomalies, the engineering decision was to discard the contaminated sample, purge the Kafka topic, and execute a clean, uninterrupted 60-minute capture to empirically lock in our final metrics.

---

## Final Production Rules

The exploratory work is complete. The Python production consumers (`analytics-engine/src/metrics/`) will implement the following strictly validated rules:

1. **Staleness:** A vehicle is officially missing/stale if no ping is received for **77 seconds**.
2. **Schedule Deviation:** `STOPPED_AT` is the golden signal. Consecutive pings must be collapsed to the first arrival to avoid dwell inflation. `stop_sequence == 1` must be ignored to prevent false early-arrival flags at origin terminals.
3. **Bunching:** Triggered exclusively when two vehicles share the same `route_id` and `direction_id`, are `<= 100 meters` apart, and persist for `>= 2` consecutive polling cycles.
# Phase 6: Production Deployment Runbook

**Status:** Running since 2026-09-25
**Stack:** Kafka (KRaft) + MongoDB + Ingestion Service + Analytics Engine + API

---

## Table of Contents

1. [Infrastructure](#1-infrastructure)
2. [Server Provisioning](#2-server-provisioning)
3. [Container Architecture](#3-container-architecture)
4. [Resource Limits](#4-resource-limits)
5. [docker-compose.yml](#5-docker-composeyml)
6. [Deployment](#6-deployment)
7. [Verification](#7-verification)
8. [Operations](#8-operations)
9. [Security](#9-security)
10. [Known Issues Encountered](#10-known-issues-encountered)
11. [Troubleshooting](#11-troubleshooting)
12. [Cost](#12-cost)

---

## 1. Infrastructure

### Hetzner CX23

Selected for its 4GB RAM, which comfortably accommodates the JVM heap
(Kafka), WiredTiger cache (MongoDB), pandas DataFrames (analytics
engine), and two Node.js processes without OOM risk. The 2 vCPUs handle
the concurrent Kafka consumer + analytics pipeline without contention.
At €4.49/month it undercuts comparable offerings from DigitalOcean
($6/mo for 1GB) and Linode ($5/mo for 1GB).

### Ubuntu 24.04 LTS

Chosen for broadest package compatibility and long-term support. The
Docker installation uses Docker's official APT repository, not Ubuntu's
snap package, to avoid the snap-specific quirks with Docker Compose.

### No domain, no TLS

The API serves public transit data with no authentication or PII. A
bare IP over HTTP is sufficient for a demo. Adding TLS
requires a domain, nginx as a reverse proxy, and certbot
for Let's Encrypt. It is deferred to a future iteration if the "Not Secure"
browser badge becomes a concern.

---

## 2. Server Provisioning

### SSH access

```bash
# Generate ed25519 key pair
ssh-keygen -t ed25519 -C "example@example.com"

# Add public key to Hetzner during server creation
cat ~/.ssh/id_ed25519.pub
```

### Non-root user

```bash
# As root on first SSH:
apt update && apt upgrade -y
adduser deployer
usermod -aG sudo deployer
rsync --archive --chown=deployer:deployer ~/.ssh /home/deployer

# All subsequent commands run as deployer
```

### Docker + Docker Compose

```bash
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deployer
exit   # re-login for group change
```

### Enable Docker on boot

```bash
sudo systemctl enable docker
```

---

## 3. Container Architecture

### Multi-stage builds

Both Node.js services use two-stage builds: a `builder` stage (full
`npm ci` + `tsc` compilation) and a `runtime` stage (`npm ci --omit=dev`
+ compiled output only). This keeps devDependencies (typescript, vitest,
protobufjs-cli) out of the production image.

### Proto code generation in Docker

The `src/generated/` directory is gitignored. The builder stage runs
`npm run generate:types` to produce the protobuf JS bindings from the
committed `.proto` file, then `npm run build` to compile TypeScript.
Non-JS assets (proto, generated, public) are staged into `dist/` via
`cp -r` so the runtime needs a single `COPY --from=builder`.

### tsc output path

The tsconfig has `rootDir: "."`, so tsc emits to `dist/src/`, not
`dist/`. Entry points are therefore `dist/src/index.js` (poller) and
`dist/src/api/index.js` (API). This was discovered during the first
deploy — `npm run dev` uses `tsx` which bypasses the build entirely.

---

## 4. Resource Limits

The CX23's 4GB must accommodate six containers plus the OS. Without
explicit limits, Kafka's JVM defaults to ~1GB heap and MongoDB's
WiredTiger cache defaults to ~50% of available RAM.

| Component       | Limit           | Why                                                     |
|-----------------|-----------------|---------------------------------------------------------|
| Kafka JVM heap  | 256MB (`-Xmx`)  | Single-node, low-throughput topic; 1GB default is wasteful |
| MongoDB cache   | 256MB           | Caps WiredTiger's memory footprint; sufficient for the document volume |
| Analytics engine| ~1.6GB observed | pandas DataFrames for ~1000 pings/window; GC cleanup after each window prevents unbounded growth |

**Observed steady-state memory** (after 33 hours):

| Container     | RAM      |
|---------------|----------|
| analytics     | ~1.6 GB  |
| kafka         | ~440 MB  |
| kafkabat-ui   | ~370 MB  |
| mongodb       | ~250 MB  |
| ingestion     | ~65 MB   |
| api           | ~64 MB   |
| **Total**     | **~2.8 GB** (of 3.7 GB available) |

---

## 5. docker-compose.yml

The full compose file is maintained in the repository root. Key design
decisions:

### YAML anchor for shared environment

All three app services connect to the same Kafka and MongoDB. A
`x-common-env` anchor eliminates duplication:

```yaml
x-common-env: &common-env
  KAFKA_BROKER: kafka:29092
  MONGO_URI: mongodb://mongodb:27017/gtfs_realtime
  MONGO_DATABASE: gtfs_realtime
```

Services merge with `<<: *common-env` and add service-specific vars
(analytics uses `KAFKA_BROKERS` (plural) due to the Python config
naming convention).

### Port bindings

| Port  | Binding     | Access          | Reason                                    |
|-------|-------------|-----------------|-------------------------------------------|
| 27017 | `127.0.0.1` | localhost only  | MongoDB — no auth, must not face internet |
| 9092  | `127.0.0.1` | localhost only  | Kafka — same reasoning                    |
| 8080  | `127.0.0.1` | SSH tunnel only | Kafka UI — diagnostic tool, not public    |
| 3000  | `0.0.0.0`   | internet        | API + map;  the public-facing endpoint    |

### MongoDB version pinned to 7.0

`mongo:latest` (8.0) has a known incompatibility with Linux kernel
6.19+ (SERVER-121912). Pinned to 7.0 until the upstream fix lands.

### Health checks and startup ordering

Infrastructure services (Kafka, MongoDB) have health checks with
`start_period` to account for cold-start time. Application services
use `depends_on: condition: service_healthy` to avoid connection
refused errors on startup.

### No `.env` file needed

All configuration is inline via the YAML anchor and `environment:`
blocks. The ingestion service's `process.loadEnvFile()` and analytics
engine's `dotenv.load_dotenv()` silently skip when no `.env` file
exists, falling back to the environment variables Docker Compose
provides.

---

## 6. Deployment

```bash
ssh deployer@157.90.113.98
cd ~/workspace/GTFS-Realtime-Stream-Engine

# First deploy
docker compose build
docker compose up -d

# Subsequent deploys
git pull origin main
docker compose build
docker compose up -d
```

Build takes 2-5 minutes on first run (dependency download), ~30 seconds
on subsequent runs (layer caching). Kafka and MongoDB volumes persist across rebuilds.

---

## 7. Verification

```bash
# All containers running
docker ps

# API returning live data
curl -s http://localhost:3000/v1/status/live | python3 -m json.tool | head -20

# MongoDB accumulating documents
docker compose exec mongodb mongosh --eval "use gtfs_realtime; db.schedule_deviations.countDocuments(); db.bunching_events.countDocuments()"

# Memory within budget
docker stats --no-stream

# Map loading in browser
# http://157.90.113.98:3000/map
```

The API returns data after the analytics engine completes at least one
processing window (60s) plus the live window filter (3 min). First
deploy patience: ~4 minutes before the map shows markers.

---

## 8. Operations

### Updating the code

```bash
git pull origin main
docker compose build        # rebuilds only changed layers
docker compose up -d        # restarts changed containers
```

### Reading logs

```bash
docker compose logs --tail=50 ingestion
docker compose logs --tail=50 analytics
docker compose logs --tail=50 api
```

### Kafka UI (via SSH tunnel)

```bash
# From local machine:
ssh -L 8080:localhost:8080 deployer@157.90.113.98
# Open http://localhost:8080
```

### Disk cleanup

```bash
docker system prune -f      # removes unused images, build cache
```

### Stopping Kafka UI to free ~370MB RAM

```bash
docker compose stop kafkabat-ui
```

---

## 9. Security

### Firewall (UFW)

```bash
sudo ufw allow 22/tcp       # SSH
sudo ufw allow 3000/tcp     # API + Map
sudo ufw enable
```

### helmet configuration

The API uses helmet for HTTP security headers, but disables HSTS and
CSP `upgrade-insecure-requests` since the server runs over plain HTTP.
Without this, browsers would silently upgrade script requests to
HTTPS, causing the map to fail to load (blank page, no errors in
console).

---

## 10. Known Issues Encountered

These were discovered during the first deployment and fixed. Documented
for future reference.

### MongoDB kernel incompatibility (2026-09-25)

**Symptom:** MongoDB container exits immediately with "Linux kernel
versions 6.19 and newer has a known incompatibility."

**Fix:** Pinned image to `mongo:7.0` instead of `mongo:latest` (8.0).
See SERVER-121912.

### tsc output path mismatch (2026-09-25)

**Symptom:** `Cannot find module '/app/dist/api/index.js'` on startup.

**Root cause:** `tsconfig.json` has `rootDir: "."`, so tsc emits to
`dist/src/`, not `dist/`. Locally, `tsx` bypasses the build entirely,
so this was never observed.

**Fix:** Updated Dockerfile CMDs to `dist/src/index.js` and
`dist/src/api/index.js`. Updated asset staging to `dist/src/proto/`
and `dist/src/generated/`.

### pino-pretty not available in production (2026-09-25)

**Symptom:** `Error: unable to determine transport target for "pino-pretty"`

**Root cause:** `pino-pretty` is a devDependency. The runtime stage uses
`npm ci --omit=dev`. The logger unconditionally configured it as a
transport.

**Fix:** Logger now checks `NODE_ENV === 'production'` and skips both
`pino-pretty` and `pino-roll` transports. In production, pino outputs
structured JSON to stdout (machine-parseable, lower overhead). Added
`ENV NODE_ENV=production` to both Node.js Dockerfiles.

### Helmet HSTS/CSP breaks map over HTTP (2026-09-25)

**Symptom:** Map page loads but shows blank background. No errors in
browser console. `map.js` and `map-logic.js` return 0 bytes.

**Root cause:** helmet's defaults include `Strict-Transport-Security`
and CSP `upgrade-insecure-requests`. The browser upgrades HTTP requests
to HTTPS, but the server has no TLS — scripts silently fail.

**Fix:** `hsts: false` and `upgradeInsecureRequests: null` in the
helmet configuration. See `ingestion-service/src/api/server.ts`.

---

## 11. Troubleshooting

### Service won't start — connection refused

The `depends_on: condition: service_healthy` should prevent this, but
if Kafka or MongoDB health checks are slow:

```bash
docker compose restart <service-name>
```

### Port 3000 already in use

```bash
sudo lsof -i :3000
# Kill the process or change API_PORT in docker-compose.yml
```

### Map shows nothing

```bash
# 1. API returning data?
curl http://localhost:3000/v1/status/live

# 2. Analytics producing deviations?
docker compose logs --tail=20 analytics | grep "Window persisted"

# 3. Wait 3-4 minutes — first window needs time to fill
```

### OOM kills

```bash
dmesg | grep -i oom
docker stats --no-stream
```

The 4GB CX23 has headroom. OOM would indicate an unexpected consumer
(likely kafkabat-ui at 370MB). Stop it with `docker compose stop
kafkabat-ui`.

---

## 12. Cost

| Item              | Monthly cost     |
|-------------------|------------------|
| Hetzner CX23      | €4.49 (~$4.90)   |
| Domain            | $0 (using IP)    |
| TLS               | $0 (plain HTTP)  |
| MBTA API key      | $0 (public feed) |
| **Total**         | **~€4.49/month** |
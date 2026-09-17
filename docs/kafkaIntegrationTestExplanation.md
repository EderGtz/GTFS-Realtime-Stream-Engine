# Kafka Integration Test Architecture (testcontainers-node)

## Introduction
This document explains the synchronization mechanism implemented in TypeScript integration tests of `ingestion-service`. 

Testing Kafka locally using Docker containers with dynamic ports poses a challenge: Kafka must know its external hostname and mapped port (`KAFKA_ADVERTISED_LISTENERS`) **before** it boots up. However, `testcontainers` only knows which random port Docker assigned **after** the container has already started.

To solve this chicken-and-egg problem, it was implemented a **Readiness Gate Strategy**:
1. The container's entrypoint is intercepted, freezing its main process in a custom `while` loop upon startup.
2. While frozen, it is extracted the dynamically mapped port from the host.
3. Execute a parallel backdoor process (`docker exec`) to inject the correct runtime configuration.
4. A sentinel file is created to release the gate, allowing Kafka to initialize with the correct network metadata.

## Execution Sequence Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant TS as TypeScript Test
    participant TC as testcontainers-node
    participant D as Docker Host
    participant C_PID1 as Container (PID 1)
    participant C_Exec as Container (Exec)

    Note over TS, C_PID1: PHASE 1: BOOTSTRAP & FREEZE
    TS->>TC: Start Container (cp-kafka:7.6.0)
    TC->>D: docker run -d -p RANDOM:9092
    D-->>TC: Container created (port 30352)
    activate C_PID1
    C_PID1->>C_PID1: echo "waiting-for-config"
    Note over C_PID1: Frozen loop (file does not exist)
    C_PID1->>C_PID1: while block loops 10x/sec
    TC->>TC: Scans container logs
    TC-->>TS: Log detected! Handles ready.

    Note over TS, C_Exec: PHASE 2: PORT EXTRACTION
    TS->>TC: container.getMappedPort(9092)
    TC-->>TS: Returns port 30352
    TS->>TC: container.exec([echo override])
    TC->>D: docker exec
    activate C_Exec
    C_Exec->>C_Exec: Overwrites bash-config with port 30352
    C_Exec-->>TS: Exec finished
    deactivate C_Exec

    Note over TS, C_PID1: PHASE 3: UNFREEZING & STARTUP
    TS->>TC: container.exec([touch ready])
    TC->>D: docker exec
    activate C_Exec
    C_Exec->>C_Exec: Creates /tmp/testcontainers-ready file
    C_Exec-->>TS: Exec finished
    deactivate C_Exec
    
    C_PID1->>C_PID1: Loop detects file and breaks
    C_PID1->>C_PID1: Executes /etc/confluent/docker/run
    Note over C_PID1: Kafka starts mapped to 30352
    C_PID1-->>TS: Kafka broker is fully up
    deactivate C_PID1

    Note over TS, C_PID1: PHASE 4: CLIENT HANDSHAKE
    TS->>D: kafkajs connects to localhost:30352
    D->>C_PID1: Routes traffic to container 9092
    C_PID1-->>TS: Handshake: "Use localhost:30352 for traffic"
    TS->>D: Successfully publishes/consumes E2E telemetry
```
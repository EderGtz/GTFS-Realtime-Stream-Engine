import { describe, test, expect } from "vitest";
import { hasValidPosition, vehiclesWithValidTelemetries } from "../src/ingestion/validator.js";
import type { DecodedVehiclePosition } from "../src/ingestion/decoder.js";

function makeVehicleEntity(
    overrides: Partial<NonNullable<DecodedVehiclePosition["vehicle"]>> = {},
    id = "1"
): DecodedVehiclePosition {
    return {
        id,
        vehicle: {
        trip: { tripId: "trip-1", routeId: "route-1" },
        vehicle: { id: "vehicle-1", label: "Bus 1" },
        position: { latitude: 42.35, longitude: -71.05 },
        timestamp: "1700000000",
        ...overrides,
        },
    };
}

describe("hasValidPosition", () => {
  test("accepts a vehicle with valid numeric coordinates", () => {
    expect(hasValidPosition(makeVehicleEntity().vehicle)).toBe(true);
  });

  test("rejects an undefined vehicle", () => {
    expect(hasValidPosition(undefined as any)).toBe(false);
  });

  test("rejects a vehicle with no position field at all", () => {
    const entity = makeVehicleEntity({ position: undefined as any });
    expect(hasValidPosition(entity.vehicle)).toBe(false);
  });

  test("rejects NaN coordinates", () => {
    const entity = makeVehicleEntity({ position: { latitude: NaN, longitude: -71.05 } });
    expect(hasValidPosition(entity.vehicle)).toBe(false);
  });

  test("rejects undefined coordinates", () => {
    const entity = makeVehicleEntity({
      position: { latitude: undefined as any, longitude: -71.05 },
    });
    expect(hasValidPosition(entity.vehicle)).toBe(false);
  });

  test("rejects coordinates outside valid geographical bounds", () => {
    const badLat = makeVehicleEntity({ position: { latitude: 95, longitude: -71.05 } });
    expect(hasValidPosition(badLat.vehicle)).toBe(false);

    const badLon = makeVehicleEntity({ position: { latitude: 42.35, longitude: -200 } });
    expect(hasValidPosition(badLon.vehicle)).toBe(false);
  });
});

describe("vehiclesWithValidTelemetries", () => {
  test("converts a valid entity into a telemetry document", () => {
    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries([makeVehicleEntity()]);

    expect(skippedVehicles).toBe(0);
    expect(validTelemetries).toHaveLength(1);

    const telemetry = validTelemetries[0];
    expect(telemetry).toBeDefined();
    if (!telemetry) {
      throw new Error("Expected a telemetry document");
    }

    expect(telemetry.location.coordinates).toEqual([-71.05, 42.35]);
    expect(telemetry.vehicle_id).toBe("vehicle-1");
    expect(telemetry.trip_id).toBe("trip-1");
    expect(telemetry.route_id).toBe("route-1");
    expect(telemetry.timestamp).toBeInstanceOf(Date);
    expect(Number.isNaN(telemetry.timestamp.getTime())).toBe(false);
  });

  test("skips entities with no position and counts them", () => {
    const entities = [makeVehicleEntity({ position: undefined as any }, "1"), makeVehicleEntity({}, "2")];
    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries(entities);

    expect(validTelemetries).toHaveLength(1);
    expect(skippedVehicles).toBe(1);
  });

  test("skips vehicles with no vehicle_id", () => {
    const entities = [makeVehicleEntity({ vehicle: undefined as any })];
    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries(entities);

    expect(validTelemetries).toHaveLength(0);
    expect(skippedVehicles).toBe(1);
  });

  test("stores trip_id as null when the vehicle has no assigned trip", () => {
    const entities = [makeVehicleEntity({ trip: undefined as any })];
    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries(entities);

    expect(skippedVehicles).toBe(0);
    expect(validTelemetries).toHaveLength(1);

    const telemetry = validTelemetries[0];
    expect(telemetry).toBeDefined();
    if (!telemetry) {
      throw new Error("Expected a telemetry document");
    }

    expect(telemetry.trip_id).toBeNull();
    expect(telemetry.route_id).toBeNull();
  });

  test("skips vehicles with a missing/invalid timestamp instead of storing Invalid Date", () => {
    const entities = [makeVehicleEntity({ timestamp: undefined as any })];
    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries(entities);

    expect(validTelemetries).toHaveLength(0);
    expect(skippedVehicles).toBe(1);
  });

  test("safely parses omitted optional fields as null without skipping the vehicle", () => {
    // We only have lat, lon y timestamp
    const entity = makeVehicleEntity({
      position: { latitude: 42.35, longitude: -71.05 },
      currentStopSequence: undefined,
      stopId: undefined,
      currentStatus: undefined,
    } as any);

    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries([entity]);

    expect(skippedVehicles).toBe(0);
    expect(validTelemetries).toHaveLength(1);

    const telemetry = validTelemetries[0];
    expect(telemetry).toBeDefined();
    
    if (telemetry) {
        expect(telemetry.vehicle_id).not.toBeNull();
        expect(telemetry.speed).toBeNull();
        expect(telemetry.bearing).toBeNull();
        expect(telemetry.current_stop_sequence).toBeNull();
        expect(telemetry.stop_id).toBeNull();
        expect(telemetry.current_status).toBeNull();
    }
  });

  test("accepts invalid physical values", () => {
    const entity = makeVehicleEntity({
      position: { 
        latitude: 42.35, 
        longitude: -71.05, 
        speed: -15.5,
        bearing: 450
      }
    });

    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries([entity]);

    expect(skippedVehicles).toBe(0);
    expect(validTelemetries).toHaveLength(1);
    expect(validTelemetries[0]!.speed).toBe(-15.5);
    expect(validTelemetries[0]!.bearing).toBe(450);
  });

  test("accepts edge-case timestamps", () => {
    const entityZero = makeVehicleEntity({ timestamp: "0" }, "v-zero");
    const entityNegative = makeVehicleEntity({ timestamp: "-1000" }, "v-neg");
    const entityFuture = makeVehicleEntity({ timestamp: "4000000000" }, "v-future");

    const { validTelemetries, skippedVehicles } = vehiclesWithValidTelemetries([
      entityZero, entityNegative, entityFuture
    ]);

    expect(skippedVehicles).toBe(0);
    expect(validTelemetries).toHaveLength(3);
    expect(validTelemetries[0]!.timestamp.getTime()).toBe(0);
    expect(validTelemetries[1]!.timestamp.getTime()).toBe(-1000000);
  });
});

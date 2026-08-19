import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeFeedMessage } from "../src/ingestion/decoder.js";
import { vehiclesWithValidTelemetries } from "../src/ingestion/validator.js";
import { transit_realtime } from "../src/generated/gtfs-realtime.js";

const __dirname = import.meta.dirname; 
const FIXTURE_PATH = path.join(__dirname, "fixtures", "mbta_feed.pb");

describe("decodeFeedMessage", () => {
  test("decodes a real captured feed without throwing", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const result = decodeFeedMessage(new Uint8Array(buffer));

    expect(result.entity).toBeDefined();
    expect(Array.isArray(result.entity)).toBe(true);
    expect(result.entity.length).toBeGreaterThan(0);
  });

  test("validates the entity has a valid shape", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const result = decodeFeedMessage(new Uint8Array(buffer));

    expect(result.entity).toBeDefined();
    const { validTelemetries } = vehiclesWithValidTelemetries(result.entity!);
    expect(validTelemetries.length).toBeGreaterThan(0);
  });

  test("each decoded entity has the expected shape", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const { entity } = decodeFeedMessage(new Uint8Array(buffer));

    for (const e of entity) {
      expect(typeof e.id).toBe("string");
    }
  });

  test("decodes entities without 'vehicle' (TripUpdate, Alert) safely without throwing", () => {
    const syntheticMessage = transit_realtime.FeedMessage.create({
      header: {
        gtfsRealtimeVersion: "3.1416",
        timestamp: Math.floor(Date.now() / 1000),
      },
      entity: [
        { 
          id: "trip-update-1", 
          tripUpdate: { trip: { tripId: "trip-1" } } 
        },
        { 
          id: "alert-1", 
          alert: { headerText: { translation: [{ text: "Closed" }] } } 
        },
        { 
          id: "empty-entity" 
        },
      ],
    });

    const syntheticBuffer = transit_realtime.FeedMessage.encode(syntheticMessage).finish();
    const result = decodeFeedMessage(syntheticBuffer);

    expect(result.entity).toBeDefined();
    expect(result.entity).toHaveLength(3);
    
    expect(result.entity[0]!.id).toBe("trip-update-1");
    expect(result.entity[0]!.vehicle).toBeUndefined();
    expect(result.entity[1]!.id).toBe("alert-1");
    expect(result.entity[1]!.vehicle).toBeUndefined();
    expect(result.entity[2]!.id).toBe("empty-entity");
    expect(result.entity[2]!.vehicle).toBeUndefined();
  });

  test("at least one vehicle has a valid, finite lat/lon", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const { entity } = decodeFeedMessage(new Uint8Array(buffer));

    const withPosition = entity.filter(e => e.vehicle?.position);
    expect(withPosition.length).toBeGreaterThan(0);

    for (const e of withPosition) {
      expect(Number.isFinite(e.vehicle!.position!.latitude)).toBe(true);
      expect(Number.isFinite(e.vehicle!.position!.longitude)).toBe(true);
    }
  });

  test("throws on garbage input instead of silently returning junk", () => {
    const garbage = new Uint8Array([0xff, 0x00, 0xff, 0x00, 0x12, 0x34]);
    expect(() => decodeFeedMessage(garbage)).toThrow();
  });

  test("throws when required 'header' field is missing (empty buffer)", () => {
    const empty = new Uint8Array([]);
    expect(() => decodeFeedMessage(empty)).toThrow();
  });
});
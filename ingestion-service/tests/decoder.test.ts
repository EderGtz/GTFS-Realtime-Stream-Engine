import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodeVehiclePositions } from "../src/ingestion/decoder.js";
import { vehiclesWithValidTelemetries } from "../src/ingestion/validator.js";

const __dirname = import.meta.dirname; 
const FIXTURE_PATH = path.join(__dirname, "fixtures", "mbta_feed.pb");

describe("decodeVehiclePositions", () => {
  test("decodes a real captured feed without throwing", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const result = decodeVehiclePositions(new Uint8Array(buffer));

    expect(result.entity).toBeDefined();
    expect(Array.isArray(result.entity)).toBe(true);
    expect(result.entity.length).toBeGreaterThan(0);
  });

  test("validates the entity has a valid shape", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const result = decodeVehiclePositions(new Uint8Array(buffer));

    expect(result.entity).toBeDefined();
    const { validTelemetries } = vehiclesWithValidTelemetries(result.entity!);
    expect(validTelemetries.length).toBeGreaterThan(0);
  });

  test("each decoded entity has the expected shape", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const { entity } = decodeVehiclePositions(new Uint8Array(buffer));

    for (const e of entity) {
      expect(typeof e.id).toBe("string");
      expect(e.vehicle).toBeTruthy();
    }
  });

  test("at least one vehicle has a valid, finite lat/lon", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const { entity } = decodeVehiclePositions(new Uint8Array(buffer));

    const withPosition = entity.filter(e => e.vehicle?.position);
    expect(withPosition.length).toBeGreaterThan(0);

    for (const e of withPosition) {
      expect(Number.isFinite(e.vehicle.position!.latitude)).toBe(true);
      expect(Number.isFinite(e.vehicle.position!.longitude)).toBe(true);
    }
  });

  test("throws on garbage input instead of silently returning junk", () => {
    const garbage = new Uint8Array([0xff, 0x00, 0xff, 0x00, 0x12, 0x34]);
    expect(() => decodeVehiclePositions(garbage)).toThrow();
  });

  test("throws when required 'header' field is missing (empty buffer)", () => {
    const empty = new Uint8Array([]);
    expect(() => decodeVehiclePositions(empty)).toThrow();
  });
});
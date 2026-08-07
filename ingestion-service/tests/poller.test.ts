import { describe, test, expect, vi, beforeEach } from "vitest";
import { requestWithRetry, wait } from "../src/utils/requestWithRetry.js";
import { decodeVehiclePositions } from "../src/ingestion/decoder.js";
import { vehiclesWithValidTelemetries } from "../src/ingestion/validator.js";
import { setupKafka, publishTelemetries } from "../src/ingestion/producer.js";
import { logger } from "../src/utils/logger.js";


vi.mock("../src/config.js", () => ({
    config: {
        mbta: { vehiclePositionsUrl: "https://fake.test/VehiclePositions.pb" },
        kafka: { brokers: ["fake-broker:9092"], topic: "raw.vehicle-positions", numPartitions: 4 },
    },
}));

import * as poller from "../src/ingestion/poller.js";

vi.mock("../src/utils/requestWithRetry.js", () => ({
    requestWithRetry: vi.fn(),
    wait: vi.fn(),
}));
vi.mock("../src/ingestion/decoder.js", () => ({
    decodeVehiclePositions: vi.fn(),
}));
vi.mock("../src/ingestion/validator.js", () => ({
    vehiclesWithValidTelemetries: vi.fn(),
}));
vi.mock("../src/ingestion/producer.js", () => ({
    setupKafka: vi.fn(),
    publishTelemetries: vi.fn(),
}));
vi.mock("../src/utils/logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));


beforeEach(() => {
    vi.clearAllMocks();
});

describe("fetchFeedBuffer", () => {
    test("returns the buffer on a healthy response", async () => {
        const fakeBuffer = new ArrayBuffer(8);
        (requestWithRetry as any).mockResolvedValue(fakeBuffer);

        const result = await poller.fetchFeedBuffer();
        expect(result).toBe(fakeBuffer);
    });

    test("throws on an empty buffer", async () => {
        (requestWithRetry as any).mockResolvedValue(new ArrayBuffer(0));
        await expect(poller.fetchFeedBuffer()).rejects.toThrow("Received empty response from MBTA");
    });

    test("throws when requestWithRetry resolves null/undefined", async () => {
        (requestWithRetry as any).mockResolvedValue(undefined);
        await expect(poller.fetchFeedBuffer()).rejects.toThrow("Received empty response from MBTA");
    });
});

describe("decodeFeed", () => {
    test("returns the entity array from the decoder", () => {
        const fakeEntities = [{ id: "1" }];
        (decodeVehiclePositions as any).mockReturnValue({ entity: fakeEntities });

        expect(poller.decodeFeed(new ArrayBuffer(4))).toBe(fakeEntities);
    });

    test("returns an empty array when entity is missing", () => {
        (decodeVehiclePositions as any).mockReturnValue({});
        expect(poller.decodeFeed(new ArrayBuffer(4))).toEqual([]);
    });
});

describe("pollCycle", () => {
    test("wires fetch -> decode -> validate -> publish and logs the outcome", async () => {
        (requestWithRetry as any).mockResolvedValue(new ArrayBuffer(8));
        (decodeVehiclePositions as any).mockReturnValue({ entity: [{ id: "1" }] });
        (vehiclesWithValidTelemetries as any).mockReturnValue({
            validTelemetries: [{ vehicle_id: "v1" }],
            skippedVehicles: 2,
        });
        (publishTelemetries as any).mockResolvedValue({ published: 1 });

        await poller.pollCycle();

        expect(publishTelemetries).toHaveBeenCalledWith([{ vehicle_id: "v1" }]);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("1 records published to Kafka, 2 malformed vehicles omitted.")
        );
    });

    test("propagates a fetch failure without calling publishTelemetries", async () => {
        (requestWithRetry as any).mockResolvedValue(new ArrayBuffer(0));

        await expect(poller.pollCycle()).rejects.toThrow("Received empty response from MBTA");
        expect(publishTelemetries).not.toHaveBeenCalled();
    });

    test("propagates a Kafka publish failure", async () => {
        (requestWithRetry as any).mockResolvedValue(new ArrayBuffer(8));
        (decodeVehiclePositions as any).mockReturnValue({ entity: [] });
        (vehiclesWithValidTelemetries as any).mockReturnValue({ validTelemetries: [], skippedVehicles: 0 });
        (publishTelemetries as any).mockRejectedValue(new Error("broker unreachable"));

        await expect(poller.pollCycle()).rejects.toThrow("broker unreachable");
    });
});

describe("computeWaitMs", () => {
    test("returns the base 15s interval below the alert threshold", () => {
        expect(poller.computeWaitMs(0)).toBe(15_000);
        expect(poller.computeWaitMs(4)).toBe(15_000);
    });

    test("starts backing off once the threshold is reached", () => {
        expect(poller.computeWaitMs(5)).toBe(15_000);   // 15s * 2^0
        expect(poller.computeWaitMs(6)).toBe(30_000);   // 15s * 2^1
        expect(poller.computeWaitMs(7)).toBe(60_000);   // 15s * 2^2
    });

    test("caps backoff at 5 minutes", () => {
        expect(poller.computeWaitMs(20)).toBe(5 * 60_000);
    });
});

 describe("pollVehiclePositions (loop behavior)", () => {
    test("calls setupKafka exactly once before entering the loop", async () => {
        (setupKafka as any).mockResolvedValue(undefined);
        const mockPoll = vi.fn().mockResolvedValue(undefined);
        (wait as any).mockRejectedValueOnce(new Error("STOP_LOOP"));

        await expect(poller.pollVehiclePositions(mockPoll)).rejects.toThrow("STOP_LOOP");
        expect(setupKafka).toHaveBeenCalledTimes(1);
    });

    test("increments consecutiveFailures and fires a single fatal alert at the threshold", async () => {
        (setupKafka as any).mockResolvedValue(undefined);
        const mockPoll = vi.fn().mockRejectedValue(new Error("feed down"));

        let waitCalls = 0;
        (wait as any).mockImplementation(() => {
            waitCalls++;
            if (waitCalls >= 6) throw new Error("STOP_LOOP");
            return Promise.resolve();
        });

        await expect(poller.pollVehiclePositions(mockPoll)).rejects.toThrow("STOP_LOOP");

        expect(mockPoll).toHaveBeenCalledTimes(6);
        expect(logger.fatal).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledTimes(6);
    });

    test("logs a recovery message after a successful cycle following failures", async () => {
        (setupKafka as any).mockResolvedValue(undefined);
        const mockPoll = vi.fn()
            .mockRejectedValueOnce(new Error("fail 1"))
            .mockRejectedValueOnce(new Error("fail 2"))
            .mockResolvedValueOnce(undefined);

        let waitCalls = 0;
        (wait as any).mockImplementation(() => {
            waitCalls++;
            if (waitCalls >= 3) throw new Error("STOP_LOOP");
            return Promise.resolve();
        });

        await expect(poller.pollVehiclePositions(mockPoll)).rejects.toThrow("STOP_LOOP");

        expect(mockPoll).toHaveBeenCalledTimes(3);
        // Only 2 failures occurred before the STOP_LOOP cutoff — below the 5-failure
        // threshold — so the recovery warning should never fire.
        expect(logger.warn).not.toHaveBeenCalled();
    });
 });
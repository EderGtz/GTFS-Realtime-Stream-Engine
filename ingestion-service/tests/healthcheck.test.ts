import { describe, test, expect, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createHealthcheck } from "../src/utils/healthcheck.js";
import { logger } from "../src/utils/logger.js";

const PING_URL = "https://hc.test/ping/abc";

/** Flush pending microtasks so swallowed promise rejections settle first. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function recordingTransport() {
    const calls: string[] = [];
    const transport = vi.fn(async (url: string) => {
        calls.push(url);
    });
    return { calls, transport };
}

describe("createHealthcheck (dead-man's-switch heartbeat)", () => {
    test("ok() pings the plain URL", () => {
        const { calls, transport } = recordingTransport();

        createHealthcheck(PING_URL, transport).ok();

        expect(calls).toEqual([PING_URL]);
    });

    test("fail() pings the /fail endpoint", () => {
        const { calls, transport } = recordingTransport();

        createHealthcheck(PING_URL, transport).fail();

        expect(calls).toEqual([PING_URL + "/fail"]);
    });

    test("trailing slashes are stripped so /fail appends correctly", () => {
        const { calls, transport } = recordingTransport();

        createHealthcheck(PING_URL + "//", transport).fail();

        expect(calls).toEqual([PING_URL + "/fail"]);
    });

    test("is disabled without a URL — no transport calls at all", () => {
        const { calls, transport } = recordingTransport();

        createHealthcheck("", transport).ok();
        createHealthcheck(undefined, transport).fail();
        createHealthcheck(null, transport).ok();

        expect(calls).toEqual([]);
    });

    test("a failing ping is swallowed and logged — it never propagates", async () => {
        const transport = vi.fn(async () => {
            throw new ConnectionError("healthchecks.io unreachable");
        });
        const healthcheck = createHealthcheck(PING_URL, transport);

        expect(() => healthcheck.ok()).not.toThrow();
        expect(() => healthcheck.fail()).not.toThrow();
        await flush();

        expect(logger.warn).toHaveBeenCalledTimes(2);
    });
});

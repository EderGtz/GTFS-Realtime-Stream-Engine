/**
 * Loads the curated real-world GTFS fixture feeds from tests/fixtures/gtfs/
 * (repo root, shared with the Python analytics-engine tests) so integration
 * tests can derive their seeded data from real feed rows -- real route ids,
 * real route_long_name values (including WMATA's empty one), real trip_id
 * shapes, and real stop coordinates -- instead of hand-written strings.
 *
 * Provenance and the quirk matrix for each feed live in
 * tests/fixtures/gtfs/README.md.
 *
 * Both dependencies here are test-only (devDependencies):
 * - adm-zip: the fixtures are plain GTFS .zip archives so one artifact serves
 *   both test suites, and Node's standard library has no zip reader.
 * - papaparse: Node has no standard-library CSV reader either; papaparse is
 *   tested on exactly the quoting/escaping edge cases the real feeds
 *   contain (WMATA quotes every field, MBTA names contain commas).
 */
import AdmZip from 'adm-zip';
import Papa from 'papaparse';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// tests/integration/gtfsFixtures.ts -> repo root + tests/fixtures/gtfs
const FIXTURES_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../tests/fixtures/gtfs',
);

export interface GtfsRow {
    [column: string]: string;
}

export interface GtfsFixture {
    name: string;
    routes: GtfsRow[];
    trips: GtfsRow[];
    stops: GtfsRow[];
    stopTimes: GtfsRow[];
}

export function loadGtfsFixture(name: string): GtfsFixture {
    const zip = new AdmZip(path.join(FIXTURES_DIR, `${name}.zip`));
    return {
        name,
        routes: readEntry(zip, 'routes.txt'),
        trips: readEntry(zip, 'trips.txt'),
        stops: readEntry(zip, 'stops.txt'),
        stopTimes: readEntry(zip, 'stop_times.txt'),
    };
}

function readEntry(zip: AdmZip, filename: string): GtfsRow[] {
    const entry = zip.getEntry(filename);
    if (entry === null) {
        throw new Error(`GTFS fixture is missing ${filename}`);
    }
    const parsed = Papa.parse<GtfsRow>(entry.getData().toString('utf-8'), {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false, // every value stays a raw string: GTFS ids and
        // times must never be type-inferred (e.g. "08:00:00" or trip_ids
        // with leading zeros would be corrupted by numeric inference)
    });
    return parsed.data.map((row) => {
        // papaparse parks surplus columns (upstream fixtures have rows with
        // trailing commas) under __parsed_extra; drop it so rows carry only
        // real columns.
        delete (row as Record<string, unknown>)['__parsed_extra'];
        return row;
    });
}

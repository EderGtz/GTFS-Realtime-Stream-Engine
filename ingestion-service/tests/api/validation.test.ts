import { describe, test, expect } from 'vitest';
import { isValidRouteId, MAX_ROUTE_ID_LENGTH } from '../../src/api/validation.js';

/**
 * Route-ID bounds validation (M7): GTFS route_ids may contain underscores,
 * dots and spaces, so validation is length + well-formed decoding, not a
 * charset whitelist. Express percent-decodes req.params before handlers run.
 */
describe('isValidRouteId', () => {
    test('accepts the ID shapes GTFS actually ships', () => {
        expect(isValidRouteId('28')).toBe(true);
        expect(isValidRouteId('Red')).toBe(true);
        expect(isValidRouteId('Green-D')).toBe(true);
        expect(isValidRouteId('Green_D')).toBe(true);
        expect(isValidRouteId('CR-Providence.1')).toBe(true);
        expect(isValidRouteId('Mattapan T')).toBe(true);
    });

    test('accepts an ID at exactly the length bound', () => {
        expect(isValidRouteId('a'.repeat(MAX_ROUTE_ID_LENGTH))).toBe(true);
    });

    test('rejects missing and empty IDs', () => {
        expect(isValidRouteId(undefined)).toBe(false);
        expect(isValidRouteId('')).toBe(false);
    });

    test('rejects IDs over the length bound', () => {
        expect(isValidRouteId('a'.repeat(MAX_ROUTE_ID_LENGTH + 1))).toBe(false);
    });

    test('rejects control characters (log-injection guard)', () => {
        expect(isValidRouteId('a\nb')).toBe(false);
        expect(isValidRouteId('a\x00b')).toBe(false);
        expect(isValidRouteId('a\x7fb')).toBe(false);
    });
});

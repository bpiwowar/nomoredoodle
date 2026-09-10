import {test} from 'node:test';
import assert from 'node:assert';
import {calendarId, nativeIdOf, sourceOf} from '../source/calendars/types.js';

/**
 * These three functions are what the whole multi-source design rests on, and
 * getting them wrong is invisible: an id that does not round-trip reads back as
 * an unknown calendar, which reads as "off", which produces no events — and a
 * poll with no events is answered "yes" everywhere and submitted.
 */
test('a namespaced id round-trips', () => {
	const id = calendarId('native', '5C67B40E-D76F-4366-AB87-7F8ACA3D7F4C');
	assert.strictEqual(sourceOf(id), 'native');
	assert.strictEqual(nativeIdOf(id), '5C67B40E-D76F-4366-AB87-7F8ACA3D7F4C');
});

test('only the first colon separates, so a native id may contain colons', () => {
	const id = calendarId('native', 'local:calendar:with:colons');
	assert.strictEqual(sourceOf(id), 'native');
	assert.strictEqual(nativeIdOf(id), 'local:calendar:with:colons');
});

test('a CalDAV calendar keyed by its URL round-trips', () => {
	const url = 'https://p137-caldav.icloud.com/1234567/calendars/work/';
	const id = calendarId('caldav-7f3a2b1c', url);
	assert.strictEqual(sourceOf(id), 'caldav-7f3a2b1c');
	assert.strictEqual(nativeIdOf(id), url);
});

test('a pre-migration bare id resolves to no source rather than the wrong one', () => {
	// This is why the migration exists. Ignoring such a key is safe; routing it
	// to whichever source happened to sort first would not be.
	assert.strictEqual(sourceOf('5C67B40E-D76F-4366-AB87-7F8ACA3D7F4C'), '');
});

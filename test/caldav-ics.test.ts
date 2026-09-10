import {test} from 'node:test';
import assert from 'node:assert';
import {parseCalendar} from '../source/calendars/caldav/ics.js';

const calendar = 'caldav-1:https://dav.example.org/cal/';

function ics(...lines: string[]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
}

const sample = ics(
	'BEGIN:VTIMEZONE',
	'TZID:Europe/Paris',
	'BEGIN:DAYLIGHT',
	'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
	'DTSTART:19700329T020000',
	'END:DAYLIGHT',
	'END:VTIMEZONE',
	'BEGIN:VEVENT',
	'UID:one@example.org',
	String.raw`SUMMARY:Team sync\, weekly`,
	'DTSTART;TZID=Europe/Paris:20260921T100000',
	'DTEND;TZID=Europe/Paris:20260921T110000',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'UID:two@example.org',
	'SUMMARY:Long ti',
	' tle folded',
	'DTSTART:20260922T080000Z',
	'DURATION:PT90M',
	'TRANSP:TRANSPARENT',
	'BEGIN:VALARM',
	'ACTION:DISPLAY',
	'TRIGGER:-PT15M',
	'END:VALARM',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'UID:three@example.org',
	'SUMMARY:All day off',
	'DTSTART;VALUE=DATE:20260923',
	'STATUS:TENTATIVE',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'UID:four@example.org',
	'SUMMARY:Cancelled',
	'DTSTART:20260924T080000Z',
	'DTEND:20260924T090000Z',
	'STATUS:CANCELLED',
	'END:VEVENT',
);

const {events, recurringMasters} = parseCalendar(sample, calendar);

test('a VTIMEZONE RRULE is not mistaken for an unexpanded event', () => {
	// Every VTIMEZONE has RRULEs. Counting them would make every server on earth
	// look like one that ignores <C:expand>, and abort every fill.
	assert.strictEqual(recurringMasters, 0);
});

test('cancelled events are dropped and the rest survive in order', () => {
	assert.deepStrictEqual(
		events.map(event => event.title),
		['Team sync, weekly', 'Long title folded', 'All day off'],
	);
});

test('TZID start and end resolve to the right instant', () => {
	assert.strictEqual(events[0].startDate.toISOString(), '2026-09-21T08:00:00.000Z');
	assert.strictEqual(events[0].endDate.toISOString(), '2026-09-21T09:00:00.000Z');
});

test('a folded line is rejoined without its leading space', () => {
	assert.strictEqual(events[1].title, 'Long title folded');
});

test('DURATION stands in for a missing DTEND', () => {
	assert.strictEqual(events[1].endDate.getTime() - events[1].startDate.getTime(), 90 * 60 * 1000);
});

test('TRANSP:TRANSPARENT means the event does not block the slot', () => {
	assert.strictEqual(events[1].status, 'yes');
});

test('a DATE-only event lasts a day, and TENTATIVE becomes if-need-be', () => {
	assert.strictEqual(events[2].endDate.getTime() - events[2].startDate.getTime(), 24 * 3600 * 1000);
	assert.strictEqual(events[2].status, 'if-need-be');
});

test('every event carries the namespaced calendar id it came from', () => {
	assert.ok(events.every(event => event.calendarId === calendar));
});

test('an event that kept its RRULE is counted, because the server ignored expand', () => {
	const master = ics(
		'BEGIN:VEVENT',
		'UID:r@example.org',
		'SUMMARY:Weekly',
		'DTSTART:20260921T080000Z',
		'DTEND:20260921T090000Z',
		'RRULE:FREQ=WEEKLY;COUNT=10',
		'END:VEVENT',
	);
	assert.strictEqual(parseCalendar(master, calendar).recurringMasters, 1);
});

test('a quoted parameter may contain a colon, and so may a summary', () => {
	const odd = ics(
		'BEGIN:VEVENT',
		'UID:q@example.org',
		'SUMMARY:Odd: with colon',
		'DTSTART;TZID="UTC":20260921T080000',
		'DTEND;TZID="UTC":20260921T090000',
		'END:VEVENT',
	);
	const parsed = parseCalendar(odd, calendar);
	assert.strictEqual(parsed.events[0].title, 'Odd: with colon');
	assert.strictEqual(parsed.events[0].startDate.toISOString(), '2026-09-21T08:00:00.000Z');
});

test('an unknown time zone falls back to local rather than dropping the event', () => {
	// Losing the event would leave its slot looking free, which is the one
	// outcome worth being hours wrong to avoid.
	const exchange = ics(
		'BEGIN:VEVENT',
		'UID:tz@example.org',
		'SUMMARY:Invented zone',
		'DTSTART;TZID=Romance Standard Time:20260921T100000',
		'DTEND;TZID=Romance Standard Time:20260921T110000',
		'END:VEVENT',
	);
	const parsed = parseCalendar(exchange, calendar);
	assert.strictEqual(parsed.events.length, 1);
	assert.strictEqual(parsed.events[0].endDate.getTime() - parsed.events[0].startDate.getTime(), 3600 * 1000);
});

test('escaped text is unescaped, backslashes included', () => {
	const escaped = ics(
		'BEGIN:VEVENT',
		'UID:e@example.org',
		'SUMMARY:A\; B\\, C\\nD\\\\E',
		'DTSTART:20260921T080000Z',
		'DTEND:20260921T090000Z',
		'END:VEVENT',
	);
	assert.strictEqual(parseCalendar(escaped, calendar).events[0].title, 'A; B, C\nD\\E');
});

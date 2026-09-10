import {DateTime} from 'luxon';
import {type CalendarEvent, type CalendarStatus} from '../../events.js';

type IcsProperty = {name: string; params: Record<string, string>; value: string};

/**
 * Folded lines are continued by a leading space or tab on the next one, and the
 * fold can land anywhere — including in the middle of a UTF-8 sequence, which is
 * why unfolding happens on the whole document before anything is split.
 */
function unfold(text: string): string[] {
	return text.replaceAll(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

/** Params may be quoted and quoted values may contain ":" and ";" — TZID="GMT+1:00" is legal. */
function splitOutsideQuotes(text: string, separator: string): string[] {
	const parts: string[] = [];
	let quoted = false;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === '"') {
			quoted = !quoted;
		} else if (character === separator && !quoted) {
			parts.push(text.slice(start, index));
			start = index + 1;
		}
	}

	parts.push(text.slice(start));
	return parts;
}

function parseProperty(line: string): IcsProperty | undefined {
	// The value keeps its own colons; only the first unquoted one is a separator.
	const [head, ...rest] = splitOutsideQuotes(line, ':');
	if (rest.length === 0) {
		return undefined;
	}

	const [name, ...rawParams] = splitOutsideQuotes(head, ';');
	const params: Record<string, string> = {};
	for (const raw of rawParams) {
		const equals = raw.indexOf('=');
		if (equals !== -1) {
			params[raw.slice(0, equals).toUpperCase()] = raw.slice(equals + 1).replaceAll(/^"|"$/g, '');
		}
	}

	return {name: name.toUpperCase(), params, value: rest.join(':')};
}

/** ICalendar TEXT escaping: only these five sequences exist. */
function unescapeText(value: string): string {
	return value.replaceAll(/\\([\\;,nN])/g, (_match: string, character: string) =>
		character === 'n' || character === 'N' ? '\n' : character);
}

type IcsDate = {when: DateTime; allDay: boolean};

function parseIcsDate(property: IcsProperty): IcsDate | undefined {
	const raw = property.value.trim();

	if (property.params.VALUE === 'DATE' || /^\d{8}$/.test(raw)) {
		const when = DateTime.fromFormat(raw, 'yyyyMMdd');
		return when.isValid ? {when, allDay: true} : undefined;
	}

	const utc = raw.endsWith('Z');
	const stamp = utc ? raw.slice(0, -1) : raw;
	const zone = utc ? 'utc' : property.params.TZID;

	const when = DateTime.fromFormat(stamp, 'yyyyMMdd\'T\'HHmmss', zone ? {zone} : {});
	if (when.isValid) {
		return {when, allDay: false};
	}

	// An unknown TZID (Olson names drift, and Exchange invents its own) makes
	// luxon return an invalid DateTime. Reading it as local time is wrong by at
	// most a few hours; dropping the event would instead leave its slot looking
	// free, and that is the error this extension must never make silently.
	if (zone && zone !== 'utc') {
		const local = DateTime.fromFormat(stamp, 'yyyyMMdd\'T\'HHmmss');
		if (local.isValid) {
			console.warn(`Unknown time zone "${zone}" in calendar data; reading ${raw} as local time`);
			return {when: local, allDay: false};
		}
	}

	return undefined;
}

/** ISO 8601 durations, as restricted by RFC 5545 (no months or years). */
function parseDuration(value: string): number | undefined {
	const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
	if (!match) {
		return undefined;
	}

	const [, sign, weeks, days, hours, minutes, seconds] = match;
	const seconds_ = (Number(weeks ?? 0) * (7 * 86_400))
		+ (Number(days ?? 0) * 86_400)
		+ (Number(hours ?? 0) * 3600)
		+ (Number(minutes ?? 0) * 60)
		+ Number(seconds ?? 0);
	return sign === '-' ? -seconds_ * 1000 : seconds_ * 1000;
}

/**
 * How busy the event makes you. TRANSP is the standard answer and STATUS refines
 * it; the Microsoft property is here because Exchange-backed servers set it and
 * leave TRANSP at its default.
 */
function busyStatus(get: (name: string) => IcsProperty | undefined): CalendarStatus {
	const microsoft = get('X-MICROSOFT-CDO-BUSYSTATUS')?.value.trim().toUpperCase();
	if (get('TRANSP')?.value.trim().toUpperCase() === 'TRANSPARENT' || microsoft === 'FREE') {
		return 'yes';
	}

	if (get('STATUS')?.value.trim().toUpperCase() === 'TENTATIVE' || microsoft === 'TENTATIVE') {
		return 'if-need-be';
	}

	return 'no';
}

function toEvent(properties: IcsProperty[], calendarId: string): CalendarEvent | undefined {
	const get = (name: string) => properties.find(property => property.name === name);

	if (get('STATUS')?.value.trim().toUpperCase() === 'CANCELLED') {
		return undefined;
	}

	const dtStart = get('DTSTART');
	const start = dtStart && parseIcsDate(dtStart);
	if (!dtStart || !start) {
		return undefined;
	}

	const dtEnd = get('DTEND');
	const duration = get('DURATION');
	let end = dtEnd ? parseIcsDate(dtEnd)?.when : undefined;
	if (!end) {
		const milliseconds = duration ? parseDuration(duration.value) : undefined;
		end = milliseconds === undefined
			// A DATE-only DTSTART with neither DTEND nor DURATION lasts one day;
			// anything else lasts no time at all. RFC 5545 §3.6.1.
			? (start.allDay ? start.when.plus({days: 1}) : start.when)
			: start.when.plus({milliseconds});
	}

	const uid = get('UID')?.value.trim() ?? '';
	const occurrence = get('RECURRENCE-ID')?.value.trim() ?? dtStart.value.trim();

	return {
		id: `${uid}#${occurrence}`,
		title: unescapeText(get('SUMMARY')?.value ?? '(no title)'),
		calendarId,
		status: busyStatus(get),
		startDate: start.when.toJSDate(),
		endDate: end.toJSDate(),
	};
}

export type IcsParseResult = {
	events: CalendarEvent[];
	/** Events still carrying an RRULE — see {@link parseCalendar}. */
	recurringMasters: number;
};

/**
 * Reads the VEVENTs out of one or more VCALENDAR documents.
 *
 * Sub-components are skipped rather than parsed, which matters for more than
 * tidiness: a VTIMEZONE carries RRULEs of its own, and counting those as
 * unexpanded events would make every server look broken.
 */
export function parseCalendar(ics: string, calendarId: string): IcsParseResult {
	const events: CalendarEvent[] = [];
	let recurringMasters = 0;
	let current: IcsProperty[] | undefined;
	let skipping = 0;

	for (const line of unfold(ics)) {
		const property = parseProperty(line);
		if (!property) {
			continue;
		}

		if (property.name === 'BEGIN') {
			if (skipping > 0) {
				skipping++;
			} else if (current) {
				skipping = 1; // A VALARM, or anything else nested in the event
			} else if (property.value.trim().toUpperCase() === 'VEVENT') {
				current = [];
			}

			continue;
		}

		if (property.name === 'END') {
			if (skipping > 0) {
				skipping--;
			} else if (current && property.value.trim().toUpperCase() === 'VEVENT') {
				if (current.some(entry => entry.name === 'RRULE')) {
					recurringMasters++;
				}

				const event = toEvent(current, calendarId);
				if (event) {
					events.push(event);
				}

				current = undefined;
			}

			continue;
		}

		current?.push(property);
	}

	return {events, recurringMasters};
}

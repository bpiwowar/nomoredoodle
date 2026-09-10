import {type CalendarEvent, type TimeRange} from '../events.js';

/**
 * Where calendars come from. Today only the macOS EventKit bridge; the shape
 * exists so that a CalDAV account or a Thunderbird profile is a new entry here
 * rather than a second code path through the background worker.
 */
export type SourceType = 'native' | 'caldav';

export const nativeSourceId = 'native';

/**
 * Calendar identifiers are only unique within their own source, so everything
 * outside a source speaks the namespaced form. A source id must therefore not
 * contain ":" — a CalDAV account is `caldav-<uuid>`, never `caldav:<uuid>` —
 * because the *first* colon is what separates the two halves. Native ids are
 * free to contain colons, and CalDAV hrefs do.
 */
export function calendarId(sourceId: string, nativeId: string): string {
	return `${sourceId}:${nativeId}`;
}

export function sourceOf(id: string): string {
	const separator = id.indexOf(':');
	return separator === -1 ? '' : id.slice(0, separator);
}

export function nativeIdOf(id: string): string {
	return id.slice(id.indexOf(':') + 1);
}

export type Calendar = {
	/** Namespaced — see {@link calendarId}. This is what the selection is keyed by. */
	id: string;
	title: string;
	/** What the backing store itself understands. */
	nativeId: string;
};

/** A source may expose several: EventKit reports one per account (iCloud, Local…). */
export type CalendarGroup = {
	id: string;
	label: string;
	calendars: Calendar[];
};

/** A message plus, when there is one, the steps that fix it. */
export type SourceError = {message: string; hint?: string};

/** What one source contributed to a listing — including having failed. */
export type SourceListing = {
	sourceId: string;
	type: SourceType;
	label: string;
	enabled: boolean;
	groups: CalendarGroup[];
	error?: SourceError;
};

export type CalendarSource = {
	/** Stable across restarts: it is stored in every calendar id. Must not contain ":". */
	id: string;
	type: SourceType;
	label: string;
	listGroups(): Promise<CalendarGroup[]>;
	/** `nativeIds` are un-namespaced: the caller has already stripped the prefix. */
	getEvents(range: TimeRange, nativeIds: string[]): Promise<CalendarEvent[]>;
};
